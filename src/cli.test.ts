/**
 * End-to-end pipeline test. Nothing here touches the network and no API key is
 * needed: jev, EDGAR (including the bulk ZIP path) and Stooq are all stubbed.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient } from "./client.ts";
import { coverageStatus, explainPick, runIngest, runScreen } from "./cli.ts";
import type { EdgarClient } from "./edgar.ts";
import { isoDate, ticker, type Observation, type Ticker } from "./observation.ts";
import type { PriceClient } from "./prices.ts";
import { ContaminatedRunError } from "./screen.ts";
import { openStore, type Store } from "./store.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** `count` quarter-end dates, oldest first, the newest ~4 months before today. */
function quarterEnds(count: number): string[] {
  const ends: string[] = [];
  const now = new Date();
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 1));

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i * 3 + 1, 0));
    ends.push(d.toISOString().slice(0, 10));
  }
  return ends;
}

const plusDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const QUARTERS = quarterEnds(16);
const LATEST_QUARTER = QUARTERS.at(-1)!;
const LATEST_FILED = plusDays(LATEST_QUARTER, 30);

interface Fixture { cik: number; ticker: string; name: string; sic: string; scale: number }

const COMPANIES: Fixture[] = [
  { cik: 1, ticker: "GOOD", name: "Good Industries", sic: "3571", scale: 1.0 },
  { cik: 2, ticker: "MEH", name: "Meh Manufacturing", sic: "3572", scale: 0.6 },
  { cik: 3, ticker: "DROP", name: "Drop Corp", sic: "3573", scale: 0.2 },
];

function companyFacts(fixture: Fixture): unknown {
  const quarterly = (base: number) =>
    QUARTERS.map((end, i) => ({
      start: plusDays(end, -89),
      end,
      val: Math.round(base * fixture.scale * (1 + i * 0.02)),
      filed: plusDays(end, 30),
      form: i === QUARTERS.length - 1 ? "10-K" : "10-Q",
      accn: `000000000${fixture.cik}-26-00000${i % 10}`,
    }));

  const instant = (base: number) =>
    QUARTERS.map((end, i) => ({
      end,
      val: Math.round(base * fixture.scale * (1 + i * 0.01)),
      filed: plusDays(end, 30),
      form: "10-Q",
      accn: `000000000${fixture.cik}-26-00000${i % 10}`,
    }));

  const usd = (entries: unknown[]) => ({ units: { USD: entries } });

  return {
    cik: fixture.cik,
    entityName: fixture.name,
    facts: {
      "us-gaap": {
        Revenues: usd(quarterly(1000)),
        GrossProfit: usd(quarterly(400)),
        OperatingIncomeLoss: usd(quarterly(200)),
        NetIncomeLoss: usd(quarterly(100)),
        NetCashProvidedByUsedInOperatingActivities: usd(quarterly(150)),
        PaymentsToAcquirePropertyPlantAndEquipment: usd(quarterly(50)),
        DepreciationDepletionAndAmortization: usd(quarterly(40)),
        Assets: usd(instant(10000)),
        Liabilities: usd(instant(4000)),
        CashAndCashEquivalentsAtCarryingValue: usd(instant(1000)),
        LongTermDebtNoncurrent: usd(instant(2000)),
        AccountsReceivableNetCurrent: usd(instant(800)),
        InventoryNet: usd(instant(600)),
      },
      dei: {
        EntityCommonStockSharesOutstanding: { units: { shares: instant(1000) } },
      },
    },
  };
}

function submissions(fixture: Fixture): unknown {
  const forms: string[] = [];
  const dates: string[] = [];
  const accessions: string[] = [];
  const documents: string[] = [];

  for (const [i, end] of QUARTERS.entries()) {
    forms.push(i === QUARTERS.length - 1 ? "10-K" : "10-Q");
    dates.push(plusDays(end, 30));
    accessions.push(`000000000${fixture.cik}-26-00000${i % 10}`);
    documents.push(`${fixture.ticker.toLowerCase()}.htm`);
  }

  return {
    cik: fixture.cik, name: fixture.name, sic: fixture.sic, tickers: [fixture.ticker],
    filings: { recent: { form: forms.reverse(), filingDate: dates.reverse(), accessionNumber: accessions.reverse(), primaryDocument: documents.reverse() } },
  };
}

/** A real ZIP (stored) so the bulk path is exercised rather than bypassed. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

async function stubEdgar(): Promise<EdgarClient> {
  const dir = await mkdtemp(join(tmpdir(), "jev-e2e-"));

  const factsZip = join(dir, "companyfacts.zip");
  const subsZip = join(dir, "submissions.zip");
  await writeFile(factsZip, makeZip(Object.fromEntries(
    COMPANIES.map((c) => [`CIK${String(c.cik).padStart(10, "0")}.json`, JSON.stringify(companyFacts(c))]),
  )));
  await writeFile(subsZip, makeZip(Object.fromEntries(
    COMPANIES.map((c) => [`CIK${String(c.cik).padStart(10, "0")}.json`, JSON.stringify(submissions(c))]),
  )));

  return {
    async getJson<T>(): Promise<T> {
      return Object.fromEntries(
        COMPANIES.map((c, i) => [String(i), { cik_str: c.cik, ticker: c.ticker, title: c.name }]),
      ) as T;
    },
    async getText(): Promise<string> {
      return (
        "<html>Item 1A. Risk Factors " + "Competition is intense. ".repeat(30) +
        "Item 1B. Unresolved. Item 7. Management's Discussion and Analysis " +
        "Revenue grew on volume and price. ".repeat(30) + "Item 8. Financial Statements</html>"
      );
    },
    async download(url: string): Promise<string> {
      return url.includes("companyfacts") ? factsZip : subsZip;
    },
  };
}

const stubPrices = (): PriceClient & { calls: Ticker[] } => {
  const calls: Ticker[] = [];
  return {
    calls,
    async closes(symbol: Ticker): Promise<Observation[]> {
      calls.push(symbol);
      return [{
        value: 50, metric: "close", entity: symbol,
        validAt: isoDate(LATEST_FILED), knownAt: isoDate(LATEST_FILED),
        source: "stooq", reliability: "market",
      }];
    },
  };
};

/** jev stub: triage advances GOOD and MEH; judgment includes only GOOD. */
function stubJev() {
  const calls: { stage: string; ticker: string }[] = [];

  const choice = (value: string, probabilities: Record<string, number>) =>
    ({ type: "choice", choice: value, confidence: probabilities[value] ?? 0.9, probabilities });
  const score = (value: number) =>
    ({ type: "score", score: value, confidence: 0.8, legend: {}, probabilities: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 } });

  const client = createClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { company: { ticker: string } };
        questions: Record<string, unknown>;
      };
      const symbol = body.state.company.ticker;
      const stage = "advance" in body.questions ? "triage" : "judgment";
      calls.push({ stage, ticker: symbol });

      const answers = stage === "triage"
        ? { advance: choice(symbol === "DROP" ? "drop" : "advance", { advance: 0.8, drop: 0.2 }) }
        : {
            verdict: choice(symbol === "GOOD" ? "include" : "watch", { include: 0.7, watch: 0.2, exclude: 0.1 }),
            attractiveness: score(symbol === "GOOD" ? 4.5 : 2.1),
            durability: score(3.2),
            accountingQuality: choice("clean", { clean: 0.8, questionable: 0.15, deteriorating: 0.05 }),
            dominantRisk: choice("demand", { demand: 0.5, margin: 0.2, balanceSheet: 0.1, regulatory: 0.1, none: 0.1 }),
            managementCandor: choice("direct", { direct: 0.6, guarded: 0.3, evasive: 0.1 }),
            sufficiency: choice("sufficient", { sufficient: 0.9, thin: 0.08, insufficient: 0.02 }),
          };

      return Response.json({
        model: "typesafe/jev-1.13-test",
        answers,
        usage: { input_tokens: stage === "triage" ? 300 : 15000, output_tokens: 20 },
      });
    },
  });

  return { client, calls };
}

async function seeded(): Promise<{ store: Store; edgar: EdgarClient }> {
  const store = await openStore(":memory:");
  const edgar = await stubEdgar();
  await runIngest({ store, edgar });
  return { store, edgar };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("ingest reads the bulk ZIPs and reports what it stored", async () => {
  const store = await openStore(":memory:");
  try {
    const report = await runIngest({ store, edgar: await stubEdgar() });

    assert.equal(report.filers, 3);
    assert.ok(report.observations > 300, `stored ${report.observations} observations`);
    assert.equal(report.skipped, 0);

    const filers = await store.loadFilers();
    assert.deepEqual(filers.map((f) => f.entity).sort(), ["DROP", "GOOD", "MEH"]);
    assert.equal(filers[0]?.sector, "manufacturing");
  } finally {
    await store.close();
  }
});

test("the full pipeline runs, and jev's verdict alone decides the picks", async () => {
  const { store, edgar } = await seeded();
  try {
    const jev = stubJev();
    const prices = stubPrices();
    const report = await runScreen({ store, edgar, prices, client: jev.client });

    assert.equal(report.eligible, 3);
    assert.equal(report.triaged, 3);
    assert.equal(report.advanced, 2, "DROP was dropped at triage");
    assert.equal(report.judged, 2);

    // MEH was judged `watch`, so it is not a pick despite surviving triage.
    assert.deepEqual(report.picks.map((p) => String(p.entity)), ["GOOD"]);
    assert.equal(report.picks[0]?.attractiveness.score, 4.5);
    assert.equal(report.stamp.contaminated, false);

    // Prices and filing text were fetched only for triage survivors.
    assert.deepEqual([...prices.calls].sort(), ["GOOD", "MEH"]);
    assert.equal(jev.calls.filter((c) => c.stage === "triage").length, 3);
    assert.equal(jev.calls.filter((c) => c.stage === "judgment").length, 2);
    assert.equal(jev.calls.some((c) => c.stage === "judgment" && c.ticker === "DROP"), false);
  } finally {
    await store.close();
  }
});

test("triage sees no price; judgment does", async () => {
  const { store, edgar } = await seeded();
  try {
    const states: { stage: string; hasMultiple: boolean }[] = [];
    const client = createClient({
      apiKey: "test-key",
      retry: { maxRetries: 0 },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown>; questions: Record<string, unknown> };
        const stage = "advance" in body.questions ? "triage" : "judgment";
        states.push({ stage, hasMultiple: JSON.stringify(body.state).includes("priceToEarnings") });

        return Response.json({
          model: "test",
          answers: stage === "triage"
            ? { advance: { type: "choice", choice: "advance", confidence: 0.9, probabilities: { advance: 0.9, drop: 0.1 } } }
            : {
                verdict: { type: "choice", choice: "exclude", confidence: 0.9, probabilities: {} },
                attractiveness: { type: "score", score: 1, confidence: 0.5, legend: {}, probabilities: {} },
                durability: { type: "score", score: 1, confidence: 0.5, legend: {}, probabilities: {} },
                accountingQuality: { type: "choice", choice: "clean", confidence: 0.5, probabilities: {} },
                dominantRisk: { type: "choice", choice: "none", confidence: 0.5, probabilities: {} },
                managementCandor: { type: "choice", choice: "direct", confidence: 0.5, probabilities: {} },
                sufficiency: { type: "choice", choice: "sufficient", confidence: 0.9, probabilities: {} },
              },
          usage: { input_tokens: 10, output_tokens: 1 },
        });
      },
    });

    await runScreen({ store, edgar, prices: stubPrices(), client });

    assert.equal(states.filter((s) => s.stage === "triage").every((s) => !s.hasMultiple), true);
    assert.equal(states.filter((s) => s.stage === "judgment").some((s) => s.hasMultiple), true);
  } finally {
    await store.close();
  }
});

test("a second run with no new filings is served from cache", async () => {
  const { store, edgar } = await seeded();
  try {
    const first = stubJev();
    await runScreen({ store, edgar, prices: stubPrices(), client: first.client });
    const callsAfterFirst = first.calls.length;
    assert.ok(callsAfterFirst > 0);

    const second = stubJev();
    const secondPrices = stubPrices();
    // No edgar, no prices, no client: a fully cached run must need none of them.
    const report = await runScreen({ store, prices: secondPrices });

    assert.equal(second.calls.length, 0, "no jev call was made on the second run");
    assert.deepEqual(secondPrices.calls, [], "no price was fetched on the second run");
    assert.equal(report.usage.inputTokens, 0, "a cached run costs no tokens");
    assert.deepEqual(report.picks.map((p) => String(p.entity)), ["GOOD"], "same answer from cache");
    assert.ok(report.cache.hits >= 5);
  } finally {
    await store.close();
  }
});

test("narrowing to one ticker still compares it against the whole universe", async () => {
  const { store, edgar } = await seeded();
  try {
    let universeCount = 0;
    const jev = stubJev();
    const spy = createClient({
      apiKey: "test-key",
      retry: { maxRetries: 0 },
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { state: { peers: { universe: { companies: number } } } };
        universeCount = body.state.peers.universe.companies;
        return jev.client.fetch(url, init);
      },
    });

    const report = await runScreen({ store, edgar, prices: stubPrices(), client: spy, tickers: [ticker("GOOD")] });

    assert.equal(report.triaged, 1, "only one company was judged");
    assert.equal(universeCount, 3, "but the yardstick still spans the eligible universe");
  } finally {
    await store.close();
  }
});

test("every run is persisted, contaminated or not", async () => {
  const { store, edgar } = await seeded();
  try {
    const report = await runScreen({ store, edgar, prices: stubPrices(), client: stubJev().client });

    assert.equal(await store.runCount(), 1);
    const saved = await store.latestRun();
    assert.equal(saved?.runId, report.runId);
    assert.equal(saved?.contaminated, false);
    assert.ok(JSON.stringify(saved?.payload).includes("GOOD"));
  } finally {
    await store.close();
  }
});

test("a past asOf refuses to run, and runs stamped when forced", async () => {
  const { store, edgar } = await seeded();
  try {
    const stale = isoDate("2024-01-15");

    await assert.rejects(
      () => runScreen({ store, edgar, prices: stubPrices(), client: stubJev().client, asOf: stale }),
      ContaminatedRunError,
    );
    assert.equal(await store.runCount(), 0, "a refused run is not persisted");

    const forced = await runScreen({
      store, edgar, prices: stubPrices(), client: stubJev().client,
      asOf: stale, allowContaminated: true,
    });

    assert.equal(forced.stamp.contaminated, true);
    assert.match(forced.stamp.notice ?? "", /must not be used to evaluate/);
    assert.equal((await store.latestRun())?.contaminated, true);
  } finally {
    await store.close();
  }
});

test("explain_pick shows every number's source, tag and knownAt", async () => {
  const { store, edgar } = await seeded();
  try {
    await runScreen({ store, edgar, prices: stubPrices(), client: stubJev().client });
    const explained = await explainPick({ store, entity: ticker("GOOD") });

    assert.equal(explained.eligible, true);
    assert.ok(explained.observations.length > 50);

    const revenue = explained.observations.find((o) => o.metric === "revenue");
    assert.equal(revenue?.tag, "Revenues");
    assert.match(revenue?.source ?? "", /^edgar:/);
    assert.ok(revenue?.knownAt);

    assert.ok(explained.metrics.revenueGrowthTtm, "derived metrics are shown too");
    // Both stages' answers come back, with their full distributions.
    assert.deepEqual(explained.judgments.map((j) => j.stage).sort(), ["judgment", "triage"]);
    assert.ok(JSON.stringify(explained.judgments).includes("probabilities"));
  } finally {
    await store.close();
  }
});

test("coverage_status reports the universe, sources and cache", async () => {
  const { store, edgar } = await seeded();
  try {
    await runScreen({ store, edgar, prices: stubPrices(), client: stubJev().client });
    const coverage = await coverageStatus(store);

    assert.equal(coverage.filers, 3);
    assert.equal(coverage.eligible, 3);
    assert.ok(coverage.observations > 300);
    assert.equal(coverage.runs, 1);
    assert.ok(coverage.lastRun);
    assert.ok(coverage.sources.length > 0);
    assert.ok(coverage.questionSetVersion);
  } finally {
    await store.close();
  }
});

test("screening before ingest fails with a usable message", async () => {
  const store = await openStore(":memory:");
  try {
    await assert.rejects(() => runScreen({ store }), /run `npm run ingest` first/);
  } finally {
    await store.close();
  }
});
