import assert from "node:assert/strict";
import test from "node:test";
import { computeMetrics } from "./metrics.ts";
import { cik,buildSlice, isoDate, observation, ticker, type Observation } from "./observation.ts";

const ACME = cik("320193");
const ASOF = isoDate("2026-09-01");

/** Eight quarter-ends, oldest first, all filed 30 days after the period closed. */
const QUARTERS = [
  "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30",
  "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30",
] as const;

const filedAfter = (period: string): string => {
  const d = new Date(`${period}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
};

const flow = (metric: string, values: readonly number[]): Observation[] =>
  values.map((value, i) =>
    observation({
      value, metric, entity: ACME,
      validAt: isoDate(QUARTERS[i]!), knownAt: isoDate(filedAfter(QUARTERS[i]!)),
      source: "edgar:10-Q:x", reliability: "reported",
    }),
  );

const instant = (metric: string, value: number, period = "2026-06-30"): Observation =>
  observation({
    value, metric, entity: ACME,
    validAt: isoDate(period), knownAt: isoDate(filedAfter(period)),
    source: "edgar:10-Q:x", reliability: "reported",
  });

/** A company with four prior quarters at 100 and four current at 110. */
function baseline(): Observation[] {
  return [
    ...flow("revenue", [100, 100, 100, 100, 110, 110, 110, 110]),
    ...flow("grossProfit", [40, 40, 40, 40, 48, 48, 48, 48]),
    ...flow("operatingIncome", [20, 20, 20, 20, 24, 24, 24, 24]),
    ...flow("netIncome", [10, 10, 10, 10, 12, 12, 12, 12]),
    ...flow("operatingCashFlow", [15, 15, 15, 15, 18, 18, 18, 18]),
    ...flow("capex", [5, 5, 5, 5, 6, 6, 6, 6]),
    ...flow("depreciationAndAmortization", [4, 4, 4, 4, 4, 4, 4, 4]),
    instant("totalAssets", 1000),
    instant("totalLiabilities", 400),
    instant("cash", 100),
    instant("longTermDebt", 200),
  ];
}

const compute = (rows: Observation[]) => computeMetrics(buildSlice(rows, ASOF), ACME, "manufacturing", "ACME");

test("TTM growth compares the last four quarters with the four before", () => {
  const row = compute(baseline());
  // 440 vs 400.
  assert.equal(row.metrics.revenueGrowthTtm?.value.toFixed(4), "0.1000");
});

test("margins are TTM ratios and their trend is the change in the ratio", () => {
  const row = compute(baseline());
  assert.equal(row.metrics.grossMargin?.value.toFixed(6), (192 / 440).toFixed(6));
  assert.equal(row.metrics.operatingMargin?.value.toFixed(6), (96 / 440).toFixed(6));
  // 48/44% now vs 40% before.
  assert.equal(row.metrics.grossMarginTrend?.value.toFixed(6), (192 / 440 - 160 / 400).toFixed(6));
});

test("FCF conversion nets capex out of operating cash flow", () => {
  const row = compute(baseline());
  // (72 - 24) / 48.
  assert.equal(row.metrics.fcfConversion?.value.toFixed(6), (48 / 48).toFixed(6));
});

test("net debt over EBITDA adds depreciation back to operating income", () => {
  const row = compute(baseline());
  // net debt 200 - 100 = 100; EBITDA 96 + 16 = 112.
  assert.equal(row.metrics.netDebtToEbitda?.value.toFixed(6), (100 / 112).toFixed(6));
});

test("the accrual ratio is the gap between earnings and cash, over assets", () => {
  const row = compute(baseline());
  // (48 - 72) / 1000.
  assert.equal(row.metrics.accrualRatio?.value.toFixed(6), (-24 / 1000).toFixed(6));
});

test("a missing input means a missing metric, never a substituted one", () => {
  const withoutDepreciation = baseline().filter((o) => o.metric !== "depreciationAndAmortization");
  const row = compute(withoutDepreciation);

  assert.equal(row.metrics.netDebtToEbitda, undefined);
  assert.ok(row.metrics.revenueGrowthTtm, "unrelated metrics still compute");
});

test("multiples appear only once a price exists", () => {
  const withoutPrice = compute(baseline());
  assert.equal(withoutPrice.hasPrice, false);
  assert.equal(withoutPrice.metrics.priceToEarnings, undefined);

  const withPrice = compute([
    ...baseline(),
    ...flow("sharesOutstanding", [10, 10, 10, 10, 10, 10, 10, 10]),
    observation({
      value: 24, metric: "close", entity: ACME,
      validAt: isoDate("2026-08-28"), knownAt: isoDate("2026-08-28"),
      source: "stooq", reliability: "market",
    }),
  ]);

  assert.equal(withPrice.hasPrice, true);
  // Market cap 240 over TTM net income 48.
  assert.equal(withPrice.metrics.priceToEarnings?.value.toFixed(4), "5.0000");
  // A price is market data, so the multiple can be no better than that.
  assert.equal(withPrice.metrics.priceToEarnings?.reliability, "market");
});

test("a loss-making company gets no P/E rather than a negative one", () => {
  const lossMaking = [
    ...baseline().filter((o) => o.metric !== "netIncome"),
    ...flow("netIncome", [-10, -10, -10, -10, -12, -12, -12, -12]),
    ...flow("sharesOutstanding", [10, 10, 10, 10, 10, 10, 10, 10]),
    observation({
      value: 24, metric: "close", entity: ACME,
      validAt: isoDate("2026-08-28"), knownAt: isoDate("2026-08-28"),
      source: "stooq", reliability: "market",
    }),
  ];

  assert.equal(compute(lossMaking).metrics.priceToEarnings, undefined);
});

test("too little history means no trend metrics", () => {
  const short = flow("revenue", [100, 110, 120]);
  const row = compute(short);

  assert.equal(row.metrics.revenueGrowthTtm, undefined);
  assert.equal(row.metrics.revenueCagr3y, undefined);
});

test("every computed metric keeps the provenance of what produced it", () => {
  const row = compute(baseline());
  const margin = row.metrics.grossMargin;

  assert.ok(margin);
  assert.equal(margin.entity, ACME);
  assert.equal(margin.knownAt, filedAfter("2026-06-30"));
  assert.ok(margin.source.includes("edgar"));
});

test("dated obligations are levels, and absent is a fact rather than a gap", () => {
  const rows = [
    ...flow("revenue", [250, 250, 250, 250]),
    instant("cash", 400), instant("debtDueYear1", 100), instant("debtDueYear2", 300),
    instant("remainingPerformanceObligation", 2000),
  ];
  const row = computeMetrics(buildSlice(rows, ASOF), ACME, "services", "ACME");

  assert.equal(row.obligations["debtDueYear1"], 100);
  assert.equal(row.obligations["debtDueYear2"], 300);
  // Two years of revenue already contracted — the clearest horizon signal available.
  assert.equal(row.obligations["yearsOfRevenueContracted"], 2);
  assert.equal(row.obligations["cashCoverOfNextYearDebt"], 4);
  // Most filers publish no lease schedule, and saying so is information.
  assert.equal(row.obligations["leaseDueYear1"], null);
});

test("a coverage ratio is not invented when its denominator is missing", () => {
  const row = computeMetrics(
    buildSlice([...flow("revenue", [10, 10, 10, 10]), instant("debtDueYear1", 0)], ASOF),
    ACME, "services", "ACME",
  );
  // Zero debt due is not infinite coverage; it is a ratio that should not exist.
  assert.equal(row.obligations["cashCoverOfNextYearDebt"], null);
  assert.equal(row.obligations["yearsOfRevenueContracted"], null);
});

// ── Price behaviour ───────────────────────────────────────────────────────────

/** `n` daily closes ending today, newest last, from a generator over the index. */
const closes = (n: number, priceAt: (i: number) => number): Observation[] =>
  Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.UTC(2024, 0, 2));
    day.setUTCDate(day.getUTCDate() + i);
    const iso = isoDate(day.toISOString());
    return observation({
      value: priceAt(i), metric: "close", entity: ACME,
      validAt: iso, knownAt: iso, source: "polygon", reliability: "market",
    });
  });

const priced = (rows: Observation[]) =>
  computeMetrics(buildSlice([...flow("revenue", [10, 10, 10, 10]), ...rows], isoDate("2026-12-31")), ACME, "services", "ACME");

test("momentum skips the most recent month, because reversal runs against it", () => {
  // Flat for a year, then a sharp spike only in the final month. Twelve-month
  // momentum must not see the spike; three-month momentum must.
  const row = priced(closes(300, (i) => (i < 279 ? 100 : 200)));

  assert.equal(row.metrics.momentum12m1?.value, 0, "the spike is inside the skipped month");
  assert.ok((row.metrics.momentum3m?.value ?? 0) > 0.9, "but three-month momentum sees it");
});

test("a company without enough history has no momentum, rather than a made-up one", () => {
  const row = priced(closes(30, () => 100));

  assert.equal(row.metrics.momentum12m1, undefined, "three weeks is not a year");
  assert.equal(row.metrics.momentum6m, undefined);
  assert.equal(row.metrics.drawdownFrom52wHigh, undefined);
  assert.equal(row.metrics.priceToMovingAverage200, undefined);
});

test("drawdown is measured from the high and is never positive", () => {
  // Rises to 200, ends at 150: a quarter below the high.
  const row = priced(closes(300, (i) => (i < 150 ? 100 + i * 0.67 : 150)));
  const drawdown = row.metrics.drawdownFrom52wHigh?.value;

  assert.ok(drawdown !== undefined);
  assert.ok(drawdown < 0, "below the high");
  // A company sitting at its own high is flat, not up from it.
  assert.equal(priced(closes(300, (i) => 100 + i)).metrics.drawdownFrom52wHigh?.value, 0);
});

test("the 200-day average distinguishes trending from recovering", () => {
  const above = priced(closes(300, (i) => 100 + i)).metrics.priceToMovingAverage200?.value ?? 0;
  const below = priced(closes(300, (i) => 400 - i)).metrics.priceToMovingAverage200?.value ?? 0;

  assert.ok(above > 1, "rising: price above its average");
  assert.ok(below < 1, "falling: price below it");
});

test("volatility is annualised, so it reads beside the returns", () => {
  const calm = priced(closes(300, () => 100)).metrics.volatility90d?.value ?? -1;
  const choppy = priced(closes(300, (i) => (i % 2 === 0 ? 100 : 130))).metrics.volatility90d?.value ?? 0;

  assert.equal(calm, 0, "a flat line has no volatility");
  assert.ok(choppy > 1, "a 30% daily swing annualises to something large");
});

test("price facts carry provenance like every other number", () => {
  const row = priced(closes(300, (i) => 100 + i));
  const momentum = row.metrics.momentum12m1;

  assert.ok(momentum);
  // The point of computing these here rather than fetching them: a knownAt that can
  // be defended, and inputs that can be pointed at.
  assert.ok(momentum.knownAt, "knowable on a date");
  assert.equal(momentum.reliability, "market");
});
