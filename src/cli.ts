/**
 * The pipeline, and the command line over it.
 *
 * The three operations here — ingest, screen, explain — are exported rather than
 * inlined into `main`, because `mcp.ts` serves exactly the same operations over
 * stdio. There is one implementation of the pipeline and two front ends onto it.
 *
 * Note what this file does *not* contain: any rule about which companies are good.
 * It fetches, computes, asks jev, and arranges the answers. Every decision along the
 * way is read off a jev response.
 */

import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { cacheKeyFor, throughCache } from "./cache.ts";
import { createClient } from "./client.ts";
import {
  DEFAULT_SCREEN_LIMIT, FILING_FETCH_POOL_SIZE, INGEST_BATCH_SIZE, JEV_POOL_SIZE,
  PRICE_SOURCE_FAILURE_LIMIT, QUESTION_SET_VERSION,
} from "./constants.ts";
import {
  COMPANY_FACTS_ZIP, SUBMISSIONS_ZIP, cacheName, createEdgarClient, factsToObservations,
  cikFromEntryName, fetchFilingText, fetchTickerMap, iterateZipJson, submissionsToProfile,
  type CompanyFacts, type EdgarClient, type Submissions,
} from "./edgar.ts";
import { computeMetrics, type DerivedMetric, type MetricRow } from "./metrics.ts";
import {
  cik as toCik, isoDate, todayISO, PRICE_METRIC,
  type CIK, type ISODate, type Observation, type Ticker,
} from "./observation.ts";
import { buildPeerTables, overlayDistributions, peerContextFor, type PeerTables } from "./peers.ts";
import { createPriceClient, type PriceClient } from "./prices.ts";
import { runPool } from "./pool.ts";
import {
  askJudgment, askTriage, assemble, assertRunnable,
  type FilingExcerpt, type Judged, type JudgmentResult, type Pick, type RunStamp, type TriageResult,
} from "./screen.ts";
import { openStore, type Store } from "./store.ts";
import { buildUniverse, latestFiling, type FilerProfile } from "./universe.ts";

/** Metrics that exist only once a price has been fetched. */
const PRICE_METRICS: readonly DerivedMetric[] = ["priceToEarnings", "evToEbit"];

// ── Ingest ────────────────────────────────────────────────────────────────────

export interface IngestOptions {
  readonly store: Store;
  readonly edgar?: EdgarClient;
  readonly prices?: PriceClient;
  /** Also refresh prices for the whole eligible universe. Slow; opt-in. */
  readonly pricesAll?: boolean;
  readonly log?: (message: string) => void;
}

export interface IngestReport {
  readonly filers: number;
  readonly observations: number;
  readonly priceObservations: number;
  readonly skipped: number;
}

/**
 * Backfill from the two bulk archives.
 *
 * Two HTTP requests cover the entire universe. Doing this company by company would
 * be ~10,000 requests against a 10/second limit — about twenty minutes of nothing
 * but waiting, repeated on every run.
 */
export async function runIngest(options: IngestOptions): Promise<IngestReport> {
  const log = options.log ?? (() => {});
  const edgar = options.edgar ?? createEdgarClient({ log });

  log("fetching ticker map…");
  const tickerMap = await fetchTickerMap(edgar);
  log(`  ${tickerMap.size} tickers`);

  log("downloading submissions.zip (bulk)…");
  const submissionsPath = await edgar.download(SUBMISSIONS_ZIP, cacheName(SUBMISSIONS_ZIP));
  await options.store.recordFetch("edgar", "submissions", true, submissionsPath);

  // Only filers with a ticker can be screened, and we already know which those are.
  const wantedCiks = new Set(tickerMap.keys());
  const isWanted = (name: string): boolean => {
    const cik = cikFromEntryName(name);
    return cik !== undefined && wantedCiks.has(cik);
  };

  const profiles: FilerProfile[] = [];
  for await (const { data } of iterateZipJson<Submissions>(submissionsPath, isWanted)) {
    const key = toCik(data.cik ?? 0);
    const profile = submissionsToProfile(data, tickerMap.get(key));
    if (profile) profiles.push(profile);
  }
  await options.store.saveFilers(profiles);
  log(`  ${profiles.length} filers with a ticker`);

  const byCik = new Map<CIK, FilerProfile>(profiles.map((p) => [p.cik, p]));

  log("downloading companyfacts.zip (bulk)…");
  const factsPath = await edgar.download(COMPANY_FACTS_ZIP, cacheName(COMPANY_FACTS_ZIP));
  await options.store.recordFetch("edgar", "companyfacts", true, factsPath);

  let observations = 0;
  let skipped = 0;
  let batch: Observation[] = [];

  for await (const { data } of iterateZipJson<CompanyFacts>(factsPath, isWanted)) {
    const profile = byCik.get(toCik(data.cik ?? 0));
    if (!profile) {
      skipped++; // no ticker: not something we can screen
      continue;
    }
    batch.push(...factsToObservations(data, profile.entity));
    if (batch.length >= INGEST_BATCH_SIZE) {
      observations += await options.store.appendObservations(batch);
      batch = [];
      log(`  ${observations} observations…`);
    }
  }
  if (batch.length > 0) observations += await options.store.appendObservations(batch);
  log(`  ${observations} observations from ${profiles.length - skipped} companies`);

  let priceObservations = 0;
  if (options.pricesAll) {
    const prices = options.prices ?? createPriceClient();
    const asOf = todayISO();
    const slice = await options.store.sliceAsOf(asOf);
    const universe = buildUniverse(profiles, slice, asOf);
    log(`refreshing prices for ${universe.eligible.length} eligible companies…`);
    priceObservations = (await ingestPrices(options.store, prices, universe.eligible.map((v) => v.entity), log)).stored;
  }

  return { filers: profiles.length, observations, priceObservations, skipped };
}

export interface PriceIngestReport {
  readonly stored: number;
  readonly attempted: number;
  readonly failed: number;
  /** True when the run gave up on the source rather than finishing the list. */
  readonly abandoned: boolean;
}

/**
 * Fetch and store daily closes, giving up if the source is clearly down.
 *
 * Sequential by necessity: the 2/second politeness gate, not latency, is the
 * constraint, so concurrency would buy nothing. The circuit breaker is what keeps a
 * dead source from turning that into a 25-minute stall.
 */
export async function ingestPrices(
  store: Store,
  prices: PriceClient,
  tickers: readonly Ticker[],
  log: (message: string) => void,
): Promise<PriceIngestReport> {
  let stored = 0;
  let attempted = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (const ticker of tickers) {
    attempted++;
    try {
      const rows = await prices.closes(ticker);
      stored += await store.appendObservations(rows);
      await store.recordFetch("stooq", "prices", true, ticker);
      consecutiveFailures = 0;
    } catch (error) {
      failed++;
      consecutiveFailures++;
      await store.recordFetch("stooq", "prices", false, `${ticker}: ${(error as Error).message}`);

      if (consecutiveFailures >= PRICE_SOURCE_FAILURE_LIMIT) {
        log(
          `  price source unreachable after ${consecutiveFailures} consecutive failures ` +
            `(${attempted} of ${tickers.length} attempted) — continuing without multiples`,
        );
        return { stored, attempted, failed, abandoned: true };
      }
    }
  }

  return { stored, attempted, failed, abandoned: false };
}

// ── Screen ────────────────────────────────────────────────────────────────────

export interface ScreenOptions {
  readonly store: Store;
  readonly client?: TypeSafeClient;
  readonly edgar?: EdgarClient;
  readonly prices?: PriceClient;
  readonly asOf?: ISODate;
  readonly allowContaminated?: boolean;
  readonly tickers?: readonly Ticker[];
  readonly sector?: string;
  readonly limit?: number;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export interface ScreenReport {
  readonly runId: string;
  readonly stamp: RunStamp;
  readonly questionSetVersion: string;
  readonly considered: number;
  readonly eligible: number;
  readonly triaged: number;
  readonly advanced: number;
  readonly judged: number;
  readonly picks: readonly Pick[];
  readonly cache: { readonly hits: number; readonly misses: number; readonly writes: number };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly failures: readonly string[];
}

/**
 * The full pipeline: eligibility, metrics, peers, triage, judgment, assembly.
 *
 * `tickers` and `sector` narrow *which companies are judged*. They never narrow the
 * peer distributions, which are always computed over the whole eligible universe —
 * otherwise a one-ticker screen would compare a company against itself.
 */
export async function runScreen(options: ScreenOptions): Promise<ScreenReport> {
  const log = options.log ?? (() => {});
  const asOf = options.asOf ?? todayISO();
  const stamp = assertRunnable(asOf, options.allowContaminated ?? false);
  if (stamp.notice) log(stamp.notice);

  const store = options.store;

  const profiles = await store.loadFilers();
  if (profiles.length === 0) throw new Error("no filers in the store — run `npm run ingest` first");

  // Constructed on first cache miss, not up front. A fully cached run — the steady
  // state, and what `screen_run` serves over MCP — then needs no API key at all.
  let lazyClient = options.client;
  const jev = (): TypeSafeClient => (lazyClient ??= createClient());

  log(`slicing observations as of ${asOf}…`);
  const slice = await store.sliceAsOf(asOf);
  const universe = buildUniverse(profiles, slice, asOf);
  log(`  ${universe.eligible.length} eligible of ${universe.considered} filers`);

  const sectorOf = new Map(profiles.map((p) => [p.entity, p.sector]));
  const profileOf = new Map(profiles.map((p) => [p.entity, p]));

  // Peer context over the ENTIRE eligible universe — the yardstick every call shares.
  const allRows = universe.eligible.map((v) => computeMetrics(slice, v.entity, sectorOf.get(v.entity) ?? "unknown"));
  const peerTables = buildPeerTables(allRows, asOf);

  // Narrowing applies to what we judge, never to the yardstick.
  const wanted = options.tickers?.length ? new Set(options.tickers) : undefined;
  const candidates = allRows.filter(
    (row) => (!wanted || wanted.has(row.entity)) && (!options.sector || row.sector === options.sector),
  );
  log(`triaging ${candidates.length} companies…`);

  let inputTokens = 0;
  let outputTokens = 0;
  const failures: string[] = [];

  // ── Stage 1: triage, no filing text ──
  const triage = await runPool(
    candidates,
    async (row) => {
      const key = cacheKeyFor(row, QUESTION_SET_VERSION, "triage");
      const peer = peerContextFor(peerTables, row.sector);
      const result = await throughCache<TriageResult>(store.cache, key, async () => {
        const fresh = await askTriage(jev(), row, peer, options.signal ? { signal: options.signal } : {});
        return { value: fresh, model: fresh.model, inputTokens: fresh.usage.input_tokens, outputTokens: fresh.usage.output_tokens };
      });
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      return { row, result: result.value, fromCache: result.fromCache };
    },
    { size: JEV_POOL_SIZE, ...(options.signal ? { signal: options.signal } : {}) },
  );
  for (const failure of triage.failures) {
    failures.push(`triage ${candidates[failure.index]?.entity}: ${(failure.error as Error).message}`);
  }

  const advanced = triage.results.filter((r) => r !== undefined && r.result.answers.advance.choice === "advance");
  log(`  ${advanced.length} advanced to judgment`);

  // ── Stage 2: judgment ──
  //
  // The cache is consulted BEFORE any fetching. Judgment cache keys are built from
  // filing vintage alone (see `vintageOf`), so they can be computed without prices —
  // which means a fully cached run touches neither Stooq nor EDGAR, and needs no API
  // key. That is what makes `screen_run` cheap enough to call from a conversation.
  const survivorRows = advanced.map((a) => a!.row);
  const judgmentKeys = survivorRows.map((row) => cacheKeyFor(row, QUESTION_SET_VERSION, "judgment"));

  const cached: (JudgmentResult | undefined)[] = [];
  for (const key of judgmentKeys) {
    cached.push((await store.cache.get<JudgmentResult>(key))?.value);
  }
  const stale = survivorRows.map((_, i) => i).filter((i) => cached[i] === undefined);

  let pricedRows = survivorRows;
  let judgmentPeers: PeerTables = peerTables;
  const filings = new Map<Ticker, FilingExcerpt>();

  if (stale.length > 0) {
    // Prices are fetched for EVERY survivor, not just the stale ones. The multiples
    // distribution has to be the same yardstick for all of them; computing it over
    // whichever companies happened to miss cache would make a score depend on its
    // batch, which is the one thing the peer context exists to prevent.
    const survivors = survivorRows.map((row) => row.entity);
    log(`fetching prices for ${survivors.length} survivors…`);
    const priceReport = await ingestPrices(store, options.prices ?? createPriceClient(), survivors, log);
    if (priceReport.abandoned) {
      failures.push(
        `price source gave up after ${priceReport.failed} failures; ` +
          `${survivors.length - priceReport.attempted} tickers unattempted, valuation multiples absent`,
      );
    }

    const pricedSlice = await store.sliceAsOf(asOf, { entities: survivors });
    pricedRows = survivorRows.map((row) => computeMetrics(pricedSlice, row.entity, row.sector));
    judgmentPeers = overlayDistributions(peerTables, pricedRows, PRICE_METRICS);

    // Filing text, on the other hand, is only worth fetching for what we will ask
    // about: ~15,000 tokens of MD&A that a cache hit would never read.
    log(`fetching filing text for ${stale.length} companies…`);
    const edgar = options.edgar ?? createEdgarClient({ log });

    // Pooled, not sequential: the adapter's rate gate already spaces request starts,
    // so serialising here would only add each document's download time to the total.
    // At several megabytes a filing, that is the difference between minutes and hours.
    await runPool(
      stale,
      async (index) => {
        const row = pricedRows[index]!;
        const profile = profileOf.get(row.entity);
        const filing = profile ? latestFiling(profile, ["10-K", "10-K/A", "10-Q"], asOf) : undefined;
        if (!profile || !filing) return;
        try {
          filings.set(row.entity, await fetchFilingText(edgar, profile.cik, filing));
          await store.recordFetch("edgar", "filing-text", true, `${row.entity} ${filing.accession}`);
        } catch (error) {
          await store.recordFetch("edgar", "filing-text", false, `${row.entity}: ${(error as Error).message}`);
          failures.push(`filing text ${row.entity}: ${(error as Error).message}`);
        }
      },
      {
        size: FILING_FETCH_POOL_SIZE,
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: ({ done, total }) => {
          if (done % 100 === 0 || done === total) log(`  filings ${done}/${total}`);
        },
      },
    );
  }

  log(`judging ${survivorRows.length} companies (${stale.length} fresh, ${survivorRows.length - stale.length} cached)…`);
  const asked = await runPool(
    stale,
    async (index) => {
      const row = pricedRows[index]!;
      const peer = peerContextFor(judgmentPeers, row.sector);
      const result = await askJudgment(
        jev(), row, peer, filings.get(row.entity),
        options.signal ? { signal: options.signal } : {},
      );

      inputTokens += result.usage.input_tokens;
      outputTokens += result.usage.output_tokens;
      await store.cache.put({
        key: judgmentKeys[index]!, value: result, model: result.model,
        inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
        createdAt: new Date().toISOString(),
      });
      return { index, result };
    },
    { size: JEV_POOL_SIZE, ...(options.signal ? { signal: options.signal } : {}) },
  );
  for (const failure of asked.failures) {
    failures.push(`judgment ${survivorRows[stale[failure.index]!]?.entity}: ${(failure.error as Error).message}`);
  }
  for (const fresh of asked.results) {
    if (fresh) cached[fresh.index] = fresh.result;
  }

  const judged: Judged[] = [];
  for (const [index, row] of pricedRows.entries()) {
    const result = cached[index];
    if (!result) continue; // the call failed; already recorded in `failures`

    const metrics: Partial<Record<DerivedMetric, number>> = {};
    for (const [metric, value] of Object.entries(row.metrics)) {
      if (value) metrics[metric as DerivedMetric] = value.value;
    }
    judged.push({
      entity: row.entity, sector: row.sector, result,
      fromCache: !stale.includes(index), metrics,
    });
  }
  const picks = assemble(judged);

  const report: ScreenReport = {
    runId: randomUUID(),
    stamp,
    questionSetVersion: QUESTION_SET_VERSION,
    considered: universe.considered,
    eligible: universe.eligible.length,
    triaged: candidates.length,
    advanced: advanced.length,
    judged: judged.length,
    picks: options.limit === undefined ? picks : picks.slice(0, options.limit),
    cache: store.cache.stats(),
    usage: { inputTokens, outputTokens },
    failures,
  };

  // Forward-only grading is the only honest scorecard this system can have, and it
  // cannot be backfilled — so every run is persisted, in full, as it happened.
  await store.saveRun({
    runId: report.runId,
    asOf,
    questionSetVersion: QUESTION_SET_VERSION,
    contaminated: stamp.contaminated,
    payload: { ...report, picks, universeReasons: universe.reasonCounts },
  });

  return report;
}

// ── Explain ───────────────────────────────────────────────────────────────────

export interface ExplainReport {
  readonly entity: Ticker;
  readonly asOf: ISODate;
  readonly sector: string;
  readonly eligible: boolean;
  readonly missing: readonly string[];
  readonly observations: readonly {
    readonly metric: string;
    readonly value: number;
    readonly validAt: ISODate;
    readonly knownAt: ISODate;
    readonly source: string;
    readonly reliability: string;
    readonly tag?: string;
  }[];
  readonly metrics: Readonly<Partial<Record<DerivedMetric, { value: number; knownAt: ISODate; from: string }>>>;
  readonly judgments: readonly {
    readonly stage: string;
    readonly fromCache: boolean;
    readonly answers: unknown;
    readonly model?: string;
  }[];
}

/** Everything behind one company's result, including where each number came from. */
export async function explainPick(options: {
  store: Store;
  entity: Ticker;
  asOf?: ISODate;
}): Promise<ExplainReport> {
  const asOf = options.asOf ?? todayISO();
  const profiles = await options.store.loadFilers();
  const profile = profiles.find((p) => p.entity === options.entity);
  const slice = await options.store.sliceAsOf(asOf, { entities: [options.entity] });

  const sector = profile?.sector ?? "unknown";
  const row = computeMetrics(slice, options.entity, sector);
  const eligibility = profile
    ? buildUniverse([profile], slice, asOf)
    : { eligible: [], ineligible: [{ entity: options.entity, eligible: false, missing: ["filer not in store"] }] };

  const metrics: Partial<Record<DerivedMetric, { value: number; knownAt: ISODate; from: string }>> = {};
  for (const [metric, observation] of Object.entries(row.metrics)) {
    if (observation) {
      metrics[metric as DerivedMetric] = { value: observation.value, knownAt: observation.knownAt, from: observation.source };
    }
  }

  const judgments: { stage: string; fromCache: boolean; answers: unknown; model?: string }[] = [];
  for (const stage of ["triage", "judgment"] as const) {
    const key = cacheKeyFor(row, QUESTION_SET_VERSION, stage);
    const hit = await options.store.cache.get(key);
    if (hit) judgments.push({ stage, fromCache: true, answers: hit.value, model: hit.model });
  }

  const verdict = eligibility.eligible[0] ?? eligibility.ineligible[0];
  return {
    entity: options.entity,
    asOf,
    sector,
    eligible: verdict?.eligible ?? false,
    missing: verdict?.missing ?? [],
    observations: row.inputs
      .map((o) => ({
        metric: o.metric, value: o.value, validAt: o.validAt, knownAt: o.knownAt,
        source: o.source, reliability: o.reliability, ...(o.tag ? { tag: o.tag } : {}),
      }))
      .sort((a, b) => a.metric.localeCompare(b.metric) || a.validAt.localeCompare(b.validAt)),
    metrics,
    judgments,
  };
}

// ── Coverage ──────────────────────────────────────────────────────────────────

export interface CoverageReport {
  readonly asOf: ISODate;
  readonly filers: number;
  readonly observations: number;
  readonly eligible: number;
  readonly ineligible: number;
  readonly topReasons: readonly { readonly reason: string; readonly count: number }[];
  readonly sources: readonly unknown[];
  readonly runs: number;
  readonly lastRun?: { readonly runId: string; readonly asOf: ISODate; readonly contaminated: boolean };
  readonly cache: { readonly hits: number; readonly misses: number; readonly writes: number };
  readonly questionSetVersion: string;
}

export async function coverageStatus(store: Store, asOf: ISODate = todayISO()): Promise<CoverageReport> {
  const profiles = await store.loadFilers();
  const slice = await store.sliceAsOf(asOf);
  const universe = buildUniverse(profiles, slice, asOf);
  const last = await store.latestRun();

  return {
    asOf,
    filers: profiles.length,
    observations: await store.observationCount(),
    eligible: universe.eligible.length,
    ineligible: universe.ineligible.length,
    topReasons: universe.reasonCounts.slice(0, 8),
    sources: await store.fetchStatus(),
    runs: await store.runCount(),
    ...(last ? { lastRun: { runId: last.runId, asOf: last.asOf, contaminated: last.contaminated } } : {}),
    cache: store.cache.stats(),
    questionSetVersion: QUESTION_SET_VERSION,
  };
}

// ── Command line ──────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1]) flags.set(match[1], match[2] ?? "true");
  }
  return flags;
}

const HELP = `
jev stock screener

  npm run ingest  [-- --prices-all]
      Backfill from the SEC bulk archives. --prices-all also refreshes Stooq
      prices for the whole eligible universe (slow).

  npm run screen  [-- --as-of=YYYY-MM-DD] [--ticker=AAPL,MSFT] [--sector=retail]
                     [--limit=N] [--allow-contaminated]
      Run the pipeline and print jev's ranked picks. Default limit ${DEFAULT_SCREEN_LIMIT}.

  npm run screen -- explain --ticker=AAPL [--as-of=YYYY-MM-DD]
      Show every observation, tag and jev answer behind one company.

  npm run screen -- coverage
      Universe size, eligibility counts, source freshness, cache hit rate.
`;

async function main(): Promise<void> {
  const [, , command = "screen", ...rest] = process.argv;
  const flags = parseArgs(rest);
  const subcommand = rest.find((a) => !a.startsWith("--"));

  if (flags.has("help") || command === "help") {
    console.log(HELP);
    return;
  }

  const store = await openStore();
  const log = (message: string): void => console.error(message);

  try {
    if (command === "ingest") {
      const report = await runIngest({ store, pricesAll: flags.has("prices-all"), log });
      console.log(`\ningested ${report.observations} observations for ${report.filers} filers` +
        (report.priceObservations ? `, ${report.priceObservations} price points` : "") +
        `\n${report.skipped} companyfacts entries skipped (no ticker)\n`);
      return;
    }

    if (subcommand === "coverage") {
      console.log(JSON.stringify(await coverageStatus(store), null, 2));
      return;
    }

    const asOfFlag = flags.get("as-of");
    const asOf = asOfFlag ? isoDate(asOfFlag) : todayISO();

    if (subcommand === "explain") {
      const raw = flags.get("ticker");
      if (!raw) throw new Error("explain needs --ticker=SYMBOL");
      console.log(JSON.stringify(await explainPick({ store, entity: raw.toUpperCase() as Ticker, asOf }), null, 2));
      return;
    }

    const tickers = flags.get("ticker")?.split(",").map((t) => t.trim().toUpperCase() as Ticker);
    const report = await runScreen({
      store, asOf, log,
      allowContaminated: flags.has("allow-contaminated"),
      limit: Number(flags.get("limit") ?? DEFAULT_SCREEN_LIMIT),
      ...(tickers?.length ? { tickers } : {}),
      ...(flags.get("sector") ? { sector: flags.get("sector")! } : {}),
    });

    printScreen(report);
  } finally {
    await store.close();
  }
}

function printScreen(report: ScreenReport): void {
  if (report.stamp.notice) console.log(`\n${report.stamp.notice}`);

  console.log(`\njev picks as of ${report.stamp.asOf} — question set ${report.questionSetVersion}\n`);
  if (report.picks.length === 0) {
    console.log("  jev included nothing in this run.\n");
  }

  for (const [index, pick] of report.picks.entries()) {
    const { attractiveness, verdict, answers } = pick;
    console.log(
      `  ${String(index + 1).padStart(3)}. ${pick.entity.padEnd(6)} ${attractiveness.score.toFixed(2)}  ` +
        `${pick.sector}${pick.fromCache ? "  (cached)" : ""}`,
    );
    console.log(
      `       verdict ${verdict.choice} ${(verdict.confidence * 100).toFixed(0)}%  ·  ` +
        `durability ${answers.durability.score.toFixed(2)}  ·  accounting ${answers.accountingQuality.choice}  ·  ` +
        `risk ${answers.dominantRisk.choice}  ·  candor ${answers.managementCandor.choice}  ·  ` +
        `evidence ${answers.sufficiency.choice}`,
    );
  }

  console.log(
    `\n  ${report.eligible} eligible of ${report.considered} filers · ${report.triaged} triaged · ` +
      `${report.advanced} advanced · ${report.judged} judged`,
  );
  console.log(
    `  cache ${report.cache.hits} hits / ${report.cache.misses} misses · ` +
      `${report.usage.inputTokens} in / ${report.usage.outputTokens} out tokens · run ${report.runId}`,
  );
  if (report.failures.length > 0) {
    console.log(`  ${report.failures.length} failures:`);
    for (const failure of report.failures.slice(0, 10)) console.log(`    ${failure}`);
  }
  console.log("\n  Candidates for human review. Not a recommendation to buy or sell anything.\n");
}

// Only run when invoked directly, so `mcp.ts` can import the pipeline.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error(`\n${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
