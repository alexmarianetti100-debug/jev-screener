/**
 * Daily closes from Polygon's grouped aggregates.
 *
 * The shape matters more than the vendor. Polygon answers **one request per trading
 * day with every US ticker's close in it**, so the whole universe costs one call
 * rather than one call per company. The previous source had no bulk endpoint, which
 * meant 3,652 sequential requests per refresh — half an hour of wall clock, and one
 * unreachable host was enough to stall a run for eight hours.
 *
 * Two consequences worth knowing:
 *
 *  1. **A completed trading day is immutable**, so its response is cached forever and
 *     re-reading it is free. Per-ticker series had no such property: they change every
 *     afternoon, so a cache of them is stale the moment it is written.
 *  2. **Free-tier throughput is five requests a minute**, which sounds restrictive and
 *     is not: a day of prices is one request, so a routine refresh needs one, and even
 *     a two-year backfill is about 500.
 *
 * `knownAt` is the close date itself — a closing price is knowable the day it prints,
 * which is what makes prices safe to mix with filings in a point-in-time slice.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CACHE_DIR, HTTP_TIMEOUT_MS, MARKET_CLOSE_HOUR_ET, MARKET_TIME_ZONE,
  POLYGON_REQUESTS_PER_MINUTE, PRICE_PUBLISH_LAG_DAYS,
} from "./constants.ts";
import {
  isoDate, observation, PRICE_METRIC,
  type Entity, type ISODate, type Observation, type Ticker,
} from "./observation.ts";
import { rateLimiter } from "./pool.ts";

export const POLYGON_BASE = "https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks";

/** Adjusted closes, so a split does not read as a 50% drawdown. */
export const polygonUrl = (day: ISODate, apiKey: string): string =>
  `${POLYGON_BASE}/${day}?adjusted=true&apiKey=${encodeURIComponent(apiKey)}`;

/** Whether a key is configured at all, so a run can skip prices instead of failing 20 times. */
export const hasPolygonKey = (): boolean => Boolean(process.env["POLYGON_API_KEY"]?.trim());

export function polygonApiKey(): string {
  const key = process.env["POLYGON_API_KEY"]?.trim();
  if (!key) {
    throw new Error(
      "POLYGON_API_KEY is not set. Get a free key at https://polygon.io/dashboard/api-keys " +
        "and put it in .env — see .env.example.",
    );
  }
  return key;
}

export interface PriceOptions {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly cacheDir?: string;
  readonly apiKey?: string;
  /** Rate gate override, for tests that must not sleep. */
  readonly gate?: () => Promise<void>;
}

export interface PriceClient {
  /**
   * Every US ticker's close for one trading day.
   *
   * An empty map is a normal answer, not a failure: weekends and market holidays have
   * no bars, and the caller cannot know the exchange calendar in advance.
   */
  dailyCloses(day: ISODate): Promise<ReadonlyMap<Ticker, number>>;
}

interface GroupedBar {
  readonly T?: string;
  readonly c?: number;
}

interface GroupedResponse {
  readonly status?: string;
  readonly results?: readonly GroupedBar[];
  readonly error?: string;
  readonly message?: string;
}

/** Ticker → close, skipping anything without a usable symbol and a positive price. */
export function parseGroupedBars(body: GroupedResponse): Map<Ticker, number> {
  const closes = new Map<Ticker, number>();
  for (const bar of body.results ?? []) {
    const symbol = bar.T?.trim().toUpperCase();
    if (!symbol) continue;
    if (typeof bar.c !== "number" || !Number.isFinite(bar.c) || bar.c <= 0) continue;
    closes.set(symbol as Ticker, bar.c);
  }
  return closes;
}

/**
 * The newest date the price source will actually serve a close for.
 *
 * Asking for a day it will not serve is not the harmless empty answer a weekend is:
 * the free tier returns **403** for a date outside its entitlement, which is the same
 * status a revoked key returns. So every evening run recorded a source failure, spent
 * a rate-limited request, and left a "check POLYGON_API_KEY" in the log with nothing
 * wrong with the key.
 *
 * Two separate reasons a day may be unavailable, and conflating them is how the first
 * fix came up short:
 *
 *  1. **The bell has not rung.** UTC caused this — west of the meridian the UTC date
 *     rolls over while the market is still shut — so the anchor is the *Eastern* date,
 *     stepped back until the close hour.
 *  2. **The plan does not cover the current session.** Measured rather than assumed:
 *     at 18:42 ET, nearly three hours after the close, the same key that returned
 *     12,591 results for the previous session still returned 403 for that day. The
 *     free tier serves history, not today, however late you ask.
 *
 * `PRICE_PUBLISH_LAG_DAYS` is the second of those, and it is a property of the plan
 * rather than of the clock — a paid tier would set it to zero.
 *
 * Still no exchange calendar: `recentDays` drops weekends, and a holiday answers with
 * no bars, which is already a normal outcome.
 */
export function lastPossibleCloseDay(now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const easternMidnight = new Date(`${at("year")}-${at("month")}-${at("day")}T00:00:00Z`);
  if (Number(at("hour")) < MARKET_CLOSE_HOUR_ET) easternMidnight.setUTCDate(easternMidnight.getUTCDate() - 1);
  easternMidnight.setUTCDate(easternMidnight.getUTCDate() - PRICE_PUBLISH_LAG_DAYS);
  return isoDate(easternMidnight.toISOString());
}

/** The earlier of two days. Point-in-time anchors may be older than the bell; never newer. */
export const earlierDay = (a: ISODate, b: ISODate): ISODate => (a < b ? a : b);

/**
 * Calendar days back from `asOf`, newest first, with weekends dropped.
 *
 * Holidays are deliberately not filtered: an exchange calendar is a dependency this
 * project does not need to carry, and a holiday simply returns no bars. Asking for a
 * few more days than strictly required is cheaper than being wrong about which traded.
 */
export function recentDays(asOf: ISODate, count: number): ISODate[] {
  const days: ISODate[] = [];
  const cursor = new Date(`${asOf}T00:00:00Z`);

  while (days.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(isoDate(cursor.toISOString()));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return days;
}

/** Turn one day's closes into observations for the entities we actually track. */
export function closesToObservations(
  day: ISODate,
  closes: ReadonlyMap<Ticker, number>,
  entityFor: ReadonlyMap<Ticker, Entity>,
): Observation[] {
  const rows: Observation[] = [];
  for (const [symbol, close] of closes) {
    const entity = entityFor.get(symbol);
    if (!entity) continue;
    rows.push(
      observation({
        value: close,
        metric: PRICE_METRIC,
        entity,
        validAt: day,
        knownAt: day,
        source: "polygon",
        reliability: "market",
      }),
    );
  }
  return rows;
}

export function createPriceClient(options: PriceOptions = {}): PriceClient {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const cacheDir = options.cacheDir ?? join(CACHE_DIR, "prices");
  // The free tier is metered per minute, not per second, so the gate is a fraction.
  const gate = options.gate ?? rateLimiter(POLYGON_REQUESTS_PER_MINUTE / 60);

  return {
    async dailyCloses(day) {
      const cachePath = join(cacheDir, `polygon-${day}.json`);
      try {
        return parseGroupedBars(JSON.parse(await readFile(cachePath, "utf8")) as GroupedResponse);
      } catch {
        // not cached, or cached badly — fetch it
      }

      await gate();
      const key = options.apiKey ?? polygonApiKey();
      const response = await doFetch(polygonUrl(day, key), { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Polygon rejected the API key (${response.status}) — check POLYGON_API_KEY`);
      }
      if (response.status === 429) {
        throw new Error("Polygon rate limit hit (429) — the free tier allows 5 requests a minute");
      }
      if (!response.ok) throw new Error(`Polygon ${response.status} for ${day}`);

      const text = await response.text();
      let body: GroupedResponse;
      try {
        body = JSON.parse(text) as GroupedResponse;
      } catch {
        throw new Error(`Polygon returned unparseable JSON for ${day}`);
      }
      if (body.error ?? body.message) throw new Error(`Polygon: ${body.error ?? body.message}`);

      // Cache only real trading days. An empty weekend response cached forever would
      // be indistinguishable from a day we simply have not fetched yet.
      const closes = parseGroupedBars(body);
      if (closes.size > 0) {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cachePath, text);
      }
      return closes;
    },
  };
}
