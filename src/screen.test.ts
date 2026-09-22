import assert from "node:assert/strict";
import test from "node:test";
import { CONTAMINATION_WINDOW_DAYS } from "./constants.ts";
import type { DerivedMetric } from "./metrics.ts";
import { cik,isoDate, ticker, type Ticker } from "./observation.ts";
import {
  ContaminatedRunError, assemble, assertRunnable,
  judgmentQuestionSet, type Judged, type JudgmentResult,
} from "./screen.ts";

type Verdict = "include" | "watch" | "exclude";
type Sufficiency = "sufficient" | "thin" | "insufficient";

function judged(
  symbol: string,
  verdict: Verdict,
  attractiveness: number,
  sufficiency: Sufficiency = "sufficient",
): Judged {
  const answers = {
    verdict: { type: "choice", choice: verdict, confidence: 0.9, probabilities: {} },
    attractiveness: { type: "score", score: attractiveness, confidence: 0.8, legend: {}, probabilities: {} },
    durability: { type: "score", score: 3, confidence: 0.7, legend: {}, probabilities: {} },
    accountingQuality: { type: "choice", choice: "clean", confidence: 0.8, probabilities: {} },
    dominantRisk: { type: "choice", choice: "demand", confidence: 0.6, probabilities: {} },
    managementCandor: { type: "choice", choice: "direct", confidence: 0.7, probabilities: {} },
    sufficiency: { type: "choice", choice: sufficiency, confidence: 0.9, probabilities: {} },
  };

  return {
    entity: cik([...symbol].map((c) => c.charCodeAt(0)).join("")),
    label: symbol,
    sector: "manufacturing",
    fromCache: false,
    metrics: {} as Partial<Record<DerivedMetric, number>>,
    result: { model: "jev", answers, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as JudgmentResult,
  };
}

const symbols = (picks: readonly { label: string }[]): string[] => picks.map((p) => p.label);

test("inclusion is read off verdict.choice, not off a probability", () => {
  const picks = assemble([
    judged("AAA", "include", 3),
    judged("BBB", "watch", 4.9),   // higher score, but jev said watch
    judged("CCC", "exclude", 4.8),
  ]);

  assert.deepEqual(symbols(picks), ["AAA"]);
});

test("ordering is attractiveness.score, descending", () => {
  const picks = assemble([
    judged("LOW", "include", 1.2),
    judged("HIGH", "include", 4.4),
    judged("MID", "include", 2.9),
  ]);

  assert.deepEqual(symbols(picks), ["HIGH", "MID", "LOW"]);
});

test("equal scores keep jev's order rather than being tie-broken", () => {
  const picks = assemble([
    judged("FIRST", "include", 3),
    judged("SECOND", "include", 3),
    judged("THIRD", "include", 3),
  ]);

  // No alphabetical or metric-based tie-break may sneak in.
  assert.deepEqual(symbols(picks), ["FIRST", "SECOND", "THIRD"]);
});

test("jev's own 'insufficient' excludes a company it otherwise included", () => {
  const picks = assemble([
    judged("GOOD", "include", 3, "sufficient"),
    judged("THIN", "include", 4.5, "thin"),          // provisional, still included
    judged("BLIND", "include", 4.9, "insufficient"), // jev disowned its own verdict
  ]);

  assert.deepEqual(symbols(picks), ["THIN", "GOOD"]);
});

test("a fresh asOf runs clean", () => {
  const stamp = assertRunnable(isoDate("2026-09-01"), false, isoDate("2026-09-03"));

  assert.equal(stamp.contaminated, false);
  assert.equal(stamp.daysStale, 2);
  assert.equal(stamp.notice, undefined);
});

test("the boundary day itself is still clean", () => {
  const stamp = assertRunnable(isoDate("2026-09-01"), false, isoDate("2026-09-08"));
  assert.equal(stamp.daysStale, CONTAMINATION_WINDOW_DAYS);
  assert.equal(stamp.contaminated, false);
});

test("a stale asOf refuses to run without the explicit flag", () => {
  assert.throws(
    () => assertRunnable(isoDate("2024-01-01"), false, isoDate("2026-09-01")),
    (error: unknown) => {
      assert.ok(error instanceof ContaminatedRunError);
      assert.match(error.message, /hindsight, not skill/);
      assert.match(error.message, /allowContaminated/);
      return true;
    },
  );
});

test("the flag lets it run, and stamps every result as contaminated", () => {
  const stamp = assertRunnable(isoDate("2024-01-01"), true, isoDate("2026-09-01"));

  assert.equal(stamp.contaminated, true);
  assert.ok(stamp.daysStale > 600);
  assert.match(stamp.notice ?? "", /CONTAMINATED/);
  assert.match(stamp.notice ?? "", /must not be used to evaluate/);
});

test("the question sets are the shapes the rules require", () => {
  // Discrete decisions must be `choice`; ordered ones must be `score`.
  assert.equal(judgmentQuestionSet.verdict.type, "choice");
  assert.equal(judgmentQuestionSet.attractiveness.type, "score");
  assert.equal(judgmentQuestionSet.durability.type, "score");
  assert.equal(judgmentQuestionSet.sufficiency.type, "choice");

  // The horizon is two questions: what settles it (discrete) and when (ordered).
  assert.equal(judgmentQuestionSet.horizonDriver.type, "choice");
  assert.equal(judgmentQuestionSet.horizonBand.type, "score");
  assert.equal(judgmentQuestionSet.horizonBand.criteria.length, 5, "five periods, shortest first");
  assert.ok(judgmentQuestionSet.attractiveness.criteria.length >= 2);

  // No noul question may exist in either set, because noul must never drive flow.
  const types = Object.values(judgmentQuestionSet).map((q) => q.type);
  assert.equal(types.includes("noul" as never), false);
});

// ── The audit, as a test ──────────────────────────────────────────────────────

test("no decision threshold has crept into the judgment path", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = ["metrics.ts", "peers.ts", "screen.ts", "universe.ts", "cli.ts", "cache.ts"];
  const offenders: string[] = [];

  for (const file of files) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");

    for (const [index, line] of source.split("\n").entries()) {
      const code = line.replace(/\/\/.*$/, "").replace(/\*.*$/, "");
      // The signature of a threshold: comparing something against a fractional
      // literal. `score >= 2.5`, `confidence > 0.6`, `noul < 0.3`.
      if (/[<>]=?\s*-?\d*\.\d+/.test(code) || /-?\d*\.\d+\s*[<>]=?/.test(code)) {
        offenders.push(`${file}:${index + 1}  ${line.trim()}`);
      }
      // noul answers may be displayed but must never drive control flow.
      if (/\bnoul\b/.test(code) && /\bif\s*\(|\?|&&|\|\|/.test(code)) {
        offenders.push(`${file}:${index + 1}  noul in control flow: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `decision constants found:\n${offenders.join("\n")}`);
});

test("the only tunable numbers live in constants.ts, and are operational", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./constants.ts", import.meta.url), "utf8");
  const exported = [...source.matchAll(/export const (\w+)\s*=\s*(.+?);/g)].map((m) => m[1]!);

  // Every constant must be one an operator could turn without deciding anything
  // about a company: throughput, spend, cadence, data availability, or display.
  assert.deepEqual(exported.sort(), [
    "BULK_DOWNLOAD_TIMEOUT_MS",
    "CACHE_DIR",
    "CONTAMINATION_WINDOW_DAYS",
    "DATA_DIR",
    "DB_PATH",
    "DEFAULT_SCREEN_LIMIT",
    "DOWNLOAD_PROGRESS_INTERVAL_MS",
    "EDGAR_REQUESTS_PER_SECOND",
    "FILING_EXCERPT_CHARS",
    "FILING_FETCH_POOL_SIZE",
    "HTTP_TIMEOUT_MS",
    "INGEST_BATCH_SIZE",
    "JEV_POOL_SIZE",
    "MAX_ANNUAL_REPORT_AGE_MONTHS",
    "MIN_REVENUE_QUARTERS",
    "POLYGON_REQUESTS_PER_MINUTE",
    "PRICE_BACKFILL_DAYS",
    "PRICE_SOURCE_FAILURE_LIMIT",
    "QUESTION_SET_VERSION",
  ]);
});
