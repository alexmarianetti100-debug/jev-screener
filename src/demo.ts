/**
 * The whole pipeline, on fixtures, with no keys and no network.
 *
 * Reproducing this project properly needs three credentials, one of which is a
 * model with a single exposed build. That is a real barrier for anyone who wants to
 * see what it does before deciding whether to care, and "read the tests" is not an
 * answer — tests assert, they do not show.
 *
 * So this runs the real `runScreen` against an in-memory store holding three
 * hand-built companies and a stubbed model, and prints what a screen looks like. The
 * pipeline is not mocked: eligibility, metrics, peer distributions, the point-in-time
 * slice, caching, assembly and persistence all execute exactly as they do live. Only
 * the two things that cost money are replaced.
 *
 * The stub is deliberately mechanical — it reads one metric and maps it to a verdict —
 * so nothing here should be mistaken for what jev actually does. It demonstrates the
 * shape of the output, not the quality of the judgment.
 */

import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { createClient } from "./client.ts";
import type { EdgarClient } from "./edgar.ts";
import { cik, isoDate, observation, type Entity, type ISODate, type Observation } from "./observation.ts";
import type { PriceClient } from "./prices.ts";
import { openStore, type Store } from "./store.ts";
import type { FilerProfile } from "./universe.ts";

interface DemoCompany {
  readonly cik: number;
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly sic: string;
  /** Quarterly revenue, oldest first. Twelve quarters clears the eligibility bar. */
  readonly revenue: readonly number[];
  readonly margin: number;
  readonly cashConversion: number;
  readonly close: number;
}

const COMPANIES: readonly DemoCompany[] = [
  {
    cik: 1000001, ticker: "GOODCO", name: "Good Company Inc.", sector: "services", sic: "7372",
    revenue: [100, 106, 112, 119, 126, 134, 142, 150, 159, 169, 179, 190],
    margin: 0.32, cashConversion: 1.15, close: 120,
  },
  {
    cik: 1000002, ticker: "FLATCO", name: "Flat Company Inc.", sector: "services", sic: "7372",
    revenue: [200, 201, 199, 202, 200, 203, 199, 201, 200, 202, 198, 201],
    margin: 0.11, cashConversion: 0.82, close: 40,
  },
  {
    cik: 1000003, ticker: "SLIDECO", name: "Sliding Company Inc.", sector: "services", sic: "7372",
    revenue: [300, 292, 284, 275, 266, 255, 244, 232, 221, 209, 196, 184],
    margin: 0.04, cashConversion: 0.41, close: 9,
  },
];

/**
 * Twelve quarter-ends counting back from the last one whose filing would already have
 * landed, derived from the clock rather than hard-coded.
 *
 * A fixed list rots: written today it dates the newest filing in the future, which
 * eligibility correctly rejects, and a demo that silently screens nothing is worse
 * than no demo. Deriving it means this still works in five years.
 */
function quarterEnds(today: Date): string[] {
  // Filings land about 35 days after a period closes, so step back far enough that
  // the newest one is comfortably in the past.
  const cursor = new Date(today);
  cursor.setUTCDate(cursor.getUTCDate() - 50);

  const endOfQuarter = (d: Date): Date => {
    const month = [2, 5, 8, 11].find((m) => m >= d.getUTCMonth()) ?? 2;
    const year = month < d.getUTCMonth() ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
    return new Date(Date.UTC(year, month + 1, 0));
  };

  let end = endOfQuarter(cursor);
  if (end > cursor) end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 0));

  const ends: string[] = [];
  for (let i = 0; i < 12; i++) {
    ends.unshift(end.toISOString().slice(0, 10));
    end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 0));
  }
  return ends;
}

const QUARTER_ENDS: readonly string[] = quarterEnds(new Date());

/** Filings land after the period they describe, which is what `knownAt` records. */
const filedAfter = (period: string): ISODate => {
  const date = new Date(`${period}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 35);
  return isoDate(date.toISOString());
};

function observationsFor(company: DemoCompany): Observation[] {
  const entity = cik(company.cik) as Entity;
  const rows: Observation[] = [];

  const flow = (metric: string, values: readonly number[]): void => {
    values.forEach((value, index) => {
      const end = QUARTER_ENDS[index];
      if (!end) return;
      rows.push(observation({
        value, metric, entity, validAt: isoDate(end), knownAt: filedAfter(end),
        source: `edgar:10-Q:demo-${index}`, reliability: "reported",
      }));
    });
  };

  const instant = (metric: string, value: number): void => {
    const end = QUARTER_ENDS.at(-1)!;
    rows.push(observation({
      value, metric, entity, validAt: isoDate(end), knownAt: filedAfter(end),
      source: "edgar:10-K:demo", reliability: "audited",
    }));
  };

  flow("revenue", company.revenue);
  flow("grossProfit", company.revenue.map((r) => r * (company.margin + 0.2)));
  flow("operatingIncome", company.revenue.map((r) => r * company.margin));
  flow("netIncome", company.revenue.map((r) => r * company.margin * 0.75));
  flow("operatingCashFlow", company.revenue.map((r) => r * company.margin * 0.75 * company.cashConversion));
  flow("capex", company.revenue.map((r) => r * 0.03));

  instant("totalAssets", company.revenue.at(-1)! * 8);
  instant("totalLiabilities", company.revenue.at(-1)! * 3);
  instant("cash", company.revenue.at(-1)! * 1.5);
  instant("longTermDebt", company.revenue.at(-1)! * 0.8);
  instant("sharesOutstanding", 1_000);
  instant("receivables", company.revenue.at(-1)! * 0.9);
  instant("inventory", company.revenue.at(-1)! * 0.4);
  instant("debtDueYear1", company.revenue.at(-1)! * 0.1);

  return rows;
}

function profileFor(company: DemoCompany): FilerProfile {
  const recent = QUARTER_ENDS.at(-1)!;
  return {
    entity: cik(company.cik) as Entity,
    cik: cik(company.cik),
    tickers: [company.ticker as never],
    name: company.name,
    sic: company.sic,
    sector: company.sector,
    filings: [
      { form: "10-K", filedAt: filedAfter(recent), accession: "0001-26-000001", primaryDocument: "demo-10k.htm" },
      { form: "10-Q", filedAt: filedAfter(recent), accession: "0001-26-000002", primaryDocument: "demo-10q.htm" },
    ],
  };
}

/**
 * A stub standing in for jev, keyed off one metric.
 *
 * Mechanical on purpose. jev weighs seven questions against peer distributions and a
 * filing; this reads revenue growth and picks a lane. It shows the shape of an answer
 * and nothing about the quality of one.
 */
function stubModel(): TypeSafeClient {
  const choice = (value: string, probabilities: Record<string, number>) =>
    ({ type: "choice", choice: value, confidence: probabilities[value] ?? 0.9, probabilities });
  const score = (value: number) =>
    ({ type: "score", score: value, confidence: 0.8, legend: {}, probabilities: {} });

  return createClient({
    apiKey: "demo", retry: { maxRetries: 0 },
    fetch: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: { metrics?: Record<string, number | null> } };
      const growth = body.state.metrics?.["revenueGrowthTtm"] ?? 0;
      const verdict = growth > 0.1 ? "include" : growth > -0.05 ? "watch" : "exclude";

      return Response.json({
        model: "demo-stub",
        answers: {
          verdict: choice(verdict, { include: 0.7, watch: 0.2, exclude: 0.1 }),
          attractiveness: score(growth > 0.1 ? 3.8 : growth > -0.05 ? 2.0 : 0.6),
          durability: score(growth > 0.1 ? 3.1 : 1.2),
          accountingQuality: choice(growth > 0 ? "clean" : "questionable", { clean: 0.8, questionable: 0.15, deteriorating: 0.05 }),
          dominantRisk: choice("demand", { demand: 0.6, margin: 0.2, balanceSheet: 0.1, regulatory: 0.05, none: 0.05 }),
          managementCandor: choice("guarded", { direct: 0.3, guarded: 0.6, evasive: 0.1 }),
          horizonDriver: choice("nextPrint", { nextPrint: 0.6, contracted: 0.1, balanceSheet: 0.1, regulatory: 0.1, structural: 0.1 }),
          horizonBand: score(1.8),
          sufficiency: choice("sufficient", { sufficient: 0.85, thin: 0.12, insufficient: 0.03 }),
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    },
  });
}

/** Closes for the demo tickers. No network, and the same shape the real client returns. */
const stubPrices = (): PriceClient => ({
  async dailyCloses() {
    return new Map(COMPANIES.map((c) => [c.ticker as never, c.close]));
  },
});

/**
 * EDGAR, answering with nothing.
 *
 * Returning empty text rather than throwing, because judging without filing text is a
 * supported state — it is what a live run does for a filer whose document cannot be
 * fetched — and a demo that prints three failures teaches the reader to ignore the
 * failure list.
 */
const stubEdgar = (): EdgarClient => ({
  async getJson() { throw new Error("demo mode does not reach EDGAR"); },
  async getText() { return ""; },
  async download() { throw new Error("demo mode does not reach EDGAR"); },
});

/** Build an in-memory store holding the fixture companies. */
export async function seedDemoStore(): Promise<Store> {
  const store = await openStore(":memory:");
  await store.saveFilers(COMPANIES.map(profileFor));
  await store.appendObservations(COMPANIES.flatMap(observationsFor));
  return store;
}

export const demoClients = (): {
  client: TypeSafeClient; prices: PriceClient; edgar: EdgarClient;
} => ({ client: stubModel(), prices: stubPrices(), edgar: stubEdgar() });
