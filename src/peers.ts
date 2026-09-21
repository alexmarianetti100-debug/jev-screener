/**
 * Peer context: the yardstick every jev call is measured against.
 *
 * This is the quietest correctness requirement in the project. `attractiveness.score`
 * values are only comparable across calls if every call saw the *same* distribution,
 * so these are computed once over the entire eligible universe as of one `asOf` and
 * passed identically into every call. A per-batch distribution would make company A's
 * score depend on which companies happened to be in its batch — and the ranking would
 * silently stop meaning anything.
 *
 * Note this file computes only *where a company sits*. It never says whether sitting
 * there is good.
 */

import { DERIVED_METRICS, type DerivedMetric, type MetricRow } from "./metrics.ts";
import type { ISODate } from "./observation.ts";

export interface Distribution {
  readonly count: number;
  readonly min: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly max: number;
}

export type Distributions = Readonly<Partial<Record<DerivedMetric, Distribution>>>;

export interface PeerContext {
  readonly asOf: ISODate;
  /** Every eligible company, whatever its sector. */
  readonly universe: { readonly count: number; readonly distributions: Distributions };
  /** The company's own sector grouping. */
  readonly sector: { readonly name: string; readonly count: number; readonly distributions: Distributions };
}

/** Linear-interpolated percentile over a sorted array. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/**
 * Summarise one metric across a set of companies.
 *
 * Companies missing the metric are excluded rather than zero-filled — `count` then
 * tells jev how much of the universe the summary actually covers.
 */
export function distributionsOver(rows: readonly MetricRow[]): Distributions {
  const out: Partial<Record<DerivedMetric, Distribution>> = {};

  for (const metric of DERIVED_METRICS) {
    const values: number[] = [];
    for (const row of rows) {
      const observation = row.metrics[metric];
      if (observation && Number.isFinite(observation.value)) values.push(observation.value);
    }
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);

    out[metric] = {
      count: values.length,
      min: values[0]!,
      p25: percentile(values, 0.25),
      median: percentile(values, 0.5),
      p75: percentile(values, 0.75),
      max: values.at(-1)!,
    };
  }

  return out;
}

/** Universe-wide and per-sector distributions, computed once per run. */
export interface PeerTables {
  readonly asOf: ISODate;
  readonly universeCount: number;
  readonly universe: Distributions;
  readonly bySector: ReadonlyMap<string, { readonly count: number; readonly distributions: Distributions }>;
}

export function buildPeerTables(rows: readonly MetricRow[], asOf: ISODate): PeerTables {
  const bySector = new Map<string, MetricRow[]>();
  for (const row of rows) {
    const bucket = bySector.get(row.sector) ?? [];
    bySector.set(row.sector, bucket);
    bucket.push(row);
  }

  return {
    asOf,
    universeCount: rows.length,
    universe: distributionsOver(rows),
    bySector: new Map(
      [...bySector].map(([name, sectorRows]) => [
        name,
        { count: sectorRows.length, distributions: distributionsOver(sectorRows) },
      ]),
    ),
  };
}

/**
 * Overlay distributions for metrics that only a subset of the universe has.
 *
 * Price multiples are the reason this exists. Stooq has no bulk endpoint, so prices
 * are fetched only for triage survivors, and no P/E distribution over the *whole*
 * eligible universe can exist at stage 2. The honest answer is to compute those
 * metrics over the survivor set, merge them into the universe table, and let the
 * `count` on each distribution say what basis it was computed on.
 *
 * The comparability rule still holds: the merged table is built once and passed
 * identically to every stage-2 call, so no company's score depends on its batch.
 */
export function overlayDistributions(
  tables: PeerTables,
  rows: readonly MetricRow[],
  metrics: readonly DerivedMetric[],
): PeerTables {
  const pick = (source: Distributions): Distributions => {
    const out: Partial<Record<DerivedMetric, Distribution>> = {};
    for (const metric of metrics) {
      const found = source[metric];
      if (found) out[metric] = found;
    }
    return out;
  };

  const overlay = buildPeerTables(rows, tables.asOf);
  const merged = new Map<string, { count: number; distributions: Distributions }>();

  for (const [name, base] of tables.bySector) {
    const sectorOverlay = overlay.bySector.get(name);
    merged.set(name, {
      count: base.count,
      distributions: { ...base.distributions, ...(sectorOverlay ? pick(sectorOverlay.distributions) : {}) },
    });
  }

  return {
    asOf: tables.asOf,
    universeCount: tables.universeCount,
    universe: { ...tables.universe, ...pick(overlay.universe) },
    bySector: merged,
  };
}

/** The context handed to jev for one company. Identical shape for every call. */
export function peerContextFor(tables: PeerTables, sector: string): PeerContext {
  const inSector = tables.bySector.get(sector);
  return {
    asOf: tables.asOf,
    universe: { count: tables.universeCount, distributions: tables.universe },
    sector: { name: sector, count: inSector?.count ?? 0, distributions: inSector?.distributions ?? {} },
  };
}
