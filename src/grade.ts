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
}

export interface HorizonResult {
  readonly horizon: string;
  /** Set when the price history does not reach this horizon yet. */
  readonly pending?: string;
  readonly included?: BucketResult;
  readonly excluded?: BucketResult;
  /** Included minus excluded. The number that means something. */
  readonly spread?: number;
  /** The same universe ranked by cash conversion alone, top N by count of included. */
  readonly baseline?: BucketResult;
  readonly baselineSpread?: number;
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

const summarise = (returns: readonly number[]): BucketResult | undefined =>
  returns.length === 0 ? undefined : { n: returns.length, meanReturn: mean(returns), medianReturn: median(returns) };

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

    const returnsFor = (rows: readonly RosterEntry[]): number[] =>
      rows.flatMap((row) => {
        const from = entry.get(row.entity);
        const to = priceOn(series.get(row.entity) ?? [], end);
        return from !== undefined && to !== undefined && from > 0 ? [to / from - 1] : [];
      });

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

    const includedResult = summarise(includedReturns);
    const excludedResult = summarise(excludedReturns);
    const baselineResult = summarise(baselineReturns);

    return {
      horizon: label,
      ...(includedResult ? { included: includedResult } : {}),
      ...(excludedResult ? { excluded: excludedResult } : {}),
      ...(includedResult && excludedResult
        ? { spread: includedResult.meanReturn - excludedResult.meanReturn }
        : {}),
      ...(baselineResult ? { baseline: baselineResult } : {}),
      ...(baselineResult && excludedResult
        ? { baselineSpread: baselineResult.meanReturn - excludedResult.meanReturn }
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
    ],
  };
}
