/**
 * Arithmetic. No judgment.
 *
 * Every function here answers "what is this number", never "is this number good".
 * There are no thresholds, no weights and no rankings in this file, and there must
 * not be: the moment a metric decides something, the design is broken.
 *
 * Flow metrics (revenue, net income, cash flows) are stored quarterly by the
 * ingester, so a trailing-twelve-month figure is the sum of the last four periods.
 * Stock metrics (assets, cash, share count) are instants and are read directly.
 */

import { derive, type ISODate, type Observation, type ObservationSlice, type Entity, PRICE_METRIC } from "./observation.ts";

/** Metric ids produced by this module, in display order. */
export const DERIVED_METRICS = [
  "revenueGrowthTtm", "revenueCagr3y",
  "grossMargin", "grossMarginTrend",
  "operatingMargin", "operatingMarginTrend",
  "fcfConversion", "preTaxRoic", "netDebtToEbitda",
  "shareCountChange1y", "accrualRatio",
  "receivablesGrowthVsRevenue", "inventoryGrowthVsRevenue",
  "priceToEarnings", "evToEbit",
] as const;
export type DerivedMetric = (typeof DERIVED_METRICS)[number];

/** One company's computed picture at a point in time. Absent metrics stay absent. */
export interface MetricRow {
  readonly entity: Entity;
  /** The symbol a human — and jev — should see. Never the CIK, unless there is none. */
  readonly label: string;
  readonly sector: string;
  readonly asOf: ISODate;
  readonly metrics: Readonly<Partial<Record<DerivedMetric, Observation>>>;
  /** Raw inputs kept for `explain_pick`, so every derived number can be traced. */
  readonly inputs: readonly Observation[];
  /** True when price was available, so multiples could be computed. */
  readonly hasPrice: boolean;
}

// ── Calendar arithmetic ───────────────────────────────────────────────────────
// These are definitional, not tunable: they say what "trailing twelve months" and
// "three-year CAGR" MEAN. Changing one does not make a company look better or
// worse — it computes a different metric. They are deliberately not in
// constants.ts, which is reserved for parameters an operator may actually turn.

/** Quarters in a trailing-twelve-month window. */
const QUARTERS_PER_YEAR = 4;
/** Years spanned by the long-run growth metric. */
const CAGR_YEARS = 3;
/** Quarters in the CAGR lookback. */
const CAGR_QUARTERS = QUARTERS_PER_YEAR * CAGR_YEARS;
/** Endpoints of a one-year window: this quarter and the same quarter last year. */
const YEAR_OVER_YEAR_WINDOW = QUARTERS_PER_YEAR + 1;

// ── Small helpers over quarterly series ───────────────────────────────────────

/** The `n` most recent periods, oldest first, or `undefined` if there are not `n`. */
function lastN(series: readonly Observation[], n: number): readonly Observation[] | undefined {
  return series.length >= n ? series.slice(-n) : undefined;
}

/** Trailing twelve months ending at `offset` quarters back from the latest. */
function ttm(series: readonly Observation[], offset = 0): readonly Observation[] | undefined {
  const end = series.length - offset;
  return end >= QUARTERS_PER_YEAR ? series.slice(end - QUARTERS_PER_YEAR, end) : undefined;
}

const sumOf = (window: readonly Observation[]): number =>
  window.reduce((total, o) => total + o.value, 0);

/**
 * Divide, returning `undefined` rather than infinity or a sign flip.
 *
 * A ratio with a negative or zero denominator is not a small number, it is a
 * meaningless one — a P/E on a loss-making company being the classic trap. Refusing
 * to produce it is what lets jev see "no value" instead of a misleading one.
 */
function safeRatio(numerator: number, denominator: number, { allowNegative = false } = {}): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
  if (denominator === 0) return undefined;
  if (!allowNegative && denominator < 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : undefined;
}

/** Compound annual growth rate over `years`, or `undefined` if the base is not positive. */
function cagr(latest: number, earliest: number, years: number): number | undefined {
  if (earliest <= 0 || latest <= 0 || years <= 0) return undefined;
  return (latest / earliest) ** (1 / years) - 1;
}

// ── The computation ───────────────────────────────────────────────────────────

/**
 * Compute every metric that this company's data supports as of the slice date.
 *
 * Missing inputs mean a missing metric, never a substituted one. jev is told what is
 * absent and decides what to make of it; filling a gap with a default here would be
 * a judgment wearing arithmetic's clothes.
 */
export function computeMetrics(slice: ObservationSlice, entity: Entity, sector: string, label: string): MetricRow {
  const metrics: Partial<Record<DerivedMetric, Observation>> = {};
  const inputs: Observation[] = [];

  const series = (metric: string): readonly Observation[] => {
    const rows = slice.series(entity, metric);
    inputs.push(...rows);
    return rows;
  };
  const latest = (metric: string): Observation | undefined => {
    const row = slice.latest(entity, metric);
    if (row) inputs.push(row);
    return row;
  };

  const put = (metric: DerivedMetric, value: number | undefined, from: readonly Observation[]): void => {
    if (value === undefined || !Number.isFinite(value) || from.length === 0) return;
    metrics[metric] = derive(value, metric, from);
  };

  // Flows, quarterly.
  const revenue = series("revenue");
  const grossProfit = series("grossProfit");
  const operatingIncome = series("operatingIncome");
  const netIncome = series("netIncome");
  const operatingCashFlow = series("operatingCashFlow");
  const capex = series("capex");
  const depreciation = series("depreciationAndAmortization");

  // Instants.
  const totalAssets = latest("totalAssets");
  const totalLiabilities = latest("totalLiabilities");
  const cash = latest("cash");
  const longTermDebt = latest("longTermDebt");
  const sharesSeries = series("sharesOutstanding");
  const receivables = series("receivables");
  const inventory = series("inventory");

  // ── Growth ──
  const revenueTtm = ttm(revenue);
  const revenueTtmPrior = ttm(revenue, QUARTERS_PER_YEAR);
  if (revenueTtm && revenueTtmPrior) {
    const now = sumOf(revenueTtm);
    const prior = sumOf(revenueTtmPrior);
    put("revenueGrowthTtm", safeRatio(now - prior, Math.abs(prior), { allowNegative: true }), [...revenueTtm, ...revenueTtmPrior]);
  }

  const revenueTtm3yAgo = ttm(revenue, CAGR_QUARTERS);
  if (revenueTtm && revenueTtm3yAgo) {
    put("revenueCagr3y", cagr(sumOf(revenueTtm), sumOf(revenueTtm3yAgo), CAGR_YEARS), [...revenueTtm, ...revenueTtm3yAgo]);
  }

  // ── Margins and their direction ──
  const marginPair = (
    numeratorSeries: readonly Observation[],
    level: DerivedMetric,
    trend: DerivedMetric,
  ): void => {
    const numTtm = ttm(numeratorSeries);
    if (numTtm && revenueTtm) {
      put(level, safeRatio(sumOf(numTtm), sumOf(revenueTtm)), [...numTtm, ...revenueTtm]);
    }
    const numPrior = ttm(numeratorSeries, QUARTERS_PER_YEAR);
    if (numTtm && revenueTtm && numPrior && revenueTtmPrior) {
      const nowMargin = safeRatio(sumOf(numTtm), sumOf(revenueTtm));
      const priorMargin = safeRatio(sumOf(numPrior), sumOf(revenueTtmPrior));
      if (nowMargin !== undefined && priorMargin !== undefined) {
        put(trend, nowMargin - priorMargin, [...numTtm, ...revenueTtm, ...numPrior, ...revenueTtmPrior]);
      }
    }
  };
  marginPair(grossProfit, "grossMargin", "grossMarginTrend");
  marginPair(operatingIncome, "operatingMargin", "operatingMarginTrend");

  // ── Cash conversion ──
  const ocfTtm = ttm(operatingCashFlow);
  const capexTtm = ttm(capex);
  const netIncomeTtm = ttm(netIncome);
  if (ocfTtm && capexTtm && netIncomeTtm) {
    // capex is stored as a positive outflow magnitude by the ingester.
    const freeCashFlow = sumOf(ocfTtm) - sumOf(capexTtm);
    put("fcfConversion", safeRatio(freeCashFlow, sumOf(netIncomeTtm)), [...ocfTtm, ...capexTtm, ...netIncomeTtm]);
  }

  // ── Returns ──
  const operatingIncomeTtm = ttm(operatingIncome);
  if (operatingIncomeTtm && totalAssets && totalLiabilities && cash) {
    const equity = totalAssets.value - totalLiabilities.value;
    const investedCapital = equity + (longTermDebt?.value ?? 0) - cash.value;
    const from = [...operatingIncomeTtm, totalAssets, totalLiabilities, cash];
    if (longTermDebt) from.push(longTermDebt);
    // Pre-tax: companyfacts gives no reliable effective tax rate at this granularity.
    put("preTaxRoic", safeRatio(sumOf(operatingIncomeTtm), investedCapital), from);
  }

  // ── Leverage ──
  const depreciationTtm = ttm(depreciation);
  if (operatingIncomeTtm && depreciationTtm && cash) {
    const ebitda = sumOf(operatingIncomeTtm) + sumOf(depreciationTtm);
    const netDebt = (longTermDebt?.value ?? 0) - cash.value;
    const from = [...operatingIncomeTtm, ...depreciationTtm, cash];
    if (longTermDebt) from.push(longTermDebt);
    put("netDebtToEbitda", safeRatio(netDebt, ebitda, { allowNegative: false }), from);
  }

  // ── Dilution ──
  const sharesWindow = lastN(sharesSeries, YEAR_OVER_YEAR_WINDOW);
  if (sharesWindow) {
    const now = sharesWindow.at(-1)!;
    const yearAgo = sharesWindow[0]!;
    put("shareCountChange1y", safeRatio(now.value - yearAgo.value, yearAgo.value), [now, yearAgo]);
  }

  // ── Earnings quality ──
  if (netIncomeTtm && ocfTtm && totalAssets) {
    put("accrualRatio", safeRatio(sumOf(netIncomeTtm) - sumOf(ocfTtm), totalAssets.value), [...netIncomeTtm, ...ocfTtm, totalAssets]);
  }

  // ── Working capital growing faster than sales ──
  const growthGap = (
    stockSeries: readonly Observation[],
    metric: DerivedMetric,
  ): void => {
    const window = lastN(stockSeries, YEAR_OVER_YEAR_WINDOW);
    if (!window || !revenueTtm || !revenueTtmPrior) return;
    const now = window.at(-1)!;
    const yearAgo = window[0]!;
    const stockGrowth = safeRatio(now.value - yearAgo.value, yearAgo.value);
    const revenueGrowth = safeRatio(sumOf(revenueTtm) - sumOf(revenueTtmPrior), Math.abs(sumOf(revenueTtmPrior)), { allowNegative: true });
    if (stockGrowth === undefined || revenueGrowth === undefined) return;
    put(metric, stockGrowth - revenueGrowth, [now, yearAgo, ...revenueTtm, ...revenueTtmPrior]);
  };
  growthGap(receivables, "receivablesGrowthVsRevenue");
  growthGap(inventory, "inventoryGrowthVsRevenue");

  // ── Multiples, only when a price exists ──
  const price = latest(PRICE_METRIC);
  const sharesNow = sharesSeries.at(-1);
  const hasPrice = price !== undefined;

  if (price && sharesNow) {
    const marketCap = price.value * sharesNow.value;

    if (netIncomeTtm) {
      put("priceToEarnings", safeRatio(marketCap, sumOf(netIncomeTtm)), [price, sharesNow, ...netIncomeTtm]);
    }
    if (operatingIncomeTtm && cash) {
      const enterpriseValue = marketCap + (longTermDebt?.value ?? 0) - cash.value;
      const from = [price, sharesNow, ...operatingIncomeTtm, cash];
      if (longTermDebt) from.push(longTermDebt);
      put("evToEbit", safeRatio(enterpriseValue, sumOf(operatingIncomeTtm)), from);
    }
  }

  return { entity, label, sector, asOf: slice.asOf, metrics, inputs, hasPrice };
}
