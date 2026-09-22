/**
 * The judgment cache.
 *
 * This is what makes a 5,000-company universe affordable to run daily. A judgment is
 * a pure function of three things: the company, the question set, and the vintage of
 * the data it saw. If none of those changed, the answer cannot have changed either,
 * so we reuse it. Steady state is therefore whichever companies filed since the last
 * run — roughly 40–60 a day — not the whole universe.
 *
 * Keying on the input vintage rather than a wall-clock TTL is the important part: an
 * entry expires when a new filing lands, which is exactly when the answer might
 * differ, and never merely because time passed.
 */

import type { MetricRow } from "./metrics.ts";
import type { Entity, ISODate, Observation } from "./observation.ts";

/** Kept as a union so a future second stage does not need a schema change. */
export type Stage = "judgment";

export interface CacheKey {
  readonly entity: Entity;
  readonly questionSetVersion: string;
  /** The newest `knownAt` across every input that fed the judgment. */
  readonly maxKnownAt: ISODate;
  readonly stage: Stage;
}

export interface CacheEntry<T = unknown> {
  readonly key: CacheKey;
  readonly value: T;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

export interface JudgmentCache {
  get<T>(key: CacheKey): Promise<CacheEntry<T> | undefined>;
  put<T>(entry: CacheEntry<T>): Promise<void>;
  /** Hits and misses since the process started, for `coverage_status`. */
  stats(): CacheStats;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
}

/**
 * The vintage of a company's inputs: the newest moment any of them became knowable.
 *
 * A new filing raises this and invalidates the entry. A restatement raises it too,
 * which is correct — a restated number is new information about an old period.
 *
 * **Market data is deliberately excluded.** A closing price is new every trading day,
 * so counting it here would expire every judgment nightly and turn the steady state
 * back into a full 5,000-company sweep — the exact cost this cache exists to avoid.
 * The trade-off is real and worth stating: a cached verdict was formed against the
 * multiples of the day it was made, so a company whose price has moved sharply since
 * carries a stale valuation until its next filing. `explain_pick` reports the
 * judgment's `createdAt` so that staleness is visible rather than implied.
 */
export function vintageOf(inputs: readonly Observation[]): ISODate | undefined {
  let newest: ISODate | undefined;
  for (const input of inputs) {
    if (input.reliability === "market") continue;
    if (!newest || input.knownAt > newest) newest = input.knownAt;
  }
  return newest;
}

/** Vintage of a computed row, falling back to the slice date when it has no inputs. */
export function rowVintage(row: MetricRow): ISODate {
  return vintageOf(row.inputs) ?? row.asOf;
}

export function cacheKeyFor(row: MetricRow, questionSetVersion: string, stage: Stage): CacheKey {
  return { entity: row.entity, questionSetVersion, maxKnownAt: rowVintage(row), stage };
}

const SEP = "\u0000";
export const serializeKey = (key: CacheKey): string =>
  [key.stage, key.questionSetVersion, key.entity, key.maxKnownAt].join(SEP);

/** In-memory cache. Used by the tests, and as a fallback when no store is open. */
export function memoryCache(): JudgmentCache {
  const entries = new Map<string, CacheEntry<unknown>>();
  let hits = 0;
  let misses = 0;
  let writes = 0;

  return {
    async get<T>(key: CacheKey): Promise<CacheEntry<T> | undefined> {
      const found = entries.get(serializeKey(key));
      if (found) hits++;
      else misses++;
      return found as CacheEntry<T> | undefined;
    },
    async put<T>(entry: CacheEntry<T>): Promise<void> {
      entries.set(serializeKey(entry.key), entry as CacheEntry<unknown>);
      writes++;
    },
    stats: () => ({ hits, misses, writes }),
  };
}

/**
 * Look the judgment up, and only ask jev on a miss.
 *
 * Both stages go through here, which is why the cache hit rate reported by
 * `coverage_status` covers the whole pipeline rather than just stage 2.
 */
export async function throughCache<T>(
  cache: JudgmentCache,
  key: CacheKey,
  compute: () => Promise<{ value: T; model: string; inputTokens: number; outputTokens: number }>,
): Promise<{ value: T; fromCache: boolean; inputTokens: number; outputTokens: number }> {
  const hit = await cache.get<T>(key);
  if (hit) return { value: hit.value, fromCache: true, inputTokens: 0, outputTokens: 0 };

  const fresh = await compute();
  await cache.put({
    key,
    value: fresh.value,
    model: fresh.model,
    inputTokens: fresh.inputTokens,
    outputTokens: fresh.outputTokens,
    createdAt: new Date().toISOString(),
  });
  return { value: fresh.value, fromCache: false, inputTokens: fresh.inputTokens, outputTokens: fresh.outputTokens };
}
