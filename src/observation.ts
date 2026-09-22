/**
 * The unit of data in this project.
 *
 * Rule: no bare numbers in the domain layer. Every figure carries where it came
 * from, what period it describes, and when it became knowable — because a screener
 * that cannot tell you *when it could have known* a number cannot be trusted about
 * anything else.
 */

// ── Branded units ─────────────────────────────────────────────────────────────
// Erasable at runtime; they exist to stop a share count being divided by a dollar.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type USD = Brand<number, "USD">;
export type Shares = Brand<number, "Shares">;
export type Ratio = Brand<number, "Ratio">;
/** `YYYY-MM-DD`. */
export type ISODate = Brand<string, "ISODate">;
export type Ticker = Brand<string, "Ticker">;
/** Ten digits, zero-padded, as EDGAR expects. */
export type CIK = Brand<string, "CIK">;

/**
 * What an observation is keyed on.
 *
 * The CIK, never the ticker. Tickers are display labels: they get reassigned, a
 * company can carry four of them at once, and SEC's own ticker file can point a
 * familiar symbol at the wrong filer. A store keyed on tickers silently inherits
 * every one of those problems. Tickers live in their own lookup table.
 */
export type Entity = CIK;

export const usd = (n: number): USD => n as USD;
export const shares = (n: number): Shares => n as Shares;
export const ratio = (n: number): Ratio => n as Ratio;
export const ticker = (s: string): Ticker => s.trim().toUpperCase() as Ticker;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(s: string): ISODate {
  const trimmed = s.slice(0, 10);
  if (!ISO_DATE.test(trimmed)) throw new TypeError(`not an ISO date: ${JSON.stringify(s)}`);
  return trimmed as ISODate;
}

export const todayISO = (): ISODate => isoDate(new Date().toISOString());

export function cik(raw: string | number): CIK {
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) throw new TypeError(`not a CIK: ${JSON.stringify(raw)}`);
  return digits.padStart(10, "0") as CIK;
}

/** Whole days from `a` to `b`, positive when `b` is later. */
export const daysBetween = (a: ISODate, b: ISODate): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function addMonths(date: ISODate, months: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return isoDate(d.toISOString());
}

// ── Observations ──────────────────────────────────────────────────────────────

/**
 * How much weight the number deserves on its face.
 *
 * This is provenance, not judgment: it describes the *source*, and never the
 * company. `'jev'` marks a figure that came out of a model rather than a filing.
 */
export type Reliability = "audited" | "reported" | "market" | "jev";

/** Weakest-wins ordering, for propagating provenance through arithmetic. */
const RELIABILITY_RANK: Record<Reliability, number> = { audited: 0, reported: 1, market: 2, jev: 3 };

export interface Observation<T = number> {
  readonly value: T;
  /** Canonical metric id, e.g. `revenue` or `grossMargin`. */
  readonly metric: string;
  readonly entity: Entity;
  /** The period the number describes — the fiscal period end, or the price date. */
  readonly validAt: ISODate;
  /** When it first became knowable. EDGAR's `filed`; for prices, the close date. */
  readonly knownAt: ISODate;
  /** Where it came from, e.g. `edgar:10-K:0000320193-25-000073` or `stooq`. */
  readonly source: string;
  readonly reliability: Reliability;
  /** The XBRL tag that actually matched, when the resolver had to fall back. */
  readonly tag?: string;
}

/** Raw figures lifted straight from filings. */
export const RAW_METRICS = [
  "revenue", "grossProfit", "operatingIncome", "netIncome", "operatingCashFlow",
  "capex", "totalAssets", "totalLiabilities", "cash", "longTermDebt",
  "sharesOutstanding", "receivables", "inventory",
] as const;
export type RawMetric = (typeof RAW_METRICS)[number];

export const PRICE_METRIC = "close";

export function observation<T>(fields: Observation<T>): Observation<T> {
  return Object.freeze({ ...fields });
}

/**
 * Build a derived figure from the observations it was computed from.
 *
 * Provenance composes rather than being asserted: the result is knowable only once
 * its last input was, describes the latest period any input described, and is no
 * more reliable than its weakest input.
 */
export function derive(
  value: number,
  metric: string,
  inputs: readonly Observation<number>[],
): Observation<number> {
  const [first] = inputs;
  if (!first) throw new TypeError(`cannot derive ${metric} from no inputs`);

  let validAt = first.validAt;
  let knownAt = first.knownAt;
  let reliability = first.reliability;
  const sources = new Set<string>();

  for (const input of inputs) {
    if (input.entity !== first.entity) {
      throw new TypeError(`cannot derive ${metric} across entities: ${first.entity} vs ${input.entity}`);
    }
    if (input.validAt > validAt) validAt = input.validAt;
    if (input.knownAt > knownAt) knownAt = input.knownAt;
    if (RELIABILITY_RANK[input.reliability] > RELIABILITY_RANK[reliability]) reliability = input.reliability;
    sources.add(input.source);
  }

  return observation({
    value, metric, entity: first.entity, validAt, knownAt,
    source: [...sources].sort().join(" + "),
    reliability,
  });
}

// ── The as-of reader ──────────────────────────────────────────────────────────

/**
 * A point-in-time view of the observation store.
 *
 * Every read goes through one of these. There is no way to ask the store a question
 * that is not anchored to a date, which is what keeps look-ahead out of the system
 * structurally rather than by remembering to filter.
 */
export interface ObservationSlice {
  readonly asOf: ISODate;
  /** Latest period whose value was knowable by `asOf`, newest revision winning. */
  latest(entity: Entity, metric: string): Observation | undefined;
  /** Every period knowable by `asOf`, oldest first, one row per period. */
  series(entity: Entity, metric: string): readonly Observation[];
  entities(): readonly Entity[];
  has(entity: Entity): boolean;
}

const SEP = "\u0000";

/**
 * Build a slice from raw rows.
 *
 * Applies the point-in-time rules itself — drop anything not yet knowable, then keep
 * the newest revision of each period — so tests and the DuckDB reader share one
 * implementation of the rule that matters most.
 */
export function buildSlice(rows: readonly Observation[], asOf: ISODate): ObservationSlice {
  const byEntity = new Map<Entity, Map<string, Map<ISODate, Observation>>>();

  for (const row of rows) {
    if (row.knownAt > asOf) continue; // not yet knowable
    const metrics = byEntity.get(row.entity) ?? new Map<string, Map<ISODate, Observation>>();
    byEntity.set(row.entity, metrics);
    const periods = metrics.get(row.metric) ?? new Map<ISODate, Observation>();
    metrics.set(row.metric, periods);

    const existing = periods.get(row.validAt);
    // A later-known value for the same period is a restatement, and supersedes it.
    if (!existing || row.knownAt > existing.knownAt) periods.set(row.validAt, row);
  }

  const sorted = new Map<string, readonly Observation[]>();
  const seriesFor = (entity: Entity, metric: string): readonly Observation[] => {
    const key = entity + SEP + metric;
    const cached = sorted.get(key);
    if (cached) return cached;
    const periods = byEntity.get(entity)?.get(metric);
    const list = periods ? [...periods.values()].sort((a, b) => a.validAt.localeCompare(b.validAt)) : [];
    sorted.set(key, list);
    return list;
  };

  return {
    asOf,
    series: seriesFor,
    latest: (entity, metric) => seriesFor(entity, metric).at(-1),
    entities: () => [...byEntity.keys()].sort(),
    has: (entity) => byEntity.has(entity),
  };
}
