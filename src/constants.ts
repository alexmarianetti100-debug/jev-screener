/**
 * Every operational constant in the screener, in one place, so the audit rule in
 * README.md can be checked at a glance.
 *
 * The test each constant must pass: changing it may alter **which companies we are
 * able to evaluate**, **how fast we fetch**, or **how much we spend** — never **which
 * companies are good**. Nothing here ranks, scores, weights, or gates on the *value*
 * of a metric. Those judgments belong to jev, and there is no file in this project
 * that makes them in code.
 *
 * If you add a number here, write down which of those three categories it is in.
 */

// ── HTTP throttles ────────────────────────────────────────────────────────────
// Fixed by each source's published limits, enforced inside the adapter.

/** SEC's documented ceiling for automated access. */
export const EDGAR_REQUESTS_PER_SECOND = 10;

/**
 * Polygon's free tier, metered per minute rather than per second.
 *
 * Restrictive-sounding and not, because the endpoint is bulk: one request returns
 * every US ticker's close for a day, so a routine refresh needs one call and a
 * two-year backfill about 500.
 */
export const POLYGON_REQUESTS_PER_MINUTE = 5;

/**
 * Weekdays of closes to pull on a normal run, newest first.
 *
 * More than one because holidays return no bars and the exchange calendar is not
 * something this project carries. Spend and freshness only.
 */
export const PRICE_BACKFILL_DAYS = 5;

/**
 * Consecutive price-source failures before this run stops asking.
 *
 * Stooq is a free service with no status page and no bulk endpoint. When it is down,
 * 3,000 sequential doomed requests at 2/second is 25 minutes of waiting to learn
 * something the first twenty already established. Prices are optional to the
 * screener — multiples simply go missing — so giving up early and saying so beats
 * stalling the pipeline.
 */
export const PRICE_SOURCE_FAILURE_LIMIT = 20;

/** Give up on a single small HTTP request (JSON, one filing) after this long. */
export const HTTP_TIMEOUT_MS = 60_000;

/**
 * Ceiling for a bulk archive download. The SEC archives are ~1.3–1.5 GB each, so
 * the small-request timeout is off by orders of magnitude; on a slow link the real
 * constraint is bandwidth, not server responsiveness.
 */
export const BULK_DOWNLOAD_TIMEOUT_MS = 45 * 60_000;

/** Log download progress no more often than this, so a long fetch is not silent. */
export const DOWNLOAD_PROGRESS_INTERVAL_MS = 10_000;

// ── Spend and throughput ──────────────────────────────────────────────────────

/** Concurrent in-flight jev calls. Throughput only; does not affect any answer. */
export const JEV_POOL_SIZE = 8;

/**
 * Concurrent filing-text downloads. The adapter's 10/second gate still governs when
 * requests *start*; this governs how many bodies are in flight, which is what matters
 * when each document is several megabytes.
 */
export const FILING_FETCH_POOL_SIZE = 8;

/** Observations buffered before a flush to DuckDB. Memory, not meaning. */
export const INGEST_BATCH_SIZE = 50_000;

/**
 * Characters of MD&A and Risk Factors passed to stage 2. A token budget: raising it
 * costs more per company, it does not make any company look better or worse.
 */
export const FILING_EXCERPT_CHARS = 12_000;

// ── Versioning ────────────────────────────────────────────────────────────────

/**
 * Bump on ANY change to either question set in `screen.ts` — wording, criteria,
 * ordering, added or removed questions. Judgments are cached under this string, so
 * a stale version silently serves answers to a question you no longer ask.
 */
export const QUESTION_SET_VERSION = "2026-09-21.2";

// ── Contamination ─────────────────────────────────────────────────────────────

/**
 * A run whose `asOf` is older than this is contaminated: jev's training data may
 * already contain what happened next, so the result measures hindsight, not skill.
 * See `assertRunnable` in `screen.ts`.
 */
export const CONTAMINATION_WINDOW_DAYS = 7;

// ── Eligibility ───────────────────────────────────────────────────────────────
// Data availability, never data quality. These answer "can we evaluate this
// company at all", which is a question about our inputs, not about the business.
// Each references only the presence, recency, or completeness of observations.

/** An annual report older than this means we cannot describe the company today. */
export const MAX_ANNUAL_REPORT_AGE_MONTHS = 18;

/** Below this, trend arithmetic (3-year CAGR, margin trend) has nothing to chew on. */
export const MIN_REVENUE_QUARTERS = 12;

// ── Presentation defaults ─────────────────────────────────────────────────────

/** Default `limit` for screen output. Truncates display; never selects. */
export const DEFAULT_SCREEN_LIMIT = 25;

// ── Paths ─────────────────────────────────────────────────────────────────────

export const DATA_DIR = "data";
export const DB_PATH = `${DATA_DIR}/jev.duckdb`;
export const CACHE_DIR = `${DATA_DIR}/cache`;
