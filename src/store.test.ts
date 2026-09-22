import assert from "node:assert/strict";
import test from "node:test";
import { cik, isoDate, observation, ticker, type Observation } from "./observation.ts";
import { lockError, openStore, type Store } from "./store.ts";

const ACME = cik("320193");
const BETA = cik("789019");

const row = (
  entity: typeof ACME, metric: string, validAt: string, knownAt: string, value: number,
  extra: Partial<Observation> = {},
): Observation =>
  observation({
    value, metric, entity,
    validAt: isoDate(validAt), knownAt: isoDate(knownAt),
    source: "edgar:10-Q:x", reliability: "reported", ...extra,
  });

const withStore = async (fn: (store: Store) => Promise<void>): Promise<void> => {
  const store = await openStore(":memory:");
  try {
    await fn(store);
  } finally {
    await store.close();
  }
};

test("observations round-trip with their provenance intact", async () => {
  await withStore(async (store) => {
    await store.appendObservations([
      row(ACME, "revenue", "2026-03-31", "2026-05-01", 100, { tag: "Revenues", reliability: "audited" }),
    ]);

    const slice = await store.sliceAsOf(isoDate("2026-06-01"));
    const found = slice.latest(ACME, "revenue");

    assert.equal(found?.value, 100);
    assert.equal(found?.tag, "Revenues");
    assert.equal(found?.reliability, "audited");
    assert.equal(found?.source, "edgar:10-Q:x");
  });
});

test("the store is append-only: a restatement adds a row, it does not replace one", async () => {
  await withStore(async (store) => {
    await store.appendObservations([row(ACME, "revenue", "2026-03-31", "2026-05-01", 100)]);
    await store.appendObservations([row(ACME, "revenue", "2026-03-31", "2026-08-01", 105)]);

    assert.equal(await store.observationCount(), 2, "both rows are still on disk");

    // Each date sees what was knowable then — the old number is not lost.
    assert.equal((await store.sliceAsOf(isoDate("2026-06-01"))).latest(ACME, "revenue")?.value, 100);
    assert.equal((await store.sliceAsOf(isoDate("2026-09-01"))).latest(ACME, "revenue")?.value, 105);
  });
});

test("a slice never returns anything filed after its asOf", async () => {
  await withStore(async (store) => {
    await store.appendObservations([
      row(ACME, "revenue", "2026-03-31", "2026-05-01", 100),
      row(ACME, "revenue", "2026-06-30", "2026-08-01", 110),
      row(ACME, "revenue", "2026-09-30", "2026-11-01", 120),
    ]);

    const slice = await store.sliceAsOf(isoDate("2026-08-15"));
    assert.deepEqual(slice.series(ACME, "revenue").map((o) => o.value), [100, 110]);
  });
});

test("slices can be narrowed by metric and entity without changing the rules", async () => {
  await withStore(async (store) => {
    await store.appendObservations([
      row(ACME, "revenue", "2026-03-31", "2026-05-01", 100),
      row(ACME, "netIncome", "2026-03-31", "2026-05-01", 10),
      row(BETA, "revenue", "2026-03-31", "2026-05-01", 200),
    ]);

    const narrowed = await store.sliceAsOf(isoDate("2026-06-01"), { metrics: ["revenue"], entities: [ACME] });
    assert.deepEqual(narrowed.entities(), [ACME]);
    assert.equal(narrowed.latest(ACME, "netIncome"), undefined);
    assert.equal(narrowed.latest(ACME, "revenue")?.value, 100);
  });
});

test("filers round-trip, including their filing list", async () => {
  await withStore(async (store) => {
    await store.saveFilers([{
      entity: ACME, cik: cik(1234), tickers: [ticker("ACME")], name: "Acme Corp", sic: "3571", sector: "manufacturing",
      filings: [{ form: "10-K", filedAt: isoDate("2026-02-15"), accession: "a", primaryDocument: "k.htm" }],
    }]);

    const [loaded] = await store.loadFilers();
    assert.equal(loaded?.entity, ACME);
    assert.equal(loaded?.sector, "manufacturing");
    assert.equal(loaded?.filings[0]?.form, "10-K");
  });
});

test("the judgment cache survives a round trip through SQL", async () => {
  await withStore(async (store) => {
    const key = { entity: ACME, questionSetVersion: "v1", maxKnownAt: isoDate("2026-08-01"), stage: "judgment" as const, hasPrice: false };

    assert.equal(await store.cache.get(key), undefined);
    await store.cache.put({
      key, value: { verdict: "include", score: 4.2 },
      model: "jev-1.13", inputTokens: 15000, outputTokens: 40, createdAt: new Date().toISOString(),
    });

    const hit = await store.cache.get<{ verdict: string; score: number }>(key);
    assert.deepEqual(hit?.value, { verdict: "include", score: 4.2 });
    assert.equal(hit?.inputTokens, 15000);
    assert.deepEqual(store.cache.stats(), { hits: 1, misses: 1, writes: 1 });
  });
});

test("a different vintage is a different cache entry", async () => {
  await withStore(async (store) => {
    const base = { entity: ACME, questionSetVersion: "v1", stage: "judgment" as const, hasPrice: false };
    await store.cache.put({
      key: { ...base, maxKnownAt: isoDate("2026-05-01") },
      value: "old", model: "jev", inputTokens: 1, outputTokens: 1, createdAt: new Date().toISOString(),
    });

    assert.equal(await store.cache.get({ ...base, maxKnownAt: isoDate("2026-08-01") }), undefined);
    assert.equal((await store.cache.get({ ...base, maxKnownAt: isoDate("2026-05-01") }))?.value, "old");
  });
});

test("every run is persisted and retrievable", async () => {
  await withStore(async (store) => {
    assert.equal(await store.runCount(), 0);

    await store.saveRun({
      runId: "run-1", asOf: isoDate("2026-09-01"), questionSetVersion: "v1",
      contaminated: false, payload: { picks: ["ACME"] },
    });
    await store.saveRun({
      runId: "run-2", asOf: isoDate("2026-09-02"), questionSetVersion: "v1",
      contaminated: true, payload: { picks: [] },
    });

    assert.equal(await store.runCount(), 2);
    const latest = await store.latestRun();
    assert.equal(latest?.runId, "run-2");
    assert.equal(latest?.contaminated, true);

    const byDate = await store.latestRun(isoDate("2026-09-01"));
    assert.deepEqual(byDate?.payload, { picks: ["ACME"] });
  });
});

test("fetch failures are recorded per source for coverage reporting", async () => {
  await withStore(async (store) => {
    await store.recordFetch("edgar", "companyfacts", true, "cached");
    await store.recordFetch("stooq", "prices", false, "ACME: timeout");
    await store.recordFetch("stooq", "prices", false, "BETA: 429");

    const status = await store.fetchStatus();
    const stooq = status.find((s) => s.source === "stooq");
    const edgar = status.find((s) => s.source === "edgar");

    assert.equal(stooq?.failures24h, 2);
    assert.equal(stooq?.lastOkAt, null);
    assert.match(stooq?.lastFailureDetail ?? "", /429|timeout/);
    assert.ok(edgar?.lastOkAt);
    assert.equal(edgar?.failures24h, 0);
  });
});

test("appending nothing is a no-op", async () => {
  await withStore(async (store) => {
    assert.equal(await store.appendObservations([]), 0);
    assert.equal(await store.observationCount(), 0);
  });
});

test("a second writer gets an actionable message, not a raw DuckDB error", () => {
  // DuckDB's lock is cross-process, so this cannot be provoked in-process — it was
  // observed live when a second `npm run screen` bounced off a running one. What is
  // testable, and what actually matters, is that the raw error becomes actionable.
  const raw = new Error(
    'IO Error: Could not set lock on file "data/jev.duckdb": Conflicting lock is held in ' +
      "/Users/x/.local/node/bin/node (PID 40008) by user x. See also https://duckdb.org/docs/stable/connect/concurrency",
  );

  const friendly = lockError("data/jev.duckdb", raw);

  assert.match(friendly.message, /already open by another process \(PID 40008\)/);
  assert.match(friendly.message, /single writer/);
  assert.match(friendly.message, /one ingest, screen or MCP server/);
  assert.match(friendly.message, /ps -p 40008/);
  assert.equal(friendly.cause, raw, "the original error is preserved for debugging");
});

test("a lock error with no PID still reads sensibly", () => {
  const friendly = lockError("data/jev.duckdb", new Error("Could not set lock on file"));

  assert.match(friendly.message, /already open by another process\./);
  assert.equal(/PID|ps -p/.test(friendly.message), false);
});

test("compaction folds repeated facts together and keeps real revisions", async () => {
  await withStore(async (store) => {
    const fact = {
      value: 100, metric: "revenue", entity: ACME, validAt: isoDate("2026-03-31"),
      knownAt: isoDate("2026-05-01"), source: "edgar:10-Q:a", reliability: "reported" as const,
    };
    // The same archive read twice yields byte-identical rows.
    await store.appendObservations([observation(fact), observation(fact), observation(fact)]);
    // A genuine restatement differs in knownAt, and must survive.
    await store.appendObservations([observation({ ...fact, value: 110, knownAt: isoDate("2026-08-01") })]);

    assert.equal(await store.observationCount(), 4);
    assert.equal(await store.compact(), 2, "two redundant copies removed");
    assert.equal(await store.observationCount(), 2, "the fact and its restatement both remain");

    const slice = await store.sliceAsOf(isoDate("2026-09-01"));
    assert.equal(slice.latest(ACME, "revenue")?.value, 110, "the restatement still wins");
  });
});

test("compacting a table with nothing to fold changes nothing", async () => {
  await withStore(async (store) => {
    await store.appendObservations([observation({
      value: 1, metric: "revenue", entity: ACME, validAt: isoDate("2026-03-31"),
      knownAt: isoDate("2026-05-01"), source: "edgar:10-Q:a", reliability: "reported",
    })]);
    assert.equal(await store.compact(), 0);
    assert.equal(await store.observationCount(), 1);
  });
});
