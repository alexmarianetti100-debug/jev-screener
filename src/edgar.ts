/**
 * SEC EDGAR adapter.
 *
 * Bulk first: two ZIP archives give the whole universe in two requests, and the
 * per-company API is reserved for the few hundred companies that survive triage.
 * Backfilling 5,000 companies one HTTP call at a time would take hours and burn the
 * rate limit for no benefit.
 *
 * Everything here is data mapping. The one judgment-adjacent thing in the file is the
 * XBRL tag fallback chain, and it is not a judgment: it answers "which tag did this
 * filer use for revenue", never "is this revenue good". The tag that matched is
 * recorded on every observation so the mapping can be audited after the fact.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { open as openFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import {
  BULK_DOWNLOAD_TIMEOUT_MS, CACHE_DIR, DOWNLOAD_PROGRESS_INTERVAL_MS,
  EDGAR_REQUESTS_PER_SECOND, FILING_EXCERPT_CHARS, HTTP_TIMEOUT_MS,
} from "./constants.ts";
import {
  cik as toCik, isoDate, observation, ticker as toTicker,
  type CIK, type Entity, type ISODate, type Observation, type Ticker,
} from "./observation.ts";
import { rateLimiter } from "./pool.ts";
import { sectorForSic, type FilerProfile, type FilingRef } from "./universe.ts";

const inflateRawAsync = promisify(inflateRaw);

export const EDGAR_BASE = "https://www.sec.gov";
export const COMPANY_FACTS_ZIP = `${EDGAR_BASE}/Archives/edgar/daily-index/xbrl/companyfacts.zip`;
// Note: submissions lives under bulkdata/, not xbrl/ alongside companyfacts.
// The xbrl/ path 403s — verified against the live host.
export const SUBMISSIONS_ZIP = `${EDGAR_BASE}/Archives/edgar/daily-index/bulkdata/submissions.zip`;
export const COMPANY_TICKERS = `${EDGAR_BASE}/files/company_tickers.json`;

// ── HTTP ──────────────────────────────────────────────────────────────────────

/**
 * SEC requires a descriptive User-Agent identifying the operator. Anonymous traffic
 * gets blocked, so fail loudly at startup rather than mysteriously mid-ingest.
 */
export function edgarUserAgent(): string {
  const value = process.env["EDGAR_USER_AGENT"]?.trim();
  if (!value) {
    throw new Error(
      "EDGAR_USER_AGENT is required by the SEC. Set it to something like " +
        '"jevproject you@example.com" in .env — see .env.example.',
    );
  }
  return value;
}

export interface Fetcher {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface EdgarOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: Fetcher;
  readonly userAgent?: string;
  readonly cacheDir?: string;
  /** Rate gate override, for tests that must not sleep. */
  readonly gate?: () => Promise<void>;
  /** Progress reporting for the multi-gigabyte bulk downloads. */
  readonly log?: (message: string) => void;
}

export interface EdgarClient {
  getJson<T>(url: string): Promise<T>;
  getText(url: string): Promise<string>;
  /** Downloads to `cacheDir` and returns the local path; reuses an existing copy. */
  download(url: string, filename: string): Promise<string>;
}

export function createEdgarClient(options: EdgarOptions = {}): EdgarClient {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const userAgent = options.userAgent ?? edgarUserAgent();
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  // The throttle lives here, not at the call sites, so no caller can forget it.
  const gate = options.gate ?? rateLimiter(EDGAR_REQUESTS_PER_SECOND);

  const log = options.log ?? (() => {});

  const request = async (url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> => {
    await gate();
    const response = await doFetch(url, {
      headers: { "User-Agent": userAgent, "Accept-Encoding": "gzip, deflate" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`EDGAR ${response.status} for ${url}`);
    return response;
  };

  return {
    async getJson<T>(url: string): Promise<T> {
      return (await request(url)).json() as Promise<T>;
    },
    async getText(url: string): Promise<string> {
      return (await request(url)).text();
    },
    /**
     * Fetch a bulk archive to disk.
     *
     * Streamed rather than buffered: these are 1.3–1.5 GB, and `arrayBuffer()` would
     * hold the whole thing in memory before a byte reached disk. Written to a
     * `.part` file and renamed on success, so an interrupted download can never be
     * mistaken for a complete one on the next run.
     */
    async download(url: string, filename: string): Promise<string> {
      await mkdir(cacheDir, { recursive: true });
      const path = join(cacheDir, filename);
      const partial = `${path}.part`;

      // stat, not read: the point is existence, and the file is over a gigabyte.
      const existing = await stat(path).catch(() => undefined);
      if (existing?.isFile() && existing.size > 0) {
        log(`  reusing cached ${filename} (${(existing.size / 2 ** 30).toFixed(2)} GB)`);
        return path;
      }

      const response = await request(url, BULK_DOWNLOAD_TIMEOUT_MS);
      if (!response.body) throw new Error(`EDGAR returned no body for ${url}`);

      const total = Number(response.headers.get("content-length")) || 0;
      let received = 0;
      let lastLogged = Date.now();

      const counter = async function* (source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
        for await (const chunk of source) {
          received += chunk.byteLength;
          if (Date.now() - lastLogged >= DOWNLOAD_PROGRESS_INTERVAL_MS) {
            lastLogged = Date.now();
            const done = (received / 2 ** 30).toFixed(2);
            log(total ? `  ${done} / ${(total / 2 ** 30).toFixed(2)} GB` : `  ${done} GB`);
          }
          yield chunk;
        }
      };

      const sink = createWriteStream(partial);
      try {
        await pipeline(Readable.fromWeb(response.body), counter, sink);
      } catch (error) {
        // The sink may still be opening when the source errors. Unlinking straight
        // away can lose that race — the open completes afterwards and leaves a stray
        // `.part` behind — so let the stream settle before removing the file.
        sink.destroy();
        await once(sink, "close").catch(() => undefined);
        await unlink(partial).catch(() => undefined);
        throw error;
      }
      await rename(partial, path);
      log(`  ${filename}: ${(received / 2 ** 30).toFixed(2)} GB`);
      return path;
    },
  };
}

// ── ZIP reading ───────────────────────────────────────────────────────────────
// Node ships no archive reader, and the only compression these archives use is
// deflate, which zlib already does — so this reads the central directory itself
// rather than taking on a dependency.
//
// Both code paths are load-bearing, measured against the live host:
//   companyfacts.zip  1.31 GB, ~20,400 entries — plain 32-bit central directory
//   submissions.zip   1.46 GB, ~991,000 entries — ZIP64 (the count overflows 0xffff)
// companyfacts will cross the same line as it grows, so the ZIP64 branch is not
// speculative generality.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

/** Read the central directory, following the ZIP64 records when present. */
export async function readZipDirectory(handle: FileHandle): Promise<ZipEntry[]> {
  const { size } = await handle.stat();

  // The EOCD sits at the end, after a comment of up to 64 KiB.
  const tailLength = Math.min(size, 0x10000 + 22);
  const tail = await readAt(handle, size - tailLength, tailLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file: no end-of-central-directory record");

  let entryCount = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64 kicks in when any of these overflow their 16- or 32-bit field.
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) {
      throw new Error("ZIP64 expected but the locator record is missing");
    }
    const eocd64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const header = await readAt(handle, eocd64Offset, 56);
    if (header.readUInt32LE(0) !== SIG_EOCD64) throw new Error("bad ZIP64 end-of-central-directory signature");
    entryCount = Number(header.readBigUInt64LE(32));
    directorySize = Number(header.readBigUInt64LE(40));
    directoryOffset = Number(header.readBigUInt64LE(48));
  }

  const directory = await readAt(handle, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let cursor = 0;

  for (let i = 0; i < entryCount && cursor + 46 <= directory.length; i++) {
    if (directory.readUInt32LE(cursor) !== SIG_CENTRAL) break;

    const method = directory.readUInt16LE(cursor + 10);
    let compressedSize = directory.readUInt32LE(cursor + 20);
    let uncompressedSize = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    let localHeaderOffset = directory.readUInt32LE(cursor + 42);
    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    // The ZIP64 extra field carries replacements, in order, for whichever of the
    // three fields above were written as all-ones sentinels.
    if (extraLength > 0) {
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      let p = 0;
      while (p + 4 <= extra.length) {
        const headerId = extra.readUInt16LE(p);
        const dataSize = extra.readUInt16LE(p + 2);
        if (headerId === 0x0001) {
          let q = p + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
          break;
        }
        p += 4 + dataSize;
      }
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Inflate one entry. The local header's name and extra lengths can differ from the directory's. */
export async function readZipEntry(handle: FileHandle, entry: ZipEntry): Promise<Buffer> {
  const header = await readAt(handle, entry.localHeaderOffset, 30);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = await readAt(handle, dataStart, entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return Buffer.from(await inflateRawAsync(raw));
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/**
 * One company's primary JSON member, e.g. `CIK0000320193.json`.
 *
 * submissions.zip also carries `CIK…-submissions-001.json` overflow files for filers
 * with more history than one document holds. Those have no `cik`, `name` or `tickers`
 * field, so parsing them costs time and yields nothing.
 */
export const isPrimaryCikEntry = (name: string): boolean => /^CIK\d+\.json$/.test(name);

/**
 * The CIK an archive member describes, from its filename alone.
 *
 * Lets the ingester decide whether it cares about a member *before* parsing it.
 * submissions.zip holds ~991,000 documents and only ~10,000 filers have a ticker,
 * so skipping on the name rather than on the parsed body avoids roughly 980,000
 * pointless JSON parses.
 */
export function cikFromEntryName(name: string): CIK | undefined {
  const match = /^CIK(\d+)\.json$/.exec(name);
  return match?.[1] ? toCik(match[1]) : undefined;
}

/**
 * Every CIK an archive contains, read from the central directory alone.
 *
 * No member is decompressed. This is what defines the universe: a filer with XBRL
 * financial data, knowable from ~20,000 filenames without parsing 1.31 GB of JSON.
 * Deriving membership from the ticker file instead is what dropped Exxon.
 */
export async function zipEntryCiks(path: string): Promise<Set<CIK>> {
  const handle = await openFile(path, "r");
  try {
    const found = new Set<CIK>();
    for (const entry of await readZipDirectory(handle)) {
      if (entry.uncompressedSize === 0) continue;
      const entryCik = cikFromEntryName(entry.name);
      if (entryCik) found.add(entryCik);
    }
    return found;
  } finally {
    await handle.close();
  }
}

/** Stream a ZIP's entries, parsing each as JSON. Skips entries that fail to parse. */
export async function* iterateZipJson<T>(
  path: string,
  predicate: (name: string) => boolean = () => true,
): AsyncGenerator<{ name: string; data: T }> {
  const handle = await openFile(path, "r");
  try {
    for (const entry of await readZipDirectory(handle)) {
      if (entry.uncompressedSize === 0 || !predicate(entry.name)) continue;
      let parsed: T;
      try {
        parsed = JSON.parse((await readZipEntry(handle, entry)).toString("utf8")) as T;
      } catch {
        continue; // a malformed member must not abandon a 500k-entry ingest
      }
      yield { name: entry.name, data: parsed };
    }
  } finally {
    await handle.close();
  }
}

// ── Ticker map ────────────────────────────────────────────────────────────────

interface TickerRow { cik_str: number | string; ticker: string; title: string }

/**
 * CIK → every ticker SEC lists for it, shortest first.
 *
 * Keeping only one was wrong: 1,448 filers carry more than one symbol (Alphabet has
 * GOOGL, GOOG, GOOGM and GOOGN), and dropping the rest means a screen for a perfectly
 * ordinary ticker silently returns nothing. Shortest first is a display convention —
 * the common share is usually the shortest symbol — not a judgment about the company.
 *
 * This map only *attaches labels*. It must never decide who is in the universe: SEC's
 * file omits filers entirely (Exxon Mobil Corp, CIK 34088, is absent) and points some
 * familiar symbols at the wrong filer.
 */
export async function fetchTickerMap(client: EdgarClient): Promise<Map<CIK, Ticker[]>> {
  const raw = await client.getJson<Record<string, TickerRow>>(COMPANY_TICKERS);
  const map = new Map<CIK, Ticker[]>();
  for (const row of Object.values(raw)) {
    if (!row?.ticker) continue;
    const key = toCik(row.cik_str);
    const candidate = toTicker(row.ticker);
    const existing = map.get(key);
    if (!existing) map.set(key, [candidate]);
    else if (!existing.includes(candidate)) existing.push(candidate);
  }
  for (const tickers of map.values()) {
    tickers.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }
  return map;
}

// ── XBRL tag resolution ───────────────────────────────────────────────────────

/**
 * Ordered fallback chains, most specific tag first.
 *
 * Filers tag the same economic concept differently — a post-ASC-606 filer reports
 * `RevenueFromContractWithCustomerExcludingAssessedTax` where an older one reports
 * `Revenues`. Walking the chain in order and recording what matched is data mapping;
 * the `tag` field on every observation makes it auditable.
 */
export const TAG_CHAINS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueGoodsNet"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsToAcquirePropertyPlantAndEquipmentExcludingCapitalizedInterest"],
  depreciationAndAmortization: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization", "Depreciation"],
  totalAssets: ["Assets"],
  totalLiabilities: ["Liabilities"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
  sharesOutstanding: ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding", "WeightedAverageNumberOfDilutedSharesOutstanding"],
  receivables: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent", "AccountsReceivableGrossCurrent"],
  inventory: ["InventoryNet", "InventoryGross"],

  // ── Dated obligations ──
  // Contractual and dated, unlike everything above, which describes a period that
  // has already closed. A maturity schedule says when money must be found; remaining
  // performance obligations say how much revenue is already contracted. They are what
  // lets a horizon rest on something the filing commits to rather than on inference.
  // Coverage measured on a 400-filer sample: debt ~62%, leases ~58%, RPO ~20%.
  debtDueYear1: ["LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths", "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextRollingTwelveMonths"],
  debtDueYear2: ["LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo", "LongTermDebtMaturitiesRepaymentsOfPrincipalInRollingYearTwo"],
  leaseDueYear1: ["LesseeOperatingLeaseLiabilityPaymentsDueNextTwelveMonths", "LesseeOperatingLeaseLiabilityPaymentsDueNextRollingTwelveMonths"],
  remainingPerformanceObligation: ["RevenueRemainingPerformanceObligation"],
  contractLiability: ["ContractWithCustomerLiabilityCurrent", "ContractWithCustomerLiabilityCurrentAndNoncurrent"],
} as const satisfies Record<string, readonly string[]>;

export type Concept = keyof typeof TAG_CHAINS;

/** Concepts measured over a period, as opposed to at an instant. */
const FLOW_CONCEPTS = new Set<Concept>([
  "revenue", "grossProfit", "operatingIncome", "netIncome",
  "operatingCashFlow", "capex", "depreciationAndAmortization",
]);

/** Concepts reported as a positive outflow that we store as a magnitude. */
const MAGNITUDE_CONCEPTS = new Set<Concept>(["capex"]);

// ── companyfacts parsing ──────────────────────────────────────────────────────

interface FactEntry {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

export interface CompanyFacts {
  cik?: number | string;
  entityName?: string;
  facts?: Record<string, Record<string, { units?: Record<string, FactEntry[]> }>>;
}

const dayCount = (start: string, end: string): number =>
  Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);

/** A reported period of roughly one quarter. Filers vary by a few days either way. */
const isQuarterly = (days: number): boolean => days >= 80 && days <= 100;
const isAnnual = (days: number): boolean => days >= 340 && days <= 380;

interface PeriodFact {
  readonly start: string;
  readonly end: ISODate;
  readonly filed: ISODate;
  readonly value: number;
  readonly form: string;
  readonly accession: string;
  readonly tag: string;
}

/** Every entry recorded under one tag, across the namespaces we understand. */
function entriesForTag(facts: CompanyFacts, concept: Concept, tag: string): PeriodFact[] {
  const namespaces = facts.facts ?? {};
  const out: PeriodFact[] = [];

  for (const namespace of ["us-gaap", "dei", "ifrs-full"]) {
    const units = namespaces[namespace]?.[tag]?.units;
    if (!units) continue;
    // USD for money, shares for counts; take whichever unit this concept uses.
    const series = units["USD"] ?? units["shares"] ?? Object.values(units)[0];
    if (!series) continue;

    for (const entry of series) {
      if (typeof entry.val !== "number" || !entry.end || !entry.filed) continue;
      out.push({
        start: entry.start ?? entry.end,
        end: isoDate(entry.end),
        filed: isoDate(entry.filed),
        value: MAGNITUDE_CONCEPTS.has(concept) ? Math.abs(entry.val) : entry.val,
        form: entry.form ?? "",
        accession: entry.accn ?? "",
        tag,
      });
    }
  }
  return out;
}

/** Reduce a raw tag series to the periods this concept is actually measured over. */
function normalisePeriods(concept: Concept, raw: readonly PeriodFact[]): PeriodFact[] {
  return FLOW_CONCEPTS.has(concept)
    ? quarterize(raw)
    : raw.filter((entry) => dayCount(entry.start, entry.end) <= 1);
}

/** Reporting quarter of a date, so two series are compared by period, not by day. */
const quarterKey = (date: string): string => `${date.slice(0, 4)}Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;

const latestEnd = (periods: readonly PeriodFact[]): string =>
  periods.reduce((newest, period) => (period.end > newest ? period.end : newest), periods[0]?.end ?? "");

/**
 * Pick the one tag that best describes this concept for this filer.
 *
 * Coverage decides, not position in the chain. A filer that adopted ASC 606 and then
 * moved on can leave a seven-entry stub under the "modern" tag while its complete
 * current series sits under `Revenues` — Lockheed is exactly this shape. Taking the
 * first tag with any data at all picks the stub and the company then looks like it
 * stopped reporting revenue in 2018.
 *
 * Recency is bucketed by reporting quarter so that a few days' difference in period
 * end cannot outvote a hundred periods of history. Tags are never mixed: splicing
 * ASC 605 and ASC 606 revenue would join two different definitions into one series.
 * The winning tag is recorded on every observation, so the choice stays auditable.
 */
function collectConcept(facts: CompanyFacts, concept: Concept): PeriodFact[] {
  const chain = TAG_CHAINS[concept] as readonly string[];
  const candidates: { readonly index: number; readonly periods: PeriodFact[] }[] = [];

  for (let index = 0; index < chain.length; index++) {
    const tag = chain[index];
    if (!tag) continue;
    const periods = normalisePeriods(concept, entriesForTag(facts, concept, tag));
    if (periods.length > 0) candidates.push({ index, periods });
  }
  if (candidates.length === 0) return [];

  candidates.sort((a, b) =>
    quarterKey(latestEnd(b.periods)).localeCompare(quarterKey(latestEnd(a.periods)))
    || b.periods.length - a.periods.length
    || a.index - b.index);

  return candidates[0]?.periods ?? [];
}

/**
 * Normalise a flow concept to quarterly periods.
 *
 * Filers report Q1–Q3 in 10-Qs and the full year in the 10-K, so Q4 usually exists
 * only as a residual. Deriving it keeps the quarterly series continuous, which is
 * what makes a trailing-twelve-month figure the sum of the last four periods.
 */
export function quarterize(entries: readonly PeriodFact[]): PeriodFact[] {
  const quarters = new Map<string, PeriodFact>();
  const annuals: PeriodFact[] = [];

  for (const entry of entries) {
    const days = dayCount(entry.start, entry.end);
    if (isQuarterly(days)) {
      const existing = quarters.get(entry.end);
      // Keep every revision; the store decides which was knowable when. Within one
      // filing date, prefer the later-filed value for the same period.
      if (!existing || entry.filed > existing.filed) quarters.set(entry.end, entry);
    } else if (isAnnual(days)) {
      annuals.push(entry);
    }
  }

  for (const annual of annuals) {
    if (quarters.has(annual.end)) continue; // Q4 already reported directly

    const inside = [...quarters.values()]
      .filter((q) => q.start >= annual.start && q.end < annual.end)
      .sort((a, b) => a.end.localeCompare(b.end));
    if (inside.length !== 3) continue;

    const covered = inside.reduce((total, q) => total + dayCount(q.start, q.end), 0);
    if (covered < 250 || covered > 290) continue; // three quarters, give or take

    const residual = annual.value - inside.reduce((total, q) => total + q.value, 0);
    const knownAt = inside.reduce<ISODate>((latest, q) => (q.filed > latest ? q.filed : latest), annual.filed);

    quarters.set(annual.end, {
      start: inside.at(-1)!.end,
      end: annual.end,
      filed: knownAt,
      value: residual,
      form: annual.form,
      accession: annual.accession,
      tag: `${annual.tag} (Q4 residual)`,
    });
  }

  return [...quarters.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** Turn one company's companyfacts document into observations. */
export function factsToObservations(facts: CompanyFacts, entity: Entity): Observation[] {
  const rows: Observation[] = [];

  for (const concept of Object.keys(TAG_CHAINS) as Concept[]) {
    // Already normalised: collectConcept picks a tag and reduces it to periods.
    const periods = collectConcept(facts, concept);
    if (periods.length === 0) continue;

    for (const period of periods) {
      rows.push(
        observation({
          value: period.value,
          metric: concept,
          entity,
          validAt: period.end,
          knownAt: period.filed,
          source: `edgar:${period.form || "filing"}:${period.accession || "unknown"}`,
          // Figures inside an audited annual report vs. an unaudited quarterly one.
          reliability: period.form.startsWith("10-K") ? "audited" : "reported",
          tag: period.tag,
        }),
      );
    }
  }

  return rows;
}

// ── submissions parsing ───────────────────────────────────────────────────────

export interface Submissions {
  cik?: string | number;
  name?: string;
  sic?: string;
  tickers?: string[];
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      filingDate?: string[];
      primaryDocument?: string[];
    };
  };
}

export function submissionsToProfile(submissions: Submissions, extraTickers: readonly Ticker[] = []): FilerProfile | undefined {
  // The CIK is the key, so a filer with no ticker at all is still a filer.
  let entity: Entity;
  try {
    entity = toCik(submissions.cik ?? "");
  } catch {
    return undefined;
  }

  const tickers = [...new Set([
    ...(submissions.tickers ?? []).filter(Boolean).map(toTicker),
    ...extraTickers,
  ])].sort((a, b) => a.length - b.length || a.localeCompare(b));

  const recent = submissions.filings?.recent;
  const filings: FilingRef[] = [];
  const forms = recent?.form ?? [];

  for (let i = 0; i < forms.length; i++) {
    const filingDate = recent?.filingDate?.[i];
    const form = forms[i];
    if (!filingDate || !form) continue;
    filings.push({
      form,
      filedAt: isoDate(filingDate),
      accession: recent?.accessionNumber?.[i] ?? "",
      primaryDocument: recent?.primaryDocument?.[i] ?? "",
    });
  }

  filings.sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  const sic = String(submissions.sic ?? "").trim();

  return {
    entity,
    cik: entity,
    tickers,
    name: submissions.name ?? String(entity),
    sic,
    sector: sectorForSic(sic),
    filings,
  };
}

// ── Filing text, for stage-2 survivors only ───────────────────────────────────

const stripHtml = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Pull one numbered item out of a 10-K or 10-Q.
 *
 * Filings put the item headings in a table of contents as well as the body, so the
 * *last* match that has substantial text after it is the real section.
 */
export function extractItem(text: string, itemPattern: RegExp, nextPattern: RegExp): string {
  const starts = [...text.matchAll(itemPattern)].map((m) => m.index ?? -1).filter((i) => i >= 0);
  if (starts.length === 0) return "";

  let best = "";
  for (const start of starts) {
    const rest = text.slice(start);
    const next = rest.slice(200).search(nextPattern);
    const section = next >= 0 ? rest.slice(0, next + 200) : rest;
    if (section.length > best.length) best = section;
  }
  return best.slice(0, FILING_EXCERPT_CHARS).trim();
}

export interface FetchedFiling {
  readonly form: string;
  readonly filedAt: ISODate;
  readonly accession: string;
  readonly mdna: string;
  readonly riskFactors: string;
}

export function filingUrl(cik: CIK, filing: FilingRef): string {
  const accession = filing.accession.replace(/-/g, "");
  // EDGAR's archive path drops the leading zeros from the CIK.
  return `${EDGAR_BASE}/Archives/edgar/data/${Number(cik)}/${accession}/${filing.primaryDocument}`;
}

export async function fetchFilingText(
  client: EdgarClient,
  cik: CIK,
  filing: FilingRef,
): Promise<FetchedFiling> {
  const html = await client.getText(filingUrl(cik, filing));
  const text = stripHtml(html);

  return {
    form: filing.form,
    filedAt: filing.filedAt,
    accession: filing.accession,
    mdna: extractItem(text, /Item\s+7\.?\s*M/gi, /Item\s+7A\.?\s|Item\s+8\.?\s/i),
    riskFactors: extractItem(text, /Item\s+1A\.?\s*R/gi, /Item\s+1B\.?\s|Item\s+2\.?\s/i),
  };
}

// ── Daily index, for staying current ──────────────────────────────────────────

/** The accessions filed on one day, from EDGAR's daily index. */
export async function fetchDailyIndex(client: EdgarClient, day: ISODate): Promise<string[]> {
  const [year, month, dayOfMonth] = day.split("-");
  const quarter = Math.floor((Number(month) - 1) / 3) + 1;
  const url = `${EDGAR_BASE}/Archives/edgar/daily-index/${year}/QTR${quarter}/form.${year}${month}${dayOfMonth}.idx`;

  const body = await client.getText(url);
  const ciks = new Set<string>();
  for (const line of body.split("\n")) {
    // Fixed-width: form type, company name, CIK, date, filename.
    const match = /^(10-K|10-Q)[^\d]+(\d+)\s+\d{4}-\d{2}-\d{2}/.exec(line.trim());
    if (match?.[2]) ciks.add(toCik(match[2]));
  }
  return [...ciks];
}

/** Stable id for a cached artefact, so repeated ingests reuse the same download. */
export const cacheName = (url: string): string =>
  `${createHash("sha1").update(url).digest("hex").slice(0, 12)}-${url.split("/").pop() ?? "download"}`;
