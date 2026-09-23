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
  PRICE_SOURCE_FAILURE_LIMIT, QUESTION_SET_VERSION, PRICE_BACKFILL_DAYS, FILING_EXCERPT_CHARS, BENCHMARK_SYMBOL, BENCHMARK_ENTITY,
} from "./constants.ts";
import {
  COMPANY_FACTS_ZIP, SUBMISSIONS_ZIP, cacheName, createEdgarClient, factsToObservations,
  TAG_CHAINS, cikFromEntryName, fetchFilingText, fetchTickerMap, iterateZipJson, submissionsToProfile, zipEntryCiks,
  type CompanyFacts, type EdgarClient, type Submissions,
} from "./edgar.ts";
import { computeMetrics, type DerivedMetric, type MetricRow } from "./metrics.ts";
import {
  cik as toCik, isoDate, todayISO, PRICE_METRIC,
  type CIK, type Entity, type ISODate, type Observation, type Ticker,
} from "./observation.ts";
import { buildPeerTables, overlayDistributions, peerContextFor, type PeerTables } from "./peers.ts";
import { closesToObservations, createPriceClient, hasPolygonKey, recentDays, type PriceClient } from "./prices.ts";
import { runPool } from "./pool.ts";
import {
  askJudgment, assemble, assertRunnable,
  type FilingExcerpt, type Judged, type JudgmentResult, type Pick, type RunStamp,
} from "./screen.ts";
import { openStore, type Store } from "./store.ts";
import { gradeRun, type GradeReport, type RosterEntry } from "./grade.ts";
import {
  askProbe, buildSlate, redact, summariseProbe,
  type ProbeOutcome, type ProbeReport,
} from "./probe.ts";
import {
  perturb, perturbedCount, summariseTwins, type TwinOutcome, type TwinsReport,
} from "./twins.ts";
import { buildUniverse, displayLabel, latestFiling, resolveTickers, type FilerProfile } from "./universe.ts";

/** Metrics that exist only once a price has been fetched. */
/**
 * Metrics that only exist once closes are on file, so their peer distributions have
 * to be overlaid after the price stage rather than computed with the rest.
 */
const PRICE_METRICS: readonly DerivedMetric[] = [
  "priceToEarnings", "evToEbit",
  "momentum12m1", "momentum6m", "momentum3m",
  "priceToMovingAverage200", "drawdownFrom52wHigh", "volatility90d",
];

// ── Ingest ────────────────────────────────────────────────────────────────────

export interface IngestOptions {
  readonly store: Store;
  readonly edgar?: EdgarClient;
  readonly prices?: PriceClient;
  /** Also refresh prices for the whole eligible universe. Slow; opt-in. */
  readonly pricesAll?: boolean;
  /** Refresh closes without touching the bulk archives. */
  readonly pricesOnly?: boolean;
  /** Refetch days already on file, for when the ticker map has changed. */
  readonly reprice?: boolean;
  /** Weekdays of closes to pull. Defaults to the daily refresh window. */
  readonly days?: number;
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
/**
 * Pull recent closes. Prices are keyed by day, not by company, so this needs the
 * filer table only to know which symbols belong to whom — never the archives.
 */
export async function refreshPrices(
  store: Store,
  prices: PriceClient,
  profiles: readonly FilerProfile[],
  log: (message: string) => void,
  options: { readonly reprice?: boolean; readonly days?: number } = {},
): Promise<number> {
  // A deep backfill is a different job from a daily refresh: ~500 requests at five a
  // minute, about a hundred minutes, run once. Momentum needs two years of closes and
  // the daily cadence would take two years to accumulate them.
  const days = recentDays(todayISO(), options.days ?? PRICE_BACKFILL_DAYS);
  log(`refreshing ${days.length} days of closes…`);
  const stored = (await ingestPrices(store, prices, days, entityIndex(profiles), log, options)).stored;
  if (options.reprice) {
    const removed = await store.compact();
    if (removed > 0) log(`  compacted ${removed} rows already on file`);
  }
  return stored;
}

export async function runIngest(options: IngestOptions): Promise<IngestReport> {
  // Prices alone: re-reading 2.8 GB of archives to fetch five days of closes would be
  // absurd, and it is what duplicated the observation table the first time.
  if (options.pricesOnly) {
    const log = options.log ?? (() => {});
    const profiles = await options.store.loadFilers();
    const priceObservations = await refreshPrices(
      options.store, options.prices ?? createPriceClient(), profiles, log,
      {
        ...(options.reprice ? { reprice: true } : {}),
        ...(options.days ? { days: options.days } : {}),
      });
    log(priceObservations > 0
      ? `  ${priceObservations} new price points`
      : "  no new price points — every day requested was already on file");
    return { filers: profiles.length, observations: 0, priceObservations, skipped: 0 };
  }

  const log = options.log ?? (() => {});
  const edgar = options.edgar ?? createEdgarClient({ log });

  log("fetching ticker map…");
  const tickerMap = await fetchTickerMap(edgar);
  log(`  ${tickerMap.size} filers carry a ticker`);

  log("downloading companyfacts.zip (bulk)…");
  const factsPath = await edgar.download(COMPANY_FACTS_ZIP, cacheName(COMPANY_FACTS_ZIP));
  await options.store.recordFetch("edgar", "companyfacts", true, factsPath);

  // The universe is every filer with XBRL data, read from the archive's own
  // directory. It is deliberately NOT derived from the ticker file: that file omits
  // filers outright — Exxon Mobil Corp, CIK 34088, is not in it — and points some
  // familiar symbols at the wrong company. Tickers are labels we attach afterwards.
  const universe = await zipEntryCiks(factsPath);
  log(`  ${universe.size} filers with XBRL data`);

  const isWanted = (name: string): boolean => {
    const entryCik = cikFromEntryName(name);
    return entryCik !== undefined && universe.has(entryCik);
  };

  log("downloading submissions.zip (bulk)…");
  const submissionsPath = await edgar.download(SUBMISSIONS_ZIP, cacheName(SUBMISSIONS_ZIP));
  await options.store.recordFetch("edgar", "submissions", true, submissionsPath);

  const safeCik = (raw: unknown): CIK | undefined => {
    try {
      return toCik(String(raw ?? ""));
    } catch {
      return undefined;
    }
  };

  const profiles: FilerProfile[] = [];
  for await (const { data } of iterateZipJson<Submissions>(submissionsPath, isWanted)) {
    const key = safeCik(data.cik);
    const profile = submissionsToProfile(data, key ? tickerMap.get(key) ?? [] : []);
    if (profile) profiles.push(profile);
  }
  await options.store.saveFilers(profiles);
  const withTicker = profiles.filter((profile) => profile.tickers.length > 0).length;
  log(`  ${profiles.length} filers (${withTicker} with a ticker)`);

  const byCik = new Map<CIK, FilerProfile>(profiles.map((p) => [p.cik, p]));

  let observations = 0;
  let skipped = 0;
  let batch: Observation[] = [];

  for await (const { data } of iterateZipJson<CompanyFacts>(factsPath, isWanted)) {
    const profile = byCik.get(toCik(data.cik ?? 0));
    if (!profile) {
      skipped++; // XBRL data but no submissions record: nothing to describe it
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

  // Re-reading an archive produces byte-identical observations. Keeping both copies
  // carries no information and doubles every slice, so fold them back together.
  const removed = await options.store.compact();
  if (removed > 0) log(`  compacted ${removed} rows already on file`);

  const priceObservations = options.pricesAll
    ? await refreshPrices(options.store, options.prices ?? createPriceClient(), profiles, log)
    : 0;

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
/** Ticker → the filer it belongs to, for the symbols we actually track. */
export function entityIndex(profiles: readonly FilerProfile[]): Map<Ticker, Entity> {
  const index = new Map<Ticker, Entity>();
  for (const profile of profiles) {
    // Only the primary symbol. A filer can list dozens of securities — share classes,
    // preferreds, warrants — and mapping all of them here put every one of their
    // closes on the same CIK: one filer had 45 closes a day spanning $2.62 to
    // $172.60, which made its price, and so its P/E, arbitrary. The common share is
    // the reference price. Every other symbol still *resolves* to this filer through
    // resolveTickers; it just does not get to claim to be its price.
    const primary = profile.tickers[0];
    if (!primary) continue;
    // First writer wins, so a symbol two filers claim resolves the same way here as
    // it does in resolveTickers rather than depending on iteration order.
    if (!index.has(primary)) index.set(primary, profile.entity);
  }
  // The benchmark rides along on the same day files. A cohort that rose 9% is not a
  // result if the market rose 10%, and without this there is nothing to say so.
  index.set(BENCHMARK_SYMBOL as Ticker, BENCHMARK_ENTITY as Entity);
  return index;
}

/**
 * Pull daily closes, one request per trading day.
 *
 * A day is the unit, not a company: the source returns every US ticker at once, so
 * fetching the whole universe costs the same as fetching one name. An empty response
 * is a weekend or a holiday, which is not a failure — only a throw is, and a streak
 * of those trips the breaker so an unreachable source costs seconds rather than hours.
 */
export async function ingestPrices(
  store: Store,
  prices: PriceClient,
  days: readonly ISODate[],
  entityFor: ReadonlyMap<Ticker, Entity>,
  log: (message: string) => void,
  options: { readonly reprice?: boolean } = {},
): Promise<PriceIngestReport> {
  let stored = 0;
  let attempted = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  // Days already on file are skipped outright. Their closes cannot change, and every
  // screen run calls this — without the check the same facts were appended once per
  // run, which had put eight copies of each close in the table.
  //
  // The skip is per day, not per company, so a symbol added to the map after a day
  // was stored never gets that day's close. `reprice` is the way out: it refetches
  // from the day cache, and compaction folds the rows that were already there.
  const already = options.reprice ? new Set<ISODate>() : await store.observedPeriods(PRICE_METRIC);

  for (const day of days) {
    if (already.has(day)) continue;
    attempted++;
    try {
      const closes = await prices.dailyCloses(day);
      consecutiveFailures = 0;
      if (closes.size === 0) continue; // not a trading day

      const rows = closesToObservations(day, closes, entityFor);
      stored += await store.appendObservations(rows);
      await store.recordFetch("polygon", "prices", true, `${day}: ${rows.length} of ${closes.size} tickers matched`);
    } catch (error) {
      failed++;
      consecutiveFailures++;
      await store.recordFetch("polygon", "prices", false, `${day}: ${(error as Error).message}`);

      if (consecutiveFailures >= PRICE_SOURCE_FAILURE_LIMIT) {
        log(
          `  price source unreachable after ${consecutiveFailures} consecutive failures ` +
            `(${attempted} of ${days.length} days attempted) — continuing without multiples`,
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
  readonly judged: number;
  readonly picks: readonly Pick[];
  readonly cache: { readonly hits: number; readonly misses: number; readonly writes: number };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly failures: readonly string[];
}

/**
 * The full pipeline: eligibility, metrics, peers, judgment, assembly.
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
  const labelOf = (entity: Entity): string => {
    const profile = profileOf.get(entity);
    return profile ? displayLabel(profile) : `CIK${entity}`;
  };

  // Peer context over the ENTIRE eligible universe — the yardstick every call shares.
  const allRows = universe.eligible.map((v) => computeMetrics(slice, v.entity, sectorOf.get(v.entity) ?? "unknown", labelOf(v.entity)));
  const peerTables = buildPeerTables(allRows, asOf);

  // Narrowing applies to what we judge, never to the yardstick.
  const resolution = options.tickers?.length ? resolveTickers(profiles, options.tickers) : undefined;
  for (const symbol of resolution?.unknown ?? []) log(`  no filer in the universe carries ${symbol}`);
  for (const clash of resolution?.ambiguous ?? []) {
    log(`  ${clash.ticker} is claimed by ${clash.entities.length} filers — judging all of them`);
  }
  const wanted = resolution ? new Set<Entity>(resolution.entities) : undefined;
  const candidates = allRows.filter(
    (row) => (!wanted || wanted.has(row.entity)) && (!options.sector || row.sector === options.sector),
  );
  let inputTokens = 0;
  let outputTokens = 0;
  const failures: string[] = [];

  log(`screening ${candidates.length} of ${universe.eligible.length} eligible companies…`);

  // ── Prices ──
  //
  // Fetched before the cache is consulted, because whether a multiple exists is part
  // of the key: a verdict formed with no valuation and one formed with it are answers
  // to different evidence, and keying only on filing vintage would serve the first in
  // place of the second forever.
  //
  // This is affordable only because the source is bulk — one request per trading day
  // for the whole market, and each completed day is cached on disk. A second run the
  // same day therefore still touches no network at all.
  const survivorRows = candidates;
  const survivors = survivorRows.map((row) => row.entity);

  log(`fetching closes for ${survivors.length} companies…`);
  // No key configured is a known state, not twenty identical failures. Tests inject a
  // client, so an injected one is always used regardless of the environment.
  const priceReport = options.prices || hasPolygonKey()
    ? await ingestPrices(
        store, options.prices ?? createPriceClient(),
        recentDays(asOf, PRICE_BACKFILL_DAYS), entityIndex(profiles), log)
    : (log("  POLYGON_API_KEY not set — skipping prices, multiples will be absent"),
       { stored: 0, attempted: 0, failed: 0, abandoned: false });
  if (priceReport.abandoned) {
    failures.push(
      `price source gave up after ${priceReport.failed} failures; ` +
        `${priceReport.attempted} days attempted, valuation multiples absent`,
    );
  }

  // Re-slice only if prices actually landed. A slice is held entirely in memory, so
  // building a second one beside the first doubles the peak — on the live universe
  // that is two multi-million-row slices at once, which exhausts the default heap.
  // When nothing was stored the new slice would be identical to the one we hold.
  let pricedRows = survivorRows;
  let judgmentPeers: PeerTables = peerTables;
  if (priceReport.stored > 0) {
    const pricedSlice = await store.sliceAsOf(asOf, { entities: survivors });
    pricedRows = survivorRows.map((row) => computeMetrics(pricedSlice, row.entity, row.sector, row.label));
    judgmentPeers = overlayDistributions(peerTables, pricedRows, PRICE_METRICS);
  } else {
    // `stored: 0` means every day requested was already on file, which is the normal
    // steady state — not an absence of prices. The slice above already carries them,
    // so multiples are present either way. Saying "no closes" here would read as the
    // degraded case and invite exactly the wrong conclusion.
    log("  closes already on file — no refetch needed");
  }

  // ── Judgment ──
  //
  // Keys come from the priced rows, so they describe the evidence actually judged.
  const judgmentKeys = pricedRows.map((row) => cacheKeyFor(row, QUESTION_SET_VERSION, "judgment"));

  const cached: (JudgmentResult | undefined)[] = [];
  for (const key of judgmentKeys) {
    cached.push((await store.cache.get<JudgmentResult>(key))?.value);
  }
  const stale = pricedRows.map((_, i) => i).filter((i) => cached[i] === undefined);
  const filings = new Map<Entity, FilingExcerpt>();

  if (stale.length > 0) {
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
      entity: row.entity, label: row.label, sector: row.sector, result,
      fromCache: !stale.includes(index), metrics,
    });
  }
  const picks = assemble(judged);

  // Every company judged, not only the ones picked. Grading needs what jev passed
  // over — a bucket of picks going up says nothing on its own, because the market
  // goes up. The run is the evidence, so it has to be self-contained: reconstructing
  // this later from a cache that has moved on is not the same thing.
  const roster: RosterEntry[] = judged.map((row) => ({
    entity: String(row.entity),
    label: row.label,
    sector: row.sector,
    verdict: row.result.answers.verdict.choice,
    attractiveness: row.result.answers.attractiveness.score,
    ...(typeof row.metrics.fcfConversion === "number" ? { fcfConversion: row.metrics.fcfConversion } : {}),
    ...(typeof row.metrics.momentum12m1 === "number" ? { momentum12m1: row.metrics.momentum12m1 } : {}),
  }));

  const report: ScreenReport = {
    runId: randomUUID(),
    stamp,
    questionSetVersion: QUESTION_SET_VERSION,
    considered: universe.considered,
    eligible: universe.eligible.length,
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
    payload: { ...report, picks, roster, universeReasons: universe.reasonCounts },
  });

  return report;
}

// ── Explain ───────────────────────────────────────────────────────────────────

export interface ExplainReport {
  /** The symbol asked about. Present even when nothing carries it. */
  readonly ticker: Ticker;
  /** The filer it resolved to, absent when no filer in the universe carries it. */
  readonly entity?: Entity;
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
  ticker: Ticker;
  asOf?: ISODate;
}): Promise<ExplainReport> {
  const asOf = options.asOf ?? todayISO();
  const profiles = await options.store.loadFilers();

  const resolution = resolveTickers(profiles, [options.ticker]);
  const entity = resolution.entities[0];
  if (!entity) {
    return {
      ticker: options.ticker, asOf, sector: "unknown", eligible: false,
      missing: ["filer not in store"], observations: [], metrics: {}, judgments: [],
    };
  }

  const profile = profiles.find((p) => p.entity === entity);
  const slice = await options.store.sliceAsOf(asOf, { entities: [entity] });

  const sector = profile?.sector ?? "unknown";
  const row = computeMetrics(slice, entity, sector, profile ? displayLabel(profile) : options.ticker);
  const eligibility = profile
    ? buildUniverse([profile], slice, asOf)
    : { eligible: [], ineligible: [{ entity, eligible: false, missing: ["filer not in store"] }] };

  const metrics: Partial<Record<DerivedMetric, { value: number; knownAt: ISODate; from: string }>> = {};
  for (const [metric, observation] of Object.entries(row.metrics)) {
    if (observation) {
      metrics[metric as DerivedMetric] = { value: observation.value, knownAt: observation.knownAt, from: observation.source };
    }
  }

  const judgments: { stage: string; fromCache: boolean; answers: unknown; model?: string }[] = [];
  for (const stage of ["judgment"] as const) {
    const key = cacheKeyFor(row, QUESTION_SET_VERSION, stage);
    const hit = await options.store.cache.get(key);
    if (hit) judgments.push({ stage, fromCache: true, answers: hit.value, model: hit.model });
  }

  const verdict = eligibility.eligible[0] ?? eligibility.ineligible[0];
  return {
    ticker: options.ticker,
    entity,
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
  /**
   * Eligible filers carrying the least data, thinnest first, and eligible filers SEC
   * lists no symbol for.
   *
   * This is the report that would have caught XOM. SEC's ticker file points that
   * symbol at a filer with seventeen observations; it failed eligibility on its own,
   * but nothing would have flagged it had it carried a little more history, and a
   * screener that confidently describes the wrong company is worse than one that
   * describes none. Counting observations is a statement about our inputs, never
   * about the business, so it belongs here rather than in a jev question.
   */
  readonly thinnestEligible: readonly {
    readonly entity: string;
    readonly label: string;
    readonly name: string;
    readonly observations: number;
  }[];
  readonly eligibleWithoutTicker: number;
}

/** The concepts we ingest, so "how much data is there" is a fixed, comparable count. */
const REPORTED_CONCEPTS = Object.keys(TAG_CHAINS);

export async function coverageStatus(store: Store, asOf: ISODate = todayISO()): Promise<CoverageReport> {
  const profiles = await store.loadFilers();
  const slice = await store.sliceAsOf(asOf);
  const universe = buildUniverse(profiles, slice, asOf);
  const last = await store.latestRun();

  const profileOf = new Map(profiles.map((profile) => [profile.entity, profile]));
  const eligibleProfiles = universe.eligible.flatMap((verdict) => {
    const profile = profileOf.get(verdict.entity);
    return profile ? [profile] : [];
  });

  const thinnestEligible = eligibleProfiles
    .map((profile) => ({
      entity: String(profile.entity),
      label: displayLabel(profile),
      name: profile.name,
      observations: REPORTED_CONCEPTS.reduce((total, metric) => total + slice.series(profile.entity, metric).length, 0),
    }))
    .sort((a, b) => a.observations - b.observations || a.label.localeCompare(b.label))
    .slice(0, 10);

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
    thinnestEligible,
    eligibleWithoutTicker: eligibleProfiles.filter((profile) => profile.tickers.length === 0).length,
  };
}

/**
 * Expected band as a period a person can read.
 *
 * The expected value lands between rubric levels — 1.6 is "past two quarters, not
 * yet a year" — so it is reported alongside the number rather than instead of it.
 * This is presentation: it renames what jev returned, it decides nothing.
 */
export function horizonLabel(band: number): string {
  const levels = ["within a quarter", "1-2 quarters", "2-4 quarters", "1-2 years", "3+ years"];
  const low = levels[Math.max(0, Math.min(levels.length - 1, Math.floor(band)))]!;
  const high = levels[Math.max(0, Math.min(levels.length - 1, Math.ceil(band)))]!;
  return low === high ? low : `${low} → ${high}`;
}

/**
 * Judge each company three times — real, again, and with the numbers worsened — to
 * see whether the verdict follows the evidence or the name.
 */
export async function runTwins(options: {
  store: Store;
  sample?: number;
  edgar?: EdgarClient;
  client?: TypeSafeClient;
  log?: (message: string) => void;
}): Promise<TwinsReport> {
  const log = options.log ?? (() => {});
  const asOf = todayISO();
  const store = options.store;

  const profiles = await store.loadFilers();
  const slice = await store.sliceAsOf(asOf);
  const universe = buildUniverse(profiles, slice, asOf);
  const profileOf = new Map(profiles.map((p) => [p.entity, p]));

  const allRows = universe.eligible.flatMap((v) => {
    const profile = profileOf.get(v.entity);
    return profile ? [computeMetrics(slice, v.entity, profile.sector, displayLabel(profile))] : [];
  });
  const peerTables = buildPeerTables(allRows, asOf);

  // Only companies jev would actually pick matter here: a verdict that was already
  // `exclude` cannot flip further, so perturbing one measures nothing.
  const last = await store.latestRun();
  const included = new Set(
    ((last?.payload as { picks?: { entity: string }[] } | undefined)?.picks ?? []).map((p) => String(p.entity)));
  const candidates = allRows.filter((row) => included.has(String(row.entity)));

  const wanted = options.sample ?? 40;
  const step = Math.max(1, Math.floor(candidates.length / wanted));
  const sample = candidates.filter((_, i) => i % step === 0).slice(0, wanted);
  log(`judging ${sample.length} included companies three ways…`);

  const edgar = options.edgar ?? createEdgarClient({ log });
  const jev = options.client ?? createClient();
  const outcomes: TwinOutcome[] = [];
  let metricsChanged = 0;

  for (const [index, row] of sample.entries()) {
    const profile = profileOf.get(row.entity);
    if (!profile) continue;

    let filing: FilingExcerpt | undefined;
    const ref = latestFiling(profile, ["10-K", "10-K/A", "10-Q"], asOf);
    if (ref) {
      try {
        filing = await fetchFilingText(edgar, profile.cik, ref);
      } catch {
        filing = undefined;
      }
    }

    const worse = perturb(row);
    metricsChanged += perturbedCount(row, worse);
    const peer = peerContextFor(peerTables, row.sector);

    for (const [condition, state] of [["real", row], ["repeat", row], ["perturbed", worse]] as const) {
      try {
        const result = await askJudgment(jev, state, peer, filing);
        const a = result.answers;
        outcomes.push({
          entity: String(row.entity), label: row.label, condition,
          verdict: a.verdict.choice, attractiveness: a.attractiveness.score,
          durability: a.durability.score, accountingQuality: a.accountingQuality.choice,
          managementCandor: a.managementCandor.choice,
        });
      } catch (error) {
        log(`  ${row.label} (${condition}) failed: ${(error as Error).message}`);
      }
    }
    if ((index + 1) % 10 === 0) log(`  ${index + 1}/${sample.length}`);
  }

  return summariseTwins(outcomes, metricsChanged);
}

/**
 * Measure whether jev can recognise the companies it is shown.
 *
 * Sampled across the revenue range rather than off the top, because recognition is
 * expected to track how much has been written about a company — and a sample of
 * mega-caps would answer a question nobody asked.
 */
export async function runProbe(options: {
  store: Store;
  sample?: number;
  edgar?: EdgarClient;
  client?: TypeSafeClient;
  log?: (message: string) => void;
}): Promise<ProbeReport> {
  const log = options.log ?? (() => {});
  const asOf = todayISO();
  const store = options.store;

  const profiles = await store.loadFilers();
  const slice = await store.sliceAsOf(asOf);
  const universe = buildUniverse(profiles, slice, asOf);
  const profileOf = new Map(profiles.map((p) => [p.entity, p]));

  const rows = universe.eligible
    .map((v) => {
      const profile = profileOf.get(v.entity);
      return profile ? computeMetrics(slice, v.entity, profile.sector, displayLabel(profile)) : undefined;
    })
    .flatMap((row) => (row ? [row] : []));

  // Revenue level, not a ratio: MetricRow carries growth and margins, so the
  // magnitude used for sampling and decoy matching comes from the slice directly.
  const revenueOf = (row: MetricRow): number => {
    const series = slice.series(row.entity, "revenue");
    return series.slice(-4).reduce((total, o) => total + o.value, 0);
  };
  const withRevenue = rows.filter((row) => revenueOf(row) > 0).sort((a, b) => revenueOf(a) - revenueOf(b));

  // Every nth company across the revenue range, so the sample spans obscure to famous.
  const wanted = options.sample ?? 60;
  const step = Math.max(1, Math.floor(withRevenue.length / wanted));
  const sample = withRevenue.filter((_, i) => i % step === 0).slice(0, wanted);
  log(`probing ${sample.length} companies of ${withRevenue.length} eligible with revenue…`);

  const edgar = options.edgar ?? createEdgarClient({ log });
  const jev = options.client ?? createClient();
  const outcomes: ProbeOutcome[] = [];

  for (const [index, row] of sample.entries()) {
    const profile = profileOf.get(row.entity);
    if (!profile) continue;

    // Decoys: same sector, nearest revenue, so the slate cannot be solved by size.
    const decoys = withRevenue
      .filter((other) => other.entity !== row.entity && other.sector === row.sector)
      .sort((a, b) => Math.abs(revenueOf(a) - revenueOf(row)) - Math.abs(revenueOf(b) - revenueOf(row)))
      .slice(0, 3)
      .map((other) => profileOf.get(other.entity)?.name ?? String(other.label));
    if (decoys.length < 3) continue;

    const slate = buildSlate(profile.name, decoys, String(row.entity));
    const names = [profile.name, ...decoys];

    let filingText: string | undefined;
    const filing = latestFiling(profile, ["10-K", "10-K/A", "10-Q"], asOf);
    if (filing) {
      try {
        const fetched = await fetchFilingText(edgar, profile.cik, filing);
        filingText = redact(`${fetched.mdna}\n\n${fetched.riskFactors}`, names).slice(0, FILING_EXCERPT_CHARS);
      } catch {
        filingText = undefined;
      }
    }

    for (const [condition, text] of [["numbers", undefined], ["text", filingText]] as const) {
      if (condition === "text" && !text) continue;
      try {
        const result = await askProbe(jev, row, slate, text);
        outcomes.push({
          condition, entity: String(row.entity), label: row.label,
          revenue: revenueOf(row), chosen: result.answers.identify.choice,
          truth: slate.truth, confidence: result.answers.identify.confidence,
        });
      } catch (error) {
        log(`  probe failed for ${row.label} (${condition}): ${(error as Error).message}`);
      }
    }
    if ((index + 1) % 10 === 0) log(`  ${index + 1}/${sample.length}`);
  }

  return summariseProbe(outcomes, sample.length);
}

/** Print a screen. Shared, so demo output and live output cannot drift apart. */
export function renderScreen(report: ScreenReport): void {
  console.log(`\njev picks as of ${report.stamp.asOf} — question set ${report.questionSetVersion}\n`);
  if (report.picks.length === 0) {
    console.log("  jev included nothing in this run.\n");
  }

  for (const [index, pick] of report.picks.entries()) {
    const { attractiveness, verdict, answers } = pick;
    console.log(
      `  ${String(index + 1).padStart(3)}. ${pick.label.padEnd(6)} ${attractiveness.score.toFixed(2)}  ` +
        `${pick.sector}${pick.fromCache ? "  (cached)" : ""}`,
    );
    console.log(
      `       verdict ${verdict.choice} ${(verdict.confidence * 100).toFixed(0)}%  ·  ` +
        `durability ${answers.durability.score.toFixed(2)}  ·  accounting ${answers.accountingQuality.choice}  ·  ` +
        `risk ${answers.dominantRisk.choice}  ·  candor ${answers.managementCandor.choice}  ·  ` +
        `evidence ${answers.sufficiency.choice}\n       ` +
        `settles via ${answers.horizonDriver.choice}  ·  ${horizonLabel(answers.horizonBand.score)} ` +
        `(band ${answers.horizonBand.score.toFixed(2)} of 4)`,
    );
  }

  console.log(
    `\n  ${report.eligible} eligible of ${report.considered} filers · ${report.judged} judged`,
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

/**
 * Grade every persisted run that carries a roster.
 *
 * Reads prices as of today on purpose. This is the one place later data is the point
 * rather than a leak: it is asking what happened, not what was knowable.
 */
export async function gradeRuns(store: Store, runId?: string): Promise<GradeReport[]> {
  const today = todayISO();
  const slice = await store.sliceAsOf(today, { metrics: [PRICE_METRIC] });
  const runs = await store.allRuns();

  return runs
    .filter((run) => !runId || run.runId.startsWith(runId))
    .flatMap((run) => {
      const roster = (run.payload as { roster?: RosterEntry[] }).roster;
      if (!roster?.length) return [];
      return [gradeRun({ runId: run.runId, asOf: run.asOf, questionSetVersion: run.questionSetVersion, roster }, slice, today)];
    });
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
      Backfill from the SEC bulk archives. --prices-all also refreshes closes;
      --prices-only refreshes closes alone, without re-reading the archives;
      --reprice refetches days already stored, for when the ticker map changed;
      --days=N pulls N weekdays of closes (default 5; ~500 for two years)
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
      const report = await runIngest({
        store, pricesAll: flags.has("prices-all"), pricesOnly: flags.has("prices-only"),
        reprice: flags.has("reprice"), log,
        ...(flags.get("days") ? { days: Number(flags.get("days")) } : {}),
      });
      // A prices-only run never reads the archives, so reporting archive counters
      // for it says "0 skipped" about work that never happened.
      console.log(flags.has("prices-only")
        ? `\n${report.priceObservations} new price points across ${report.filers} filers\n`
        : `\ningested ${report.observations} observations for ${report.filers} filers` +
          (report.priceObservations ? `, ${report.priceObservations} price points` : "") +
          `\n${report.skipped} companyfacts entries skipped (no submissions record)\n`);
      return;
    }

    if (subcommand === "demo") {
      const { seedDemoStore, demoClients } = await import("./demo.ts");
      const demoStore = await seedDemoStore();
      try {
        const { client, prices, edgar } = demoClients();
        const report = await runScreen({ store: demoStore, client, prices, edgar, limit: 10 });
        renderScreen(report);
        console.log("  Fixtures and a stubbed model. The pipeline is real; the judgment is not.\n");
      } finally {
        await demoStore.close();
      }
      return;
    }

    if (subcommand === "twins") {
      const sample = Number(flags.get("sample") ?? "40");
      console.log(JSON.stringify(await runTwins({ store, sample, log: (m) => console.log(m) }), null, 2));
      return;
    }

    if (subcommand === "probe") {
      const sample = Number(flags.get("sample") ?? "60");
      console.log(JSON.stringify(await runProbe({ store, sample, log: (m) => console.log(m) }), null, 2));
      return;
    }

    if (subcommand === "grade") {
      const reports = await gradeRuns(store, flags.get("run"));
      if (reports.length === 0) {
        console.log("\nNo run carries a roster yet. Runs persisted before grading existed recorded only");
        console.log("their picks, and a scorecard needs what was passed over too. The next screen will.\n");
        return;
      }
      console.log(JSON.stringify(reports, null, 2));
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
      console.log(JSON.stringify(await explainPick({ store, ticker: raw.toUpperCase() as Ticker, asOf }), null, 2));
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

  renderScreen(report);
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
