/**
 * Stooq daily prices.
 *
 * Stooq has no bulk endpoint, so prices are fetched one ticker at a time. That makes
 * them too expensive for the whole universe on every run, and they are therefore
 * fetched lazily — only for the companies that survive triage.
 *
 * The consequence is deliberate and worth stating plainly: **stage 1 judges operating
 * fundamentals with no price and no valuation multiple at all.** A company is
 * advanced because of what the business looks like, never because it looks cheap.
 * Multiples exist only at stage 2. `ingest --prices-all` exists for anyone who wants
 * to refresh the full eligible universe on a schedule instead.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR, HTTP_TIMEOUT_MS, STOOQ_REQUESTS_PER_SECOND } from "./constants.ts";
import { isoDate, observation, PRICE_METRIC, type ISODate, type Observation, type Entity, type Ticker } from "./observation.ts";
import { rateLimiter } from "./pool.ts";

export const STOOQ_BASE = "https://stooq.com/q/d/l/";

export const stooqUrl = (ticker: Ticker): string =>
  `${STOOQ_BASE}?s=${encodeURIComponent(ticker.toLowerCase())}.us&i=d`;

export interface PriceOptions {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly cacheDir?: string;
  readonly gate?: () => Promise<void>;
}

export interface PriceClient {
  /** Daily closes for one ticker, oldest first. Empty when Stooq has no series. */
  closes(ticker: Ticker, entity: Entity): Promise<Observation[]>;
}

/**
 * Parse Stooq's daily CSV.
 *
 * `knownAt` is the close date itself: a closing price is knowable the day it prints,
 * which is what makes prices safe to mix with filings in a point-in-time slice.
 */
export function parseStooqCsv(csv: string, ticker: Ticker, entity: Entity): Observation[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]?.toLowerCase() ?? "";
  if (!header.startsWith("date")) return []; // Stooq answers "N/D" for unknown symbols

  const columns = header.split(",");
  const dateIndex = columns.indexOf("date");
  const closeIndex = columns.indexOf("close");
  if (dateIndex < 0 || closeIndex < 0) return [];

  const rows: Observation[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const rawDate = cells[dateIndex];
    const rawClose = cells[closeIndex];
    if (!rawDate || !rawClose) continue;

    const close = Number(rawClose);
    if (!Number.isFinite(close) || close <= 0) continue;

    let date: ISODate;
    try {
      date = isoDate(rawDate);
    } catch {
      continue;
    }

    rows.push(
      observation({
        value: close,
        metric: PRICE_METRIC,
        entity,
        validAt: date,
        knownAt: date,
        source: "stooq",
        reliability: "market",
      }),
    );
  }

  return rows.sort((a, b) => a.validAt.localeCompare(b.validAt));
}

export function createPriceClient(options: PriceOptions = {}): PriceClient {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const cacheDir = options.cacheDir ?? join(CACHE_DIR, "prices");
  // Stooq publishes no documented limit; this is deliberate politeness.
  const gate = options.gate ?? rateLimiter(STOOQ_REQUESTS_PER_SECOND);

  return {
    async closes(ticker, entity) {
      const cachePath = join(cacheDir, `${ticker}.csv`);
      try {
        return parseStooqCsv(await readFile(cachePath, "utf8"), ticker, entity);
      } catch {
        // not cached yet
      }

      await gate();
      const response = await doFetch(stooqUrl(ticker), { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Stooq ${response.status} for ${ticker}`);

      const csv = await response.text();
      const rows = parseStooqCsv(csv, ticker, entity);
      if (rows.length > 0) {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cachePath, csv);
      }
      return rows;
    },
  };
}
