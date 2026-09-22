/**
 * Does jev judge the evidence, or the company?
 *
 * The identification probe established that jev recognises about 85% of these
 * companies from their filing text, through redaction. Recognition is not the same
 * as reliance, though — a model can know which company it is looking at and still
 * answer from the numbers in front of it. That gap is the untested link between "it
 * recognises them" and "its judgments are contaminated", and this measures it.
 *
 * Each company is judged three times:
 *
 *   - **real** — the actual metrics and filing text.
 *   - **repeat** — byte-identical to `real`. This is the noise floor: without it, a
 *     small movement under perturbation cannot be told from ordinary variance.
 *   - **perturbed** — the same filing text, with the numbers rewritten into those of
 *     a deteriorating, more expensive business.
 *
 * Reading it:
 *
 *   - Judgments move with the numbers → jev reads the evidence, and recognition is
 *     incidental to what it concludes.
 *   - Judgments hold still while the numbers collapse → the verdict is coming from
 *     what jev already knows about the name, and the provenance around it is
 *     decoration.
 *
 * The perturbation deliberately contradicts the prose. A thoughtful reader should
 * notice that an upbeat MD&A no longer matches the accounts, so some movement into
 * `accountingQuality: questionable` or `managementCandor: evasive` is the correct
 * response rather than a confound.
 */

import type { DerivedMetric, MetricRow } from "./metrics.ts";
import { derive, type Observation } from "./observation.ts";

/**
 * Turn a company's numbers into those of a worse, dearer business.
 *
 * Each rule is absolute rather than relative — `-|v| - 0.05` rather than `v * -1` —
 * so a company that was already mediocre still ends up clearly bad. A relative
 * scaling would leave a weak company roughly where it started and weaken the test
 * exactly where it needs to be strongest.
 */
const DEGRADE: Partial<Record<DerivedMetric, (value: number) => number>> = {
  revenueGrowthTtm: (v) => -Math.abs(v) - 0.05,
  revenueCagr3y: (v) => -Math.abs(v) - 0.05,
  grossMargin: (v) => v * 0.7,
  grossMarginTrend: (v) => -Math.abs(v) - 0.02,
  operatingMargin: (v) => v * 0.6,
  operatingMarginTrend: (v) => -Math.abs(v) - 0.02,
  fcfConversion: (v) => Math.min(v, 0.4) * 0.5,
  preTaxRoic: (v) => v * 0.25,
  netDebtToEbitda: (v) => Math.abs(v) + 3,
  shareCountChange1y: (v) => Math.abs(v) + 0.08,
  accrualRatio: (v) => Math.abs(v) + 0.15,
  receivablesGrowthVsRevenue: (v) => Math.abs(v) + 0.25,
  inventoryGrowthVsRevenue: (v) => Math.abs(v) + 0.25,
  priceToEarnings: (v) => v * 2,
  evToEbit: (v) => v * 2,
};

/** The same row, with every metric we know how to worsen rewritten. */
export function perturb(row: MetricRow): MetricRow {
  const metrics: Partial<Record<DerivedMetric, Observation>> = {};

  for (const [name, observation] of Object.entries(row.metrics)) {
    if (!observation) continue;
    const metric = name as DerivedMetric;
    const rule = DEGRADE[metric];
    metrics[metric] = rule
      ? derive(rule(observation.value), metric, [observation])
      : observation;
  }
  return { ...row, metrics };
}

/** How many of the metrics present actually changed. Guards against a no-op test. */
export function perturbedCount(before: MetricRow, after: MetricRow): number {
  let changed = 0;
  for (const [name, observation] of Object.entries(before.metrics)) {
    const other = after.metrics[name as DerivedMetric];
    if (observation && other && other.value !== observation.value) changed++;
  }
  return changed;
}

export interface TwinOutcome {
  readonly entity: string;
  readonly label: string;
  readonly condition: "real" | "repeat" | "perturbed";
  readonly verdict: string;
  readonly attractiveness: number;
  readonly durability: number;
  readonly accountingQuality: string;
  readonly managementCandor: string;
}

export interface TwinsReport {
  readonly companies: number;
  readonly metricsChanged: number;
  /** Movement between two identical asks. Anything at or below this is noise. */
  readonly noiseFloor: { readonly meanAbsAttractiveness: number; readonly verdictFlips: number };
  readonly perturbed: {
    readonly meanAttractivenessChange: number;
    readonly meanAbsAttractiveness: number;
    readonly meanDurabilityChange: number;
    readonly verdictFlips: number;
    readonly flippedToExclude: number;
    readonly turnedQuestionable: number;
    readonly turnedEvasive: number;
  };
  readonly reading: string;
}

const meanOf = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function summariseTwins(outcomes: readonly TwinOutcome[], metricsChanged: number): TwinsReport {
  const byEntity = new Map<string, Partial<Record<TwinOutcome["condition"], TwinOutcome>>>();
  for (const outcome of outcomes) {
    const found = byEntity.get(outcome.entity) ?? {};
    found[outcome.condition] = outcome;
    byEntity.set(outcome.entity, found);
  }

  const complete = [...byEntity.values()].filter((t) => t.real && t.perturbed);
  const withRepeat = complete.filter((t) => t.repeat);

  const noiseAttractiveness = withRepeat.map((t) => Math.abs(t.repeat!.attractiveness - t.real!.attractiveness));
  const noiseFlips = withRepeat.filter((t) => t.repeat!.verdict !== t.real!.verdict).length;

  const deltas = complete.map((t) => t.perturbed!.attractiveness - t.real!.attractiveness);
  const durabilityDeltas = complete.map((t) => t.perturbed!.durability - t.real!.durability);
  const flips = complete.filter((t) => t.perturbed!.verdict !== t.real!.verdict);

  const meanAbs = meanOf(deltas.map(Math.abs));
  const noiseAbs = meanOf(noiseAttractiveness);

  // The comparison that matters is against the noise floor, not against zero: jev
  // returns distributions, so two identical asks need not agree exactly.
  const moved = meanAbs > Math.max(noiseAbs * 3, 0.15);

  const reading = complete.length === 0
    ? "No company was judged under both conditions, so nothing can be concluded."
    : moved
      ? `Judgments track the numbers: attractiveness moved ${meanAbs.toFixed(2)} on average against a noise floor of ${noiseAbs.toFixed(2)}, and ${flips.length} of ${complete.length} verdicts changed. jev is reading the evidence rather than answering from the name, so recognition is incidental to what it concludes — about the forward screen. It says nothing about whether a historical run would be contaminated, because there the name carries the outcome too.`
      : `Judgments barely move. Attractiveness shifted ${meanAbs.toFixed(2)} on average against a noise floor of ${noiseAbs.toFixed(2)}, and ${flips.length} of ${complete.length} verdicts changed, while the numbers were rewritten into those of a deteriorating business. The verdict is coming from something other than the evidence supplied — most likely what jev already knows about the company — and the provenance around it is decoration.`;

  return {
    companies: complete.length,
    metricsChanged,
    noiseFloor: { meanAbsAttractiveness: noiseAbs, verdictFlips: noiseFlips },
    perturbed: {
      meanAttractivenessChange: meanOf(deltas),
      meanAbsAttractiveness: meanAbs,
      meanDurabilityChange: meanOf(durabilityDeltas),
      verdictFlips: flips.length,
      flippedToExclude: flips.filter((t) => t.perturbed!.verdict === "exclude").length,
      turnedQuestionable: complete.filter(
        (t) => t.real!.accountingQuality === "clean" && t.perturbed!.accountingQuality !== "clean").length,
      turnedEvasive: complete.filter(
        (t) => t.real!.managementCandor !== "evasive" && t.perturbed!.managementCandor === "evasive").length,
    },
    reading,
  };
}
