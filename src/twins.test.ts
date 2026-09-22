import assert from "node:assert/strict";
import test from "node:test";
import { cik, derive, isoDate, observation, type Observation } from "./observation.ts";
import type { DerivedMetric, MetricRow } from "./metrics.ts";
import { perturb, perturbedCount, summariseTwins, type TwinOutcome } from "./twins.ts";

const seed = observation({
  value: 1, metric: "revenue", entity: cik(1), validAt: isoDate("2026-06-30"),
  knownAt: isoDate("2026-08-01"), source: "edgar:10-Q:a", reliability: "reported",
});

const row = (metrics: Partial<Record<DerivedMetric, number>>): MetricRow => {
  const built: Partial<Record<DerivedMetric, Observation>> = {};
  for (const [metric, value] of Object.entries(metrics)) {
    built[metric as DerivedMetric] = derive(value as number, metric, [seed]);
  }
  return {
    entity: cik(1), label: "ACME", sector: "retail", asOf: isoDate("2026-09-22"),
    metrics: built, obligations: {}, inputs: [seed], hasPrice: true,
  };
};

const twin = (condition: TwinOutcome["condition"], over: Partial<TwinOutcome> = {}): TwinOutcome => ({
  entity: "1", label: "ACME", condition,
  verdict: "include", attractiveness: 3.5, durability: 2.5,
  accountingQuality: "clean", managementCandor: "guarded",
  ...over,
});

test("a healthy company's numbers become an unhealthy company's numbers", () => {
  const before = row({ revenueGrowthTtm: 0.18, fcfConversion: 1.2, preTaxRoic: 0.4, netDebtToEbitda: 0.2, priceToEarnings: 20 });
  const after = perturb(before);

  assert.ok(after.metrics.revenueGrowthTtm!.value < 0, "growth turns negative");
  assert.ok(after.metrics.fcfConversion!.value < 0.4, "cash stops following earnings");
  assert.ok(after.metrics.preTaxRoic!.value < before.metrics.preTaxRoic!.value);
  assert.ok(after.metrics.netDebtToEbitda!.value > 3, "leverage arrives");
  assert.ok(after.metrics.priceToEarnings!.value > before.metrics.priceToEarnings!.value, "and it gets dearer");
});

test("an already-weak company still ends up clearly worse", () => {
  // A relative rule would leave a mediocre company roughly where it started, which is
  // exactly where the test needs to bite hardest.
  const before = row({ revenueGrowthTtm: 0.01, grossMarginTrend: -0.001 });
  const after = perturb(before);

  assert.ok(after.metrics.revenueGrowthTtm!.value <= -0.05);
  assert.ok(after.metrics.grossMarginTrend!.value <= -0.02);
});

test("perturbation keeps provenance and reports how much it changed", () => {
  const before = row({ revenueGrowthTtm: 0.18, fcfConversion: 1.2 });
  const after = perturb(before);

  assert.equal(after.entity, before.entity);
  assert.equal(after.label, before.label, "the same company, so recognition is unchanged");
  assert.equal(perturbedCount(before, after), 2);
  // A rule that silently did nothing would make the whole experiment vacuous.
  assert.equal(perturbedCount(before, before), 0);
});

test("movement is judged against the noise floor, not against zero", () => {
  // jev returns distributions, so two identical asks need not agree exactly. A shift
  // no larger than that disagreement is not evidence of anything.
  const outcomes = [
    twin("real", { attractiveness: 3.50 }),
    twin("repeat", { attractiveness: 3.44 }),
    twin("perturbed", { attractiveness: 3.42 }),
  ];
  const report = summariseTwins(outcomes, 12);

  assert.ok(report.noiseFloor.meanAbsAttractiveness > 0.05);
  assert.match(report.reading, /Judgments barely move/);
  assert.match(report.reading, /provenance around it is decoration/);
});

test("a large move against a quiet noise floor reads as evidence-driven", () => {
  const outcomes = [
    twin("real", { attractiveness: 3.80 }),
    twin("repeat", { attractiveness: 3.79 }),
    twin("perturbed", { attractiveness: 1.10, verdict: "exclude", accountingQuality: "questionable" }),
  ];
  const report = summariseTwins(outcomes, 12);

  assert.equal(report.perturbed.verdictFlips, 1);
  assert.equal(report.perturbed.flippedToExclude, 1);
  assert.equal(report.perturbed.turnedQuestionable, 1);
  assert.ok(report.perturbed.meanAttractivenessChange < -2);
  assert.match(report.reading, /track the numbers/);
  // The forward screen is what this speaks to; a historical run is a different claim.
  assert.match(report.reading, /says nothing about whether a historical run would be contaminated/);
});

test("a company judged under only one condition is not counted", () => {
  const report = summariseTwins([twin("real")], 12);
  assert.equal(report.companies, 0);
  assert.match(report.reading, /nothing can be concluded/);
});
