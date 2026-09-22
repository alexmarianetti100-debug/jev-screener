/**
 * DuckDB-backed observation store.
 *
 * Two properties this file must guarantee, because nothing downstream can recover
 * them if it gets them wrong:
 *
 *  1. **Append-only.** A restatement is a new row with a later `known_at`, never an
 *     overwrite. The old number was what we knew at the time, and a store that
 *     forgets that cannot answer a point-in-time question honestly.
 *  2. **No read without an `asOf`.** The only way out of this module is
 *     `sliceAsOf()`. There is deliberately no "just give me the latest" accessor,
 *     because that is the call site where look-ahead would enter.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CacheEntry, CacheKey, CacheStats, JudgmentCache } from "./cache.ts";
import { DATA_DIR, DB_PATH } from "./constants.ts";
import {
  buildSlice, isoDate, observation,
  type Entity, type ISODate, type Observation, type ObservationSlice, type Reliability, type Ticker,
} from "./observation.ts";
import { sectorForSic, type FilerProfile } from "./universe.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  entity       VARCHAR NOT NULL,
  metric       VARCHAR NOT NULL,
  valid_at     VARCHAR NOT NULL,
  known_at     VARCHAR NOT NULL,
  value        DOUBLE  NOT NULL,
  source       VARCHAR NOT NULL,
  reliability  VARCHAR NOT NULL,
  tag          VARCHAR,
  ingested_at  TIMESTAMP DEFAULT current_timestamp
);
-- The dominant query is "every entity, a set of metrics, knowable by asOf".
CREATE INDEX IF NOT EXISTS observations_scan ON observations (metric, known_at);
CREATE INDEX IF NOT EXISTS observations_entity ON observations (entity, metric);

CREATE TABLE IF NOT EXISTS filers (
  entity     VARCHAR PRIMARY KEY,   -- the CIK
  cik        VARCHAR NOT NULL,
  tickers    JSON    NOT NULL,      -- every symbol SEC lists, primary first, often none
  name       VARCHAR NOT NULL,
  sic        VARCHAR NOT NULL,
  sector     VARCHAR NOT NULL,
  filings    JSON    NOT NULL,
  updated_at TIMESTAMP DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS judgments (
  entity                VARCHAR NOT NULL,
  question_set_version  VARCHAR NOT NULL,
  max_known_at          VARCHAR NOT NULL,
  stage                 VARCHAR NOT NULL,
  has_price             BOOLEAN NOT NULL,
  answers               JSON    NOT NULL,
  model                 VARCHAR NOT NULL,
  input_tokens          BIGINT  NOT NULL,
  output_tokens         BIGINT  NOT NULL,
  created_at            TIMESTAMP DEFAULT current_timestamp,
  PRIMARY KEY (entity, question_set_version, max_known_at, stage, has_price)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id                VARCHAR PRIMARY KEY,
  as_of                 VARCHAR NOT NULL,
  question_set_version  VARCHAR NOT NULL,
  contaminated          BOOLEAN NOT NULL,
  created_at            TIMESTAMP DEFAULT current_timestamp,
  payload               JSON    NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_log (
  source     VARCHAR NOT NULL,
  kind       VARCHAR NOT NULL,
  ok         BOOLEAN NOT NULL,
  detail     VARCHAR,
  fetched_at TIMESTAMP DEFAULT current_timestamp
);
`;

export interface RunRecord {
  readonly runId: string;
  readonly asOf: ISODate;
  readonly questionSetVersion: string;
  readonly contaminated: boolean;
  readonly payload: unknown;
}

export interface FetchStatus {
  readonly source: string;
  readonly kind: string;
  readonly lastOkAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureDetail: string | null;
  readonly failures24h: number;
}

export interface Store {
  /** Append observations. Never updates: restatements arrive as new rows. */
  appendObservations(rows: readonly Observation[]): Promise<number>;
  /**
   * The only read path. Loads every observation knowable by `asOf`, newest revision
   * of each period winning, and hands back an in-memory slice.
   */
  sliceAsOf(asOf: ISODate, options?: { metrics?: readonly string[]; entities?: readonly Entity[] }): Promise<ObservationSlice>;
  observationCount(): Promise<number>;
  /**
   * Which periods of a metric are already on file.
   *
   * A completed trading day's closes are immutable, so "already stored" is a complete
   * answer and re-appending them only duplicates. Append-only means a restatement is
   * a new row; it does not mean writing the same fact once per run.
   */
  observedPeriods(metric: string): Promise<Set<ISODate>>;
  /**
   * Drop rows that repeat a fact already stored, and report how many went.
   *
   * Append-only means a restatement is a new row, never an overwrite — it does not
   * mean the same fact belongs in the table twice. Re-reading an archive yields
   * byte-identical observations, and keeping both copies carries no information
   * while doubling every slice, which is what exhausts memory on the live universe.
   */
  compact(): Promise<number>;
  saveFilers(profiles: readonly FilerProfile[]): Promise<void>;
  loadFilers(): Promise<FilerProfile[]>;
  saveRun(run: RunRecord): Promise<void>;
  latestRun(asOf?: ISODate): Promise<RunRecord | undefined>;
  runCount(): Promise<number>;
  /** Every persisted run, oldest first — the accumulating record grading reads. */
  allRuns(): Promise<RunRecord[]>;
  recordFetch(source: string, kind: string, ok: boolean, detail?: string): Promise<void>;
  fetchStatus(): Promise<FetchStatus[]>;
  readonly cache: JudgmentCache;
  close(): Promise<void>;
}

const asString = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const asNumber = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

/**
 * DuckDB takes a single write lock per database file, so one screen, ingest or MCP
 * server at a time. The raw error names a PID and links to the docs but does not say
 * what the caller should do, so it is rewritten into something actionable.
 */
export function lockError(path: string, cause: Error): Error {
  const pid = /PID (\d+)/.exec(cause.message)?.[1];
  return new Error(
    `${path} is already open by another process${pid ? ` (PID ${pid})` : ""}. ` +
      "DuckDB allows a single writer, so only one ingest, screen or MCP server can run at a time. " +
      `Wait for it to finish${pid ? `, or check it with \`ps -p ${pid}\`` : ""}.`,
    { cause },
  );
}

export async function openStore(path: string = DB_PATH): Promise<Store> {
  if (path !== ":memory:") await mkdir(dirname(path) || DATA_DIR, { recursive: true });

  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(path);
  } catch (error) {
    const message = (error as Error).message ?? "";
    throw /Could not set lock|Conflicting lock/i.test(message) ? lockError(path, error as Error) : error;
  }
  const connection = await instance.connect();
  // The judgment table is a cache, so a shape change is migrated by rebuilding it
  // rather than by an ALTER. Losing it costs one re-judgment; serving entries keyed
  // on a column that no longer means the same thing would cost correctness.
  const judgmentColumns = await connection.runAndReadAll(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'judgments'",
  );
  const existing = judgmentColumns.getRows().map((row) => String(row[0]));
  if (existing.length > 0 && !existing.includes("has_price")) {
    await connection.run("DROP TABLE judgments");
  }

  for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await connection.run(statement);
  }

  let hits = 0;
  let misses = 0;
  let writes = 0;

  const cache: JudgmentCache = {
    async get<T>(key: CacheKey): Promise<CacheEntry<T> | undefined> {
      const reader = await connection.runAndReadAll(
        `SELECT answers, model, input_tokens, output_tokens, created_at FROM judgments
         WHERE entity = $1 AND question_set_version = $2 AND max_known_at = $3 AND stage = $4
           AND has_price = $5`,
        [key.entity, key.questionSetVersion, key.maxKnownAt, key.stage, key.hasPrice],
      );
      const row = reader.getRowObjectsJS()[0];
      if (!row) {
        misses++;
        return undefined;
      }
      hits++;
      return {
        key,
        value: JSON.parse(asString(row["answers"])) as T,
        model: asString(row["model"]),
        inputTokens: asNumber(row["input_tokens"]),
        outputTokens: asNumber(row["output_tokens"]),
        createdAt: asString(row["created_at"]),
      };
    },

    async put<T>(entry: CacheEntry<T>): Promise<void> {
      // A judgment for a given key is immutable — same inputs, same question set.
      await connection.run(
        `INSERT OR REPLACE INTO judgments
           (entity, question_set_version, max_known_at, stage, has_price, answers, model, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.key.entity, entry.key.questionSetVersion, entry.key.maxKnownAt, entry.key.stage,
          entry.key.hasPrice,
          JSON.stringify(entry.value), entry.model, entry.inputTokens, entry.outputTokens,
        ],
      );
      writes++;
    },

    stats: (): CacheStats => ({ hits, misses, writes }),
  };

  return {
    async appendObservations(rows) {
      if (rows.length === 0) return 0;
      const appender = await connection.createAppender("observations");
      try {
        for (const row of rows) {
          appender.appendVarchar(row.entity);
          appender.appendVarchar(row.metric);
          appender.appendVarchar(row.validAt);
          appender.appendVarchar(row.knownAt);
          appender.appendDouble(row.value);
          appender.appendVarchar(row.source);
          appender.appendVarchar(row.reliability);
          if (row.tag === undefined) appender.appendNull();
          else appender.appendVarchar(row.tag);
          appender.appendDefault(); // ingested_at
          appender.endRow();
        }
        appender.flushSync();
      } finally {
        appender.closeSync();
      }
      return rows.length;
    },

    async sliceAsOf(asOf, options = {}) {
      const filters: string[] = ["known_at <= $asOf"];
      const params: Record<string, string> = { asOf };

      if (options.metrics?.length) {
        const list = options.metrics.map((m, i) => {
          params[`m${i}`] = m;
          return `$m${i}`;
        });
        filters.push(`metric IN (${list.join(", ")})`);
      }
      if (options.entities?.length) {
        const list = options.entities.map((e, i) => {
          params[`e${i}`] = e;
          return `$e${i}`;
        });
        filters.push(`entity IN (${list.join(", ")})`);
      }

      // The newest revision of each (entity, metric, period) that was knowable.
      const reader = await connection.runAndReadAll(
        `SELECT entity, metric, valid_at, known_at, value, source, reliability, tag
         FROM (
           SELECT *, row_number() OVER (
             PARTITION BY entity, metric, valid_at ORDER BY known_at DESC, ingested_at DESC
           ) AS revision
           FROM observations
           WHERE ${filters.join(" AND ")}
         )
         WHERE revision = 1`,
        params,
      );

      const rows = reader.getRowObjectsJS().map((row) => {
        const tag = row["tag"];
        const base = {
          value: asNumber(row["value"]),
          metric: asString(row["metric"]),
          entity: asString(row["entity"]) as Entity,
          validAt: isoDate(asString(row["valid_at"])),
          knownAt: isoDate(asString(row["known_at"])),
          source: asString(row["source"]),
          reliability: asString(row["reliability"]) as Reliability,
        };
        return observation(tag === null || tag === undefined ? base : { ...base, tag: String(tag) });
      });

      // buildSlice re-applies the point-in-time rules, so the SQL above and the
      // in-memory path used by tests can never drift apart.
      return buildSlice(rows, asOf);
    },

    async observationCount() {
      const reader = await connection.runAndReadAll("SELECT count(*) AS n FROM observations");
      return asNumber(reader.getRowObjectsJS()[0]?.["n"]);
    },

    async observedPeriods(metric) {
      const reader = await connection.runAndReadAll(
        "SELECT DISTINCT valid_at FROM observations WHERE metric = $1", [metric]);
      return new Set(reader.getRows().map((row) => isoDate(asString(row[0]))));
    },

    async compact() {
      const before = await connection.runAndReadAll("SELECT count(*) AS n FROM observations");
      const start = asNumber(before.getRowObjectsJS()[0]?.["n"]);

      // Rebuild rather than DELETE: on millions of rows a grouped anti-join scan is
      // far cheaper than deleting row by row, and the table is rewritten compactly.
      await connection.run(`
        CREATE OR REPLACE TABLE observations_compacted AS
        SELECT entity, metric, valid_at, known_at, value, source, reliability, tag,
               min(ingested_at) AS ingested_at
        FROM observations
        GROUP BY entity, metric, valid_at, known_at, value, source, reliability, tag`);
      await connection.run("DROP TABLE observations");
      await connection.run("ALTER TABLE observations_compacted RENAME TO observations");
      await connection.run(`
        CREATE INDEX IF NOT EXISTS observations_scan ON observations (metric, known_at);
        CREATE INDEX IF NOT EXISTS observations_entity ON observations (entity, metric);`);

      const after = await connection.runAndReadAll("SELECT count(*) AS n FROM observations");
      return start - asNumber(after.getRowObjectsJS()[0]?.["n"]);
    },

    async saveFilers(profiles) {
      for (const profile of profiles) {
        await connection.run(
          `INSERT OR REPLACE INTO filers (entity, cik, tickers, name, sic, sector, filings, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
          [profile.entity, profile.cik, JSON.stringify(profile.tickers), profile.name,
           profile.sic, profile.sector, JSON.stringify(profile.filings)],
        );
      }
    },

    async loadFilers() {
      const reader = await connection.runAndReadAll("SELECT entity, cik, tickers, name, sic, sector, filings FROM filers");
      return reader.getRowObjectsJS().map((row) => ({
        entity: asString(row["entity"]) as FilerProfile["entity"],
        cik: asString(row["cik"]) as FilerProfile["cik"],
        tickers: JSON.parse(asString(row["tickers"]) || "[]") as FilerProfile["tickers"],
        name: asString(row["name"]),
        sic: asString(row["sic"]),
        // Derived on load, not trusted from the column: the SIC is the fact, the
        // sector is a grouping we may want to change without a 15-minute re-ingest.
        sector: sectorForSic(asString(row["sic"])),
        filings: JSON.parse(asString(row["filings"])) as FilerProfile["filings"],
      }));
    },

    async saveRun(run) {
      await connection.run(
        `INSERT OR REPLACE INTO runs (run_id, as_of, question_set_version, contaminated, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [run.runId, run.asOf, run.questionSetVersion, run.contaminated, JSON.stringify(run.payload)],
      );
    },

    async latestRun(asOf) {
      const reader = asOf
        ? await connection.runAndReadAll(
            "SELECT * FROM runs WHERE as_of = $1 ORDER BY created_at DESC LIMIT 1", [asOf])
        : await connection.runAndReadAll("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1");
      const row = reader.getRowObjectsJS()[0];
      if (!row) return undefined;
      return {
        runId: asString(row["run_id"]),
        asOf: isoDate(asString(row["as_of"])),
        questionSetVersion: asString(row["question_set_version"]),
        contaminated: Boolean(row["contaminated"]),
        payload: JSON.parse(asString(row["payload"])) as unknown,
      };
    },

    async allRuns() {
      const reader = await connection.runAndReadAll(
        "SELECT run_id, as_of, question_set_version, contaminated, payload FROM runs ORDER BY created_at ASC");
      return reader.getRowObjectsJS().map((row) => ({
        runId: asString(row["run_id"]),
        asOf: isoDate(asString(row["as_of"])),
        questionSetVersion: asString(row["question_set_version"]),
        contaminated: Boolean(row["contaminated"]),
        payload: JSON.parse(asString(row["payload"])) as unknown,
      }));
    },

    async runCount() {
      const reader = await connection.runAndReadAll("SELECT count(*) AS n FROM runs");
      return asNumber(reader.getRowObjectsJS()[0]?.["n"]);
    },

    async recordFetch(source, kind, ok, detail) {
      await connection.run(
        "INSERT INTO fetch_log (source, kind, ok, detail) VALUES ($1, $2, $3, $4)",
        [source, kind, ok, detail ?? null],
      );
    },

    async fetchStatus() {
      const reader = await connection.runAndReadAll(
        `SELECT source, kind,
                max(CASE WHEN ok THEN fetched_at END)                                   AS last_ok_at,
                max(CASE WHEN NOT ok THEN fetched_at END)                               AS last_failure_at,
                arg_max(CASE WHEN NOT ok THEN detail END, fetched_at)                   AS last_failure_detail,
                count(*) FILTER (WHERE NOT ok AND fetched_at > now() - INTERVAL 1 DAY)  AS failures_24h
         FROM fetch_log GROUP BY source, kind ORDER BY source, kind`,
      );
      return reader.getRowObjectsJS().map((row) => ({
        source: asString(row["source"]),
        kind: asString(row["kind"]),
        lastOkAt: row["last_ok_at"] === null || row["last_ok_at"] === undefined ? null : String(row["last_ok_at"]),
        lastFailureAt: row["last_failure_at"] === null || row["last_failure_at"] === undefined ? null : String(row["last_failure_at"]),
        lastFailureDetail: row["last_failure_detail"] === null || row["last_failure_detail"] === undefined ? null : String(row["last_failure_detail"]),
        failures24h: asNumber(row["failures_24h"]),
      }));
    },

    cache,

    async close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
