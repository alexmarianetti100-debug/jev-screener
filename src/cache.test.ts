import assert from "node:assert/strict";
import test from "node:test";
import { cacheKeyFor, memoryCache, rowVintage, serializeKey, throughCache, vintageOf } from "./cache.ts";
import type { MetricRow } from "./metrics.ts";
import { cik,isoDate, observation, ticker, type ISODate, type Observation } from "./observation.ts";

const ACME = cik("320193");

const obs = (knownAt: string, metric = "revenue"): Observation =>
  observation({
    value: 1, metric, entity: ACME,
    validAt: isoDate("2026-06-30"), knownAt: isoDate(knownAt),
    source: "edgar", reliability: "reported",
  });

const rowWith = (...knownAts: string[]): MetricRow => ({
  entity: ACME, label: "ACME", sector: "retail", asOf: isoDate("2026-09-01"),
  metrics: {}, inputs: knownAts.map((k) => obs(k)), hasPrice: false,
});

test("vintage is the newest knownAt across all inputs", () => {
  assert.equal(vintageOf([obs("2026-05-01"), obs("2026-08-01"), obs("2026-07-01")]), "2026-08-01");
  assert.equal(vintageOf([]), undefined);
});

test("a row with no inputs falls back to the slice date", () => {
  const empty: MetricRow = {
    entity: ACME, label: "ACME", sector: "retail", asOf: isoDate("2026-09-01"),
    metrics: {}, inputs: [], hasPrice: false,
  };
  assert.equal(rowVintage(empty), "2026-09-01");
});

test("the key changes when a new filing lands", () => {
  const before = cacheKeyFor(rowWith("2026-05-01"), "v1", "judgment");
  const after = cacheKeyFor(rowWith("2026-05-01", "2026-08-01"), "v1", "judgment");

  assert.notEqual(serializeKey(before), serializeKey(after));
  assert.equal(after.maxKnownAt, "2026-08-01");
});

test("the key changes when the question set is bumped", () => {
  const row = rowWith("2026-05-01");
  assert.notEqual(
    serializeKey(cacheKeyFor(row, "v1", "judgment")),
    serializeKey(cacheKeyFor(row, "v2", "judgment")),
  );
});

test("time passing alone does not expire an entry", () => {
  // Same inputs, same questions, a month later: the answer cannot have changed.
  const monday = cacheKeyFor(rowWith("2026-05-01"), "v1", "judgment");
  const later = cacheKeyFor(rowWith("2026-05-01"), "v1", "judgment");
  assert.equal(serializeKey(monday), serializeKey(later));
});

test("a miss computes and stores; a hit does not call jev again", async () => {
  const cache = memoryCache();
  const key = cacheKeyFor(rowWith("2026-05-01"), "v1", "judgment");
  let calls = 0;

  const compute = async () => {
    calls++;
    return { value: { advance: "advance" }, model: "jev-1.13", inputTokens: 300, outputTokens: 12 };
  };

  const first = await throughCache(cache, key, compute);
  assert.equal(first.fromCache, false);
  assert.equal(first.inputTokens, 300);
  assert.equal(calls, 1);

  const second = await throughCache(cache, key, compute);
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.value, { advance: "advance" });
  // A cache hit costs no tokens, which is what makes a daily sweep affordable.
  assert.equal(second.inputTokens, 0);
  assert.equal(calls, 1);

  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, writes: 1 });
});

test("a new filing forces a fresh judgment", async () => {
  const cache = memoryCache();
  let calls = 0;
  const compute = async () => {
    calls++;
    return { value: { n: calls }, model: "jev", inputTokens: 1, outputTokens: 1 };
  };

  await throughCache(cache, cacheKeyFor(rowWith("2026-05-01"), "v1", "judgment"), compute);
  const afterFiling = await throughCache(cache, cacheKeyFor(rowWith("2026-05-01", "2026-08-01"), "v1", "judgment"), compute);

  assert.equal(afterFiling.fromCache, false);
  assert.equal(calls, 2);
});

test("a restatement counts as new information", () => {
  // A restated figure arrives with a later knownAt, so the vintage moves and the
  // company is re-judged — which is correct: the inputs genuinely changed.
  const original = rowVintage(rowWith("2026-05-01"));
  const restated = rowVintage(rowWith("2026-05-01", "2026-11-20"));

  assert.notEqual(original, restated);
  assert.equal(restated, "2026-11-20" as ISODate);
});
