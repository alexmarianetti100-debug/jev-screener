/**
 * The two jev question sets, and the assembly of their answers into a screen.
 *
 * This is where every decision in the system lives, and all of them belong to jev.
 * Look for a threshold in this file and you will not find one: inclusion is read from
 * `verdict.choice` (argmax), ordering from `attractiveness.score` (expected value).
 * There is no weighting, no cutoff and no tie-break, because each of those would be
 * this code overruling the model it was built to defer to.
 */

import { choice, score, type JsonValue, type SystemOneResult, type TypeSafeClient } from "@typesafe-ai/sdk";
import { CONTAMINATION_WINDOW_DAYS, QUESTION_SET_VERSION } from "./constants.ts";
import type { DerivedMetric, MetricRow } from "./metrics.ts";
import { daysBetween, todayISO, type Entity, type ISODate } from "./observation.ts";
import type { Distribution, PeerContext } from "./peers.ts";

export { QUESTION_SET_VERSION };

// ── Stage 2: judgment ─────────────────────────────────────────────────────────

export const judgmentQuestionSet = {
  verdict: choice("Should this company go on a list for a human analyst to review?", {
    include: "Yes — the fundamentals and the filing language together make this worth a person's time now.",
    watch: "Not now, but worth revisiting when the next filing lands.",
    exclude: "No.",
  }),

  attractiveness: score(
    "Relative to the peer distributions given, how attractive is this business as a candidate for further research?",
    [
      "Clearly worse than the peer set on the dimensions that matter here.",
      "Below the peer set, with no offsetting strength.",
      "Unremarkable against peers; neither a strength nor a concern stands out.",
      "Better than the peer set in ways that look durable rather than cyclical.",
      "Among the strongest in this peer set, with the filings supporting the numbers.",
    ],
  ),

  durability: score("How durable does the revenue growth look over the next three years?", [
    "Very likely to stall or reverse.",
    "More likely to fade than to hold.",
    "Could plausibly hold; the evidence does not settle it.",
    "Likely to hold, with identifiable reasons.",
    "Very likely to hold; the drivers are structural rather than cyclical.",
  ]),

  accountingQuality: choice("What do the accruals, working capital and disclosure language suggest about accounting quality?", {
    clean: "Cash follows earnings, working capital tracks sales, and the disclosure is plain.",
    questionable: "Something does not reconcile — accruals, receivables or inventory move in a way the narrative does not explain.",
    deteriorating: "The relationship between cash and earnings is getting worse over time.",
  }),

  dominantRisk: choice("What is the single largest risk to this business over the next three years?", {
    demand: "Customers buying less, or churning.",
    margin: "Costs, pricing power, or competitive pressure on the spread.",
    balanceSheet: "Leverage, refinancing, liquidity, or dilution.",
    regulatory: "Law, regulation, or litigation.",
    none: "No single risk dominates the others.",
  }),

  managementCandor: choice("How does management discuss problems in the MD&A and risk factors?", {
    direct: "Names specific problems, quantifies them, and says what is being done.",
    guarded: "Acknowledges issues, but in general terms that avoid specifics.",
    evasive: "Discusses results in ways that obscure the problems visible in the numbers.",
  }),

  sufficiency: choice("Was the evidence supplied enough to judge this company?", {
    sufficient: "Yes — the metrics and filing text cover what this judgment needs.",
    thin: "Judgeable, but with real gaps; treat the verdict as provisional.",
    insufficient: "No. Too much is missing to form a view, and the verdict above should not be relied on.",
  }),
} as const;

export type JudgmentResult = SystemOneResult<typeof judgmentQuestionSet>;

// ── State construction ────────────────────────────────────────────────────────

const round = (n: number): number => Number(n.toFixed(6));

/** Compact a distribution for the wire. Same shape in both stages, every call. */
const wireDistribution = (d: Distribution): Record<string, number> => ({
  count: d.count, min: round(d.min), p25: round(d.p25), median: round(d.median), p75: round(d.p75), max: round(d.max),
});

function wireMetrics(row: MetricRow): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [metric, observation] of Object.entries(row.metrics)) {
    // An absent metric is sent as null rather than omitted: "we do not know this"
    // is information jev should have, and `sufficiency` depends on seeing it.
    out[metric] = observation ? round(observation.value) : null;
  }
  return out;
}

function wirePeers(peer: PeerContext): Record<string, JsonValue> {
  const pack = (distributions: PeerContext["universe"]["distributions"]): Record<string, JsonValue> =>
    Object.fromEntries(
      Object.entries(distributions).map(([metric, d]) => [metric, d ? wireDistribution(d) : null]),
    );

  return {
    universe: { companies: peer.universe.count, distributions: pack(peer.universe.distributions) },
    sector: { name: peer.sector.name, companies: peer.sector.count, distributions: pack(peer.sector.distributions) },
  };
}

export interface FilingExcerpt {
  readonly form: string;
  readonly filedAt: ISODate;
  readonly accession: string;
  readonly mdna: string;
  readonly riskFactors: string;
}

export function buildJudgmentState(
  row: MetricRow,
  peer: PeerContext,
  filing: FilingExcerpt | undefined,
): Record<string, JsonValue> {
  return {
    company: { ticker: row.label, sector: row.sector },
    asOf: row.asOf,
    metrics: wireMetrics(row),
    valuation: row.hasPrice ? "Multiples included in metrics above." : "No price data available; multiples are absent.",
    peers: wirePeers(peer),
    filing: filing
      ? { form: filing.form, filed: filing.filedAt, accession: filing.accession, mdAndA: filing.mdna, riskFactors: filing.riskFactors }
      : null,
  };
}

// ── The calls ─────────────────────────────────────────────────────────────────


export function askJudgment(
  client: TypeSafeClient,
  row: MetricRow,
  peer: PeerContext,
  filing: FilingExcerpt | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<JudgmentResult> {
  return client.systemOne({ state: buildJudgmentState(row, peer, filing), questions: judgmentQuestionSet }, options);
}

// ── Assembly ──────────────────────────────────────────────────────────────────

export interface Judged {
  readonly entity: Entity;
  /** The symbol to show a human. A filer with no ticker shows as its CIK. */
  readonly label: string;
  readonly sector: string;
  readonly result: JudgmentResult;
  readonly fromCache: boolean;
  readonly metrics: Readonly<Partial<Record<DerivedMetric, number>>>;
}

export interface Pick {
  readonly entity: Entity;
  readonly label: string;
  readonly sector: string;
  readonly verdict: JudgmentResult["answers"]["verdict"];
  readonly attractiveness: JudgmentResult["answers"]["attractiveness"];
  readonly answers: JudgmentResult["answers"];
  readonly fromCache: boolean;
}

/**
 * Turn judgments into the screen.
 *
 * Inclusion is `verdict.choice`, with one exception jev also owns: a company it
 * marked `sufficiency: insufficient` is dropped, because it told us its own verdict
 * should not be relied on. Ordering is `attractiveness.score`, descending. Equal
 * scores keep the order jev returned them in — an invented tie-break would be this
 * code ranking companies, which is exactly what it must not do.
 */
export function assemble(judged: readonly Judged[]): Pick[] {
  const included = judged.filter(
    (j) => j.result.answers.verdict.choice === "include" && j.result.answers.sufficiency.choice !== "insufficient",
  );

  // Array.prototype.sort is stable in Node, so ties preserve input order.
  return [...included]
    .sort((a, b) => b.result.answers.attractiveness.score - a.result.answers.attractiveness.score)
    .map((j) => ({
      entity: j.entity,
      label: j.label,
      sector: j.sector,
      verdict: j.result.answers.verdict,
      attractiveness: j.result.answers.attractiveness,
      answers: j.result.answers,
      fromCache: j.fromCache,
    }));
}

// ── Contamination ─────────────────────────────────────────────────────────────

export class ContaminatedRunError extends Error {
  readonly asOf: ISODate;
  readonly daysStale: number;

  constructor(asOf: ISODate, daysStale: number) {
    super(
      `asOf ${asOf} is ${daysStale} days in the past (limit ${CONTAMINATION_WINDOW_DAYS}). ` +
        "jev may already know what happened after those filings, so this run would measure hindsight, not skill. " +
        "Pass allowContaminated: true to run it anyway; every result will be stamped contaminated.",
    );
    this.name = "ContaminatedRunError";
    this.asOf = asOf;
    this.daysStale = daysStale;
  }
}

export interface RunStamp {
  readonly asOf: ISODate;
  readonly contaminated: boolean;
  readonly daysStale: number;
  readonly notice?: string;
}

/**
 * Decide whether a run against `asOf` is honest, and stamp it either way.
 *
 * There is no deterministic component in this screener, so a historical run cannot
 * be a backtest — jev's training data may already contain the outcome. Refusing by
 * default is the only way that limitation stays visible.
 */
export function assertRunnable(
  asOf: ISODate,
  allowContaminated: boolean,
  today: ISODate = todayISO(),
): RunStamp {
  const daysStale = daysBetween(asOf, today);
  if (daysStale <= CONTAMINATION_WINDOW_DAYS) return { asOf, contaminated: false, daysStale };
  if (!allowContaminated) throw new ContaminatedRunError(asOf, daysStale);

  return {
    asOf,
    contaminated: true,
    daysStale,
    notice:
      `CONTAMINATED: asOf ${asOf} is ${daysStale} days old. jev may know what happened next. ` +
      "These results must not be used to evaluate the screener's performance.",
  };
}
