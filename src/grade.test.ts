import assert from "node:assert/strict";
import test from "node:test";
import { buildSlice, cik, isoDate, observation, type Observation } from "./observation.ts";
import { gradeRun, horizonEnd, priceOn, type RosterEntry } from "./grade.ts";

const ACME = cik(1);
const BETA = cik(2);
const TODAY = isoDate("2028-01-03");

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
