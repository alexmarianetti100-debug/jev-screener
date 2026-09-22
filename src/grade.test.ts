import assert from "node:assert/strict";
import test from "node:test";
import { buildSlice, cik, isoDate, observation, type Observation } from "./observation.ts";
import { gradeRun, horizonEnd, priceOn, type RosterEntry } from "./grade.ts";

const ACME = cik(1);
const BETA = cik(2);
const TODAY = isoDate("2028-01-03");

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const close = (entity: string, day: string, value: number): Observation =>
  observation({
    value, metric: "close", entity: entity as never,
    validAt: isoDate(day), knownAt: isoDate(day), source: "polygon", reliability: "market",
  });

const roster = (verdict: string, fcf?: number): RosterEntry[] => [
  { entity: String(ACME), label: "ACME", sector: "retail", verdict, attractiveness: 3.5, ...(fcf !== undefined ? { fcfConversion: fcf } : {}) },
];

test("a price is read backwards, never forwards", () => {
  const series = [close(String(ACME), "2026-09-18", 100), close(String(ACME), "2026-09-23", 200)];

  assert.equal(priceOn(series, isoDate("2026-09-21")), 100, "the last close at or before the date");
  assert.equal(priceOn(series, isoDate("2026-09-23")), 200);
  // Using the 2026-09-23 print for a 2026-09-21 question would be look-ahead, which
  // is the one thing the store exists to make impossible.
  assert.notEqual(priceOn(series, isoDate("2026-09-21")), 200);
});

test("a stale price is no price", () => {
  const series = [close(String(ACME), "2026-01-05", 100)];
  assert.equal(priceOn(series, isoDate("2026-01-09")), 100, "a long weekend is fine");
  assert.equal(priceOn(series, isoDate("2026-06-01")), undefined, "five months is not");
});

test("a horizon the prices do not reach yet is pending, not zero", () => {
  const slice = buildSlice([close(String(ACME), "2026-09-21", 100)], isoDate("2026-09-22"));
  const report = gradeRun(
    { runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1", roster: roster("include") },
    slice,
    isoDate("2026-09-22"),
  );

  // Every horizon is in the future, so none may report a number.
  assert.equal(report.horizons.every((h) => h.pending !== undefined), true);
  assert.equal(report.horizons.every((h) => h.spread === undefined), true);
  assert.match(report.horizons[0]!.pending!, /needs closes through/);
});

test("the spread is picks against what was passed over, not against zero", () => {
  const end = horizonEnd(isoDate("2026-09-21"), 21);
  const rows = [
    close(String(ACME), "2026-09-21", 100), close(String(ACME), end, 120),   // +20%
    close(String(BETA), "2026-09-21", 100), close(String(BETA), end, 110),   // +10%
  ];
  const slice = buildSlice(rows, TODAY);

  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [
      { entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9 },
      { entity: String(BETA), label: "BETA", sector: "retail", verdict: "exclude", attractiveness: 1.0 },
    ],
  }, slice, TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;
  assert.equal(oneMonth.included?.n, 1);
  assert.equal(oneMonth.excluded?.n, 1);
  assert.ok(Math.abs(oneMonth.included!.meanReturn - 0.2) < 1e-9);
  assert.ok(Math.abs(oneMonth.excluded!.meanReturn - 0.1) < 1e-9);
  // Both rose. Only the difference is evidence of anything.
  assert.ok(Math.abs(oneMonth.spread! - 0.1) < 1e-9);
});

test("the free baseline is graded beside the model, on the same names", () => {
  const end = horizonEnd(isoDate("2026-09-21"), 21);
  const rows = [
    close(String(ACME), "2026-09-21", 100), close(String(ACME), end, 90),    // jev's pick fell
    close(String(BETA), "2026-09-21", 100), close(String(BETA), end, 130),   // cash conversion won
  ];
  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [
      { entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9, fcfConversion: 0.2 },
      { entity: String(BETA), label: "BETA", sector: "retail", verdict: "exclude", attractiveness: 1.0, fcfConversion: 2.0 },
    ],
  }, buildSlice(rows, TODAY), TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;
  assert.equal(oneMonth.baseline?.n, 1, "one name, matching the count jev included");
  assert.ok(Math.abs(oneMonth.baseline!.meanReturn - 0.3) < 1e-9, "the baseline took BETA");
  assert.ok(oneMonth.spread! < 0, "jev lost to what it passed over");
  assert.ok(oneMonth.baselineSpread! > oneMonth.spread!, "and lost to the free ranking too");
});

test("a report refuses to imply significance from one cohort", () => {
  const report = gradeRun(
    { runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1", roster: roster("include") },
    buildSlice([], TODAY),
    TODAY,
  );
  assert.ok(report.caveats.some((c) => /No significance can be claimed/.test(c)));
  assert.ok(report.caveats.some((c) => /autocorrelated/.test(c)));
  assert.ok(report.caveats.some((c) => /Dividends are not in this data/.test(c)));
});

// ── Survivorship ──────────────────────────────────────────────────────────────

test("a pick that stops trading is counted, not quietly dropped", () => {
  const end = horizonEnd(isoDate("2026-09-21"), 21);
  const rows = [
    // ACME was picked and went to zero: priced at entry, never seen again.
    close(String(ACME), "2026-09-21", 100),
    // BETA was picked and doubled, and is still trading today.
    close(String(BETA), "2026-09-21", 100), close(String(BETA), end, 200), close(String(BETA), TODAY, 210),
  ];

  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [
      { entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9 },
      { entity: String(BETA), label: "BETA", sector: "retail", verdict: "include", attractiveness: 3.8 },
    ],
  }, buildSlice(rows, TODAY), TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;

  // Dropping ACME would report +100% on a book that lost half its names.
  assert.equal(oneMonth.included?.delisted, 1, "the disappearance is recorded");
  assert.equal(oneMonth.included?.n, 1, "one name actually priced end to end");
  assert.ok(Math.abs(oneMonth.included!.meanReturn - 1) < 1e-9, "the optimistic bound ignores it");
  // (+100% and -100%) / 2 = 0.
  assert.ok(Math.abs(oneMonth.included!.meanIfDelistedAreTotalLoss) < 1e-9, "the pessimistic bound does not");
});

test("a gap at the horizon is not a delisting", () => {
  const end = horizonEnd(isoDate("2026-09-21"), 21);
  const rows = [
    close(String(ACME), "2026-09-21", 100),
    // Nothing near `end`, but trading again well after: a hole, not an outcome.
    close(String(ACME), addDays(end, 40), 130), close(String(ACME), TODAY, 140),
  ];

  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [{ entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9 }],
  }, buildSlice(rows, TODAY), TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;
  assert.equal(oneMonth.included?.gaps, 1, "counted as missing data");
  assert.equal(oneMonth.included?.delisted, 0, "and not as a total loss");
});

test("the spread is reported on both bounds, so survivorship cannot hide in it", () => {
  const end = horizonEnd(isoDate("2026-09-21"), 21);
  const rows = [
    close(String(ACME), "2026-09-21", 100),                                              // pick, delisted
    close(String(BETA), "2026-09-21", 100), close(String(BETA), end, 110), close(String(BETA), TODAY, 115),
  ];

  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [
      { entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9 },
      { entity: String(BETA), label: "BETA", sector: "retail", verdict: "exclude", attractiveness: 1.0 },
    ],
  }, buildSlice(rows, TODAY), TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;
  // Every pick vanished, so the optimistic spread is computed on nothing and the
  // pessimistic one shows the truth: the pick lost everything, the pass rose 10%.
  assert.equal(oneMonth.included?.delisted, 1);
  assert.ok(Math.abs(oneMonth.spreadIfDelistedAreTotalLoss! - -1.1) < 1e-9, "-100% against +10%");
  assert.ok(oneMonth.spreadIfDelistedAreTotalLoss! < (oneMonth.spread ?? 0), "the pessimistic bound is worse");
});

test("a company that never had a price is unpriced, not delisted", () => {
  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [
      { entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9 },
      { entity: String(BETA), label: "BETA", sector: "retail", verdict: "include", attractiveness: 3.8 },
    ],
  }, buildSlice([close(String(BETA), "2026-09-21", 100), close(String(BETA), horizonEnd(isoDate("2026-09-21"), 21), 110)], TODAY), TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;
  // A filer with no ticker never entered the measurement; it did not fail in it.
  assert.equal(oneMonth.included?.unpriced, 1);
  assert.equal(oneMonth.included?.delisted, 0);
});

test("the caveats name the survivorship treatment, so a reader cannot miss it", () => {
  const report = gradeRun(
    { runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1", roster: roster("include") },
    buildSlice([], TODAY), TODAY,
  );
  assert.ok(report.caveats.some((c) => /Delisted names are counted, not dropped/.test(c)));
});

// ── The market ────────────────────────────────────────────────────────────────

test("a cohort that rose is measured against the tide that lifted it", async () => {
  const { BENCHMARK_ENTITY } = await import("./constants.ts");
  const end = horizonEnd(isoDate("2026-09-21"), 21);
  const rows = [
    close(String(ACME), "2026-09-21", 100), close(String(ACME), end, 105),        // pick: +5%
    close(String(BETA), "2026-09-21", 100), close(String(BETA), end, 102),        // pass: +2%
    close(BENCHMARK_ENTITY, "2026-09-21", 100), close(BENCHMARK_ENTITY, end, 110), // market: +10%
  ];

  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [
      { entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9 },
      { entity: String(BETA), label: "BETA", sector: "retail", verdict: "exclude", attractiveness: 1.0 },
    ],
  }, buildSlice(rows, TODAY), TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;

  assert.equal(oneMonth.market?.symbol, "SPY");
  assert.ok(Math.abs(oneMonth.market!.return - 0.1) < 1e-9);
  // The picks beat what was passed over and still lost to owning the index. Reporting
  // only the spread would have called this a win.
  assert.ok(oneMonth.spread! > 0, "positive against the passed-over names");
  assert.ok(oneMonth.vsMarket! < 0, "and negative against the market");
  assert.ok(Math.abs(oneMonth.vsMarket! - -0.05) < 1e-9);
});

test("no benchmark data means no market claim, not a zero", () => {
  const end = horizonEnd(isoDate("2026-09-21"), 21);
  const report = gradeRun({
    runId: "r1", asOf: isoDate("2026-09-21"), questionSetVersion: "v1",
    roster: [{ entity: String(ACME), label: "ACME", sector: "retail", verdict: "include", attractiveness: 3.9 }],
  }, buildSlice([close(String(ACME), "2026-09-21", 100), close(String(ACME), end, 105)], TODAY), TODAY);

  const oneMonth = report.horizons.find((h) => h.horizon === "1m")!;
  assert.equal(oneMonth.market, undefined);
  assert.equal(oneMonth.vsMarket, undefined);
});
