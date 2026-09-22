/**
 * Forward-only grading: did jev's picks do better than the ones it passed on?
 *
 * This is the only honest scorecard this system can have. It cannot be backtested —
 * jev's training data may already contain what happened after any filing it reads, so
 * a historical test measures hindsight. Everything here therefore starts from the day
 * the first run was persisted and accumulates, which is why runs are written in full
 * and never rewritten.
 *
 * Three rules this file exists to keep honest:
 *
 *  1. **Compare against what was passed over.** A bucket of picks going up says
 *     nothing on its own; the market goes up. The number that means something is the
 *     spread between what jev included and what it excluded, from the same universe
 *     on the same day.
 *  2. **Compare against something free.** A deterministic ranking by cash conversion
 *     costs nothing and needs no model. If jev's ordering does not beat it, the
 *     judgment layer is decoration, and that is the most valuable thing this can say.
 *  3. **Say when there is not enough data.** A horizon the price history does not
 *     cover yet returns `pending`, not a number. Reporting three days of drift as a
 *     one-year result is the failure this whole file is built to avoid.
 *
 * Nothing here decides anything about a company. It is arithmetic over outcomes that
 * already happened, which is why the horizons below are measurement parameters rather
 * than the judgments `constants.ts` is forbidden to hold.
 */

import type { ISODate, Observation, ObservationSlice } from "./observation.ts";
import { PRICE_METRIC } from "./observation.ts";
import { BENCHMARK_ENTITY, BENCHMARK_SYMBOL } from "./constants.ts";

/** Trading-day horizons, roughly one month through two years. */
export const HORIZONS: readonly { readonly label: string; readonly days: number }[] = [
  { label: "1m", days: 21 },
  { label: "3m", days: 63 },
  { label: "6m", days: 126 },
  { label: "1y", days: 252 },
  { label: "2y", days: 504 },
];

/**
 * How far before a target date a close may sit and still be used.
 *
 * Holidays and suspensions leave gaps, and refusing to price across a long weekend
 * would drop companies for the calendar's reasons rather than their own. Beyond this
 * the gap is large enough that the price is answering about a different week.
 */
const STALE_PRICE_DAYS = 10;

/** One judged company as it stood when the run was made. */
export interface RosterEntry {
  readonly entity: string;
  readonly label: string;
  readonly sector: string;
  readonly verdict: string;
  readonly attractiveness: number;
  /** The free baseline's ranking key. Absent when it could not be computed. */
  readonly fcfConversion?: number;
}

const addCalendarDays = (day: ISODate, days: number): ISODate => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10) as ISODate;
};

/** Trading days are about 252 a year, so a horizon in them is ~1.4 calendar days each. */
export const horizonEnd = (from: ISODate, tradingDays: number): ISODate =>
  addCalendarDays(from, Math.round(tradingDays * (365 / 252)));

/**
 * The last close at or before `on`, provided it is not stale.
 *
 * Deliberately never looks forward: a price after the target date was not knowable
 * then, and using one would quietly reintroduce the look-ahead the store exists to
 * prevent.
 */
export function priceOn(series: readonly Observation[], on: ISODate): number | undefined {
  let best: Observation | undefined;
  for (const row of series) {
    if (row.validAt > on) continue;
    if (!best || row.validAt > best.validAt) best = row;
  }
  if (!best) return undefined;
  return best.validAt >= addCalendarDays(on, -STALE_PRICE_DAYS) ? best.value : undefined;
}

export interface BucketResult {
  readonly n: number;
  readonly meanReturn: number;
  readonly medianReturn: number;
  /**
   * Priced at entry, stopped trading, never got an exit price.
   *
   * These are the names survivorship bias is made of. A pick that goes bankrupt
   * disappears from the price feed, so dropping it silently removes the worst
   * outcomes from the record and flatters everything that remains.
   */
  readonly delisted: number;
  /** Still trading, but no close near the horizon date. A data gap, not an outcome. */
  readonly gaps: number;
  /** Never had an entry price — no ticker, or none the price source covers. */
  readonly unpriced: number;
  /**
   * Mean return counting every delisted name as a total loss.
   *
   * Delisting is ambiguous: bankruptcy and acquisition both end a price series and
   * point in opposite directions, and this project has no corporate-action data to
   * tell them apart. Rather than choose, both bounds are reported — the truth is
   * between them, and the gap between them is how much the ambiguity matters.
   */
  readonly meanIfDelistedAreTotalLoss: number;
}

export interface HorizonResult {
  readonly horizon: string;
  /** Set when the price history does not reach this horizon yet. */
  readonly pending?: string;
  readonly included?: BucketResult;
  readonly excluded?: BucketResult;
  /** Included minus excluded. The number that means something. */
  readonly spread?: number;
  /** The spread on the pessimistic bound, so survivorship cannot hide inside it. */
  readonly spreadIfDelistedAreTotalLoss?: number;
  /** The same universe ranked by cash conversion alone, top N by count of included. */
  readonly baseline?: BucketResult;
  readonly baselineSpread?: number;
  /**
   * The index over the same window.
   *
   * Without it a cohort that rose is indistinguishable from a rising tide, and the
   * include-minus-exclude spread can be positive while every name lost to simply
   * owning the market.
   */
  readonly market?: { readonly symbol: string; readonly return: number };
  /** Included minus the market. Negative means the picks were not worth the trouble. */
  readonly vsMarket?: number;
}

export interface GradeReport {
  readonly runId: string;
  readonly asOf: ISODate;
  readonly questionSetVersion: string;
  readonly rosterSize: number;
  readonly priced: number;
  readonly horizons: readonly HorizonResult[];
  readonly caveats: readonly string[];
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

interface BucketReturns {
  readonly returns: number[];
  readonly delisted: number;
  readonly gaps: number;
  readonly unpriced: number;
}

const summarise = (bucket: BucketReturns): BucketResult | undefined => {
  const { returns, delisted, gaps, unpriced } = bucket;
  // Only a genuinely empty bucket reports nothing. A bucket holding only gaps or
  // only unpriced names still has something to say — that it could not measure
  // anything, and why — and swallowing that is how a count goes missing.
  if (returns.length === 0 && delisted === 0 && gaps === 0 && unpriced === 0) return undefined;

  // A delisted name counts as -1 on the pessimistic bound rather than vanishing.
  const pessimistic = [...returns, ...Array.from({ length: delisted }, () => -1)];
  return {
    n: returns.length,
    meanReturn: returns.length ? mean(returns) : 0,
    medianReturn: returns.length ? median(returns) : 0,
    delisted,
    gaps,
    unpriced,
    meanIfDelistedAreTotalLoss: pessimistic.length ? mean(pessimistic) : 0,
  };
};

/**
 * Grade one persisted run against the prices that have arrived since.
 *
 * `slice` must be taken as of today: grading reads what actually happened, which is
 * the one place in this project where later data is the point rather than a leak.
 */
export function gradeRun(
  run: { runId: string; asOf: ISODate; questionSetVersion: string; roster: readonly RosterEntry[] },
  slice: ObservationSlice,
  today: ISODate,
): GradeReport {
  const series = new Map<string, readonly Observation[]>();
  const entry = new Map<string, number>();

  for (const row of run.roster) {
    const closes = slice.series(row.entity as never, PRICE_METRIC);
    series.set(row.entity, closes);
    const at = priceOn(closes, run.asOf);
    if (at !== undefined) entry.set(row.entity, at);
  }

  const horizons = HORIZONS.map<HorizonResult>(({ label, days }) => {
    const end = horizonEnd(run.asOf, days);
    if (end > today) {
      return { horizon: label, pending: `needs closes through ${end}; today is ${today}` };
    }

    const returnsFor = (rows: readonly RosterEntry[]): BucketReturns => {
      const returns: number[] = [];
      let delisted = 0;
      let gaps = 0;
      let unpriced = 0;

      for (const row of rows) {
        const from = entry.get(row.entity);
        if (from === undefined || from <= 0) {
          unpriced++;
          continue;
        }
        const closes = series.get(row.entity) ?? [];
        const to = priceOn(closes, end);
        if (to !== undefined) {
          returns.push(to / from - 1);
          continue;
        }
        // No exit price. Distinguish a company that stopped trading from one that
        // merely has a hole at this date: the first is an outcome, the second is a
        // data problem, and conflating them is how survivorship bias gets in.
        const stillTrading = priceOn(closes, today) !== undefined;
        if (stillTrading) gaps++;
        else delisted++;
      }
      return { returns, delisted, gaps, unpriced };
    };

    const included = run.roster.filter((row) => row.verdict === "include");
    const excluded = run.roster.filter((row) => row.verdict !== "include");

    const includedReturns = returnsFor(included);
    const excludedReturns = returnsFor(excluded);

    // The free comparison: the same universe ranked by cash conversion alone, taking
    // as many names as jev included so the two are the same size.
    const ranked = run.roster
      .filter((row) => typeof row.fcfConversion === "number")
      .sort((a, b) => (b.fcfConversion ?? 0) - (a.fcfConversion ?? 0))
      .slice(0, included.length);
    const baselineReturns = returnsFor(ranked);

    const benchmark = slice.series(BENCHMARK_ENTITY as never, PRICE_METRIC);
    const marketFrom = priceOn(benchmark, run.asOf);
    const marketTo = priceOn(benchmark, end);
    const marketReturn = marketFrom !== undefined && marketTo !== undefined && marketFrom > 0
      ? marketTo / marketFrom - 1
      : undefined;

    const includedResult = summarise(includedReturns);
    const excludedResult = summarise(excludedReturns);
    const baselineResult = summarise(baselineReturns);

    return {
      horizon: label,
      ...(includedResult ? { included: includedResult } : {}),
      ...(excludedResult ? { excluded: excludedResult } : {}),
      ...(includedResult && excludedResult
        ? {
            spread: includedResult.meanReturn - excludedResult.meanReturn,
            spreadIfDelistedAreTotalLoss:
              includedResult.meanIfDelistedAreTotalLoss - excludedResult.meanIfDelistedAreTotalLoss,
          }
        : {}),
      ...(baselineResult ? { baseline: baselineResult } : {}),
      ...(baselineResult && excludedResult
        ? { baselineSpread: baselineResult.meanReturn - excludedResult.meanReturn }
        : {}),
      ...(marketReturn !== undefined ? { market: { symbol: BENCHMARK_SYMBOL, return: marketReturn } } : {}),
      ...(marketReturn !== undefined && includedResult
        ? { vsMarket: includedResult.meanReturn - marketReturn }
        : {}),
    };
  });

  return {
    runId: run.runId,
    asOf: run.asOf,
    questionSetVersion: run.questionSetVersion,
    rosterSize: run.roster.length,
    priced: entry.size,
    horizons,
    caveats: [
      "One run is one cohort. No significance can be claimed from it, and none is computed here.",
      "Overlapping holding periods across runs are autocorrelated; treat repeated cohorts as fewer independent observations than they appear.",
      "Returns are price-only. Dividends are not in this data, which understates high-yield names.",
      "Beating the cash-conversion baseline is the bar that matters. Beating zero is not.",
      `Beating ${BENCHMARK_SYMBOL} is the other bar: a positive include-minus-exclude spread can still lose to simply owning the market.`,
      "Delisted names are counted, not dropped. `meanReturn` excludes them and `meanIfDelistedAreTotalLoss` treats each as -100%; the truth is between, and a wide gap means the result turns on names that stopped trading.",
    ],
  };
}
