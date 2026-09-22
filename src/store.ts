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
  type ISODate, type Observation, type ObservationSlice, type Reliability, type Ticker,
} from "./observation.ts";
import type { FilerProfile } from "./universe.ts";

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
  entity     VARCHAR PRIMARY KEY,
  cik        VARCHAR NOT NULL,
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
  answers               JSON    NOT NULL,
  model                 VARCHAR NOT NULL,
  input_tokens          BIGINT  NOT NULL,
  output_tokens         BIGINT  NOT NULL,
  created_at            TIMESTAMP DEFAULT current_timestamp,
  PRIMARY KEY (entity, question_set_version, max_known_at, stage)
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
  sliceAsOf(asOf: ISODate, options?: { metrics?: readonly string[]; entities?: readonly Ticker[] }): Promise<ObservationSlice>;
  observationCount(): Promise<number>;
  saveFilers(profiles: readonly FilerProfile[]): Promise<void>;
  loadFilers(): Promise<FilerProfile[]>;
  saveRun(run: RunRecord): Promise<void>;
  latestRun(asOf?: ISODate): Promise<RunRecord | undefined>;
  runCount(): Promise<number>;
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
         WHERE entity = $1 AND question_set_version = $2 AND max_known_at = $3 AND stage = $4`,
        [key.entity, key.questionSetVersion, key.maxKnownAt, key.stage],
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
           (entity, question_set_version, max_known_at, stage, answers, model, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.key.entity, entry.key.questionSetVersion, entry.key.maxKnownAt, entry.key.stage,
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
          entity: asString(row["entity"]) as Ticker,
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

    async saveFilers(profiles) {
      for (const profile of profiles) {
        await connection.run(
          `INSERT OR REPLACE INTO filers (entity, cik, name, sic, sector, filings, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          [profile.entity, profile.cik, profile.name, profile.sic, profile.sector, JSON.stringify(profile.filings)],
        );
      }
    },

    async loadFilers() {
      const reader = await connection.runAndReadAll("SELECT entity, cik, name, sic, sector, filings FROM filers");
      return reader.getRowObjectsJS().map((row) => ({
        entity: asString(row["entity"]) as FilerProfile["entity"],
        cik: asString(row["cik"]) as FilerProfile["cik"],
        name: asString(row["name"]),
        sic: asString(row["sic"]),
        sector: asString(row["sector"]),
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
