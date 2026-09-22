import assert from "node:assert/strict";
import test from "node:test";
import {
  addMonths, buildSlice, cik, daysBetween, derive, isoDate, observation, ticker,
  type Observation,
} from "./observation.ts";

const ACME = cik("320193");

const row = (metric: string, validAt: string, knownAt: string, value: number, extra: Partial<Observation> = {}): Observation =>
  observation({
    value, metric, entity: ACME,
    validAt: isoDate(validAt), knownAt: isoDate(knownAt),
    source: "test", reliability: "audited", ...extra,
  });

test("tickers normalise and CIKs zero-pad to ten digits", () => {
  assert.equal(ticker(" aapl "), "AAPL");
  assert.equal(cik(320193), "0000320193");
  assert.equal(cik("CIK0000320193"), "0000320193");
  assert.throws(() => cik("none"), TypeError);
});

test("isoDate accepts a timestamp but rejects nonsense", () => {
  assert.equal(isoDate("2026-03-31T00:00:00Z"), "2026-03-31");
  assert.throws(() => isoDate("31/03/2026"), TypeError);
});

test("date arithmetic crosses year boundaries", () => {
  assert.equal(addMonths(isoDate("2026-01-31"), -18), "2024-07-31");
  assert.equal(daysBetween(isoDate("2026-01-01"), isoDate("2026-03-02")), 60);
});

test("a slice hides observations that were not yet knowable", () => {
  const slice = buildSlice([row("revenue", "2026-03-31", "2026-05-01", 100)], isoDate("2026-04-15"));
  assert.equal(slice.latest(ACME, "revenue"), undefined);
  assert.equal(slice.entities().length, 0);
});

test("a restatement supersedes the original for the same period", () => {
  const rows = [
    row("revenue", "2026-03-31", "2026-05-01", 100),
    row("revenue", "2026-03-31", "2026-08-01", 105), // restated
  ];

  assert.equal(buildSlice(rows, isoDate("2026-06-01")).latest(ACME, "revenue")?.value, 100);
  assert.equal(buildSlice(rows, isoDate("2026-09-01")).latest(ACME, "revenue")?.value, 105);
});

test("a period appears once however many times it was revised", () => {
  const rows = [
    row("revenue", "2026-03-31", "2026-05-01", 100),
    row("revenue", "2026-03-31", "2026-08-01", 105),
    row("revenue", "2026-06-30", "2026-08-01", 110),
  ];
  const series = buildSlice(rows, isoDate("2026-09-01")).series(ACME, "revenue");

  assert.deepEqual(series.map((o) => [o.validAt, o.value]), [["2026-03-31", 105], ["2026-06-30", 110]]);
});

test("series come back oldest first regardless of insertion order", () => {
  const rows = [
    row("revenue", "2026-09-30", "2026-11-01", 3),
    row("revenue", "2026-03-31", "2026-05-01", 1),
    row("revenue", "2026-06-30", "2026-08-01", 2),
  ];
  const series = buildSlice(rows, isoDate("2026-12-01")).series(ACME, "revenue");
  assert.deepEqual(series.map((o) => o.value), [1, 2, 3]);
});

test("derived figures inherit the newest knownAt of their inputs", () => {
  const result = derive(0.5, "grossMargin", [
    row("grossProfit", "2026-03-31", "2026-05-01", 50),
    row("revenue", "2026-03-31", "2026-08-01", 100),
  ]);

  // Knowable only once the later input was — never earlier.
  assert.equal(result.knownAt, "2026-08-01");
  assert.equal(result.validAt, "2026-03-31");
  assert.equal(result.metric, "grossMargin");
});

test("derived figures are no more reliable than their weakest input", () => {
  const result = derive(12, "priceToEarnings", [
    row("netIncome", "2026-03-31", "2026-05-01", 10, { reliability: "audited" }),
    row("close", "2026-05-02", "2026-05-02", 120, { reliability: "market" }),
  ]);

  assert.equal(result.reliability, "market");
  assert.equal(result.source, "test");
});

test("deriving across two companies is a bug, not a silent merge", () => {
  const other = observation({
    value: 1, metric: "revenue", entity: cik("789019"),
    validAt: isoDate("2026-03-31"), knownAt: isoDate("2026-05-01"),
    source: "test", reliability: "audited",
  });

  assert.throws(() => derive(1, "ratio", [row("revenue", "2026-03-31", "2026-05-01", 1), other]), /across entities/);
  assert.throws(() => derive(1, "ratio", []), /no inputs/);
});
