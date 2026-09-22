/**
 * Can jev tell which company it is looking at?
 *
 * This measures contamination rather than performance. A historical screen is only
 * worth running if jev cannot recognise the companies in it: recognition is how
 * hindsight gets in, because a model that knows the name knows how the story ended.
 *
 * The test is verifiable, which most contamination tests are not. jev answers in
 * types, never free text, so it cannot be asked to *name* a company and checked
 * against a string. Instead it gets four candidates — the real filer plus three
 * decoys drawn from the same sector and the nearest revenue — and picks one. Chance
 * is 25%. Anything meaningfully above that is recall.
 *
 * Two conditions, because they leak differently:
 *
 *   - **numbers**: metrics and peer context only. Can a financial fingerprint alone
 *     identify a company?
 *   - **text**: the same, plus a redacted MD&A and Risk Factors excerpt. Does the
 *     prose give it away even with the names stripped out?
 *
 * The gap between them says whether redaction is worth attempting at all.
 */

import { choice } from "@typesafe-ai/sdk";
import type { SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import type { MetricRow } from "./metrics.ts";
import type { JsonValue } from "@typesafe-ai/sdk";

/** Fixed slots, because `choice` criteria are declared at compile time. */
export const SLOTS = ["a", "b", "c", "d"] as const;
export type Slot = (typeof SLOTS)[number];

export const probeQuestions = {
  identify: choice(
    "One of these companies filed the report described below. Which one?",
    {
      a: "Candidate A.",
      b: "Candidate B.",
      c: "Candidate C.",
      d: "Candidate D.",
      unknown: "The evidence does not identify any of them over the others.",
    },
  ),
} as const;

export type ProbeResult = SystemOneResult<typeof probeQuestions>;

const CORPORATE_NOISE = new Set([
  "inc", "corp", "corporation", "company", "co", "ltd", "limited", "plc", "llc", "lp",
  "holdings", "holding", "group", "the", "and", "trust", "class", "common", "stock",
  "international", "industries", "enterprises", "technologies", "systems", "services",
]);

/**
 * Words worth hiding from a filing: the distinctive parts of a company's own name.
 *
 * Generic corporate furniture is left alone — redacting "Holdings" or "Systems" from
 * every filing would mangle the prose without hiding anything, since those words
 * identify nobody.
 */
export function identifyingWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !CORPORATE_NOISE.has(word));
}

/** Replace a filer's own name, and any candidate's, with a placeholder. */
export function redact(text: string, names: readonly string[]): string {
  const words = [...new Set(names.flatMap(identifyingWords))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const word of words) {
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*\\b`, "gi"), "[REDACTED]");
  }
  return out;
}

export interface ProbeSlate {
  readonly truth: Slot;
  /** Slot → company name, the real filer in `truth`. */
  readonly candidates: Readonly<Record<Slot, string>>;
}

/**
 * Put the real filer in a slot and fill the rest with decoys.
 *
 * The slot is chosen from the entity id rather than at random, so a probe run is
 * reproducible and cannot be re-rolled until it says something convenient.
 */
export function buildSlate(realName: string, decoys: readonly string[], entity: string): ProbeSlate {
  const seed = [...entity].reduce((total, char) => total + char.charCodeAt(0), 0);
  const truth = SLOTS[seed % SLOTS.length]!;

  const pool = [...decoys];
  const candidates = {} as Record<Slot, string>;
  for (const slot of SLOTS) {
    candidates[slot] = slot === truth ? realName : (pool.shift() ?? `Undisclosed filer ${slot.toUpperCase()}`);
  }
  return { truth, candidates };
}

export function buildProbeState(
  row: MetricRow,
  slate: ProbeSlate,
  filingText: string | undefined,
): Record<string, JsonValue> {
  const metrics: Record<string, number> = {};
  for (const [metric, value] of Object.entries(row.metrics)) {
    if (value) metrics[metric] = Number(value.value.toFixed(4));
  }

  return {
    candidates: slate.candidates,
    asOf: row.asOf,
    // Sector is withheld: naming it would narrow four candidates to one for most
    // slates, and the question is what the filing reveals, not what we hand over.
    metrics,
    ...(filingText ? { filing: filingText } : {}),
  };
}

export function askProbe(
  client: TypeSafeClient,
  row: MetricRow,
  slate: ProbeSlate,
  filingText: string | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  return client.systemOne({ state: buildProbeState(row, slate, filingText), questions: probeQuestions }, options);
}

export interface ConditionResult {
  readonly condition: string;
  readonly n: number;
  readonly correct: number;
  readonly unknown: number;
  /** Correct answers as a share of everything asked. Chance is 0.25. */
  readonly accuracy: number;
  /** Correct as a share of the times it committed to a name at all. */
  readonly accuracyWhenCommitted: number;
  /** Mean confidence jev reported on the slot it chose. */
  readonly meanConfidence: number;
}

export interface ProbeReport {
  readonly sampled: number;
  readonly conditions: readonly ConditionResult[];
  /**
   * Accuracy by revenue band, per condition.
   *
   * Split by condition on purpose: pooling them averages a condition that abstains
   * every time with one that almost never misses, and the average describes neither.
   */
  readonly byRevenueBand: readonly {
    readonly condition: string; readonly band: string; readonly n: number; readonly accuracy: number;
  }[];
  readonly reading: string;
}

export interface ProbeOutcome {
  readonly condition: string;
  readonly entity: string;
  readonly label: string;
  readonly revenue: number | undefined;
  readonly chosen: string;
  readonly truth: Slot;
  readonly confidence: number;
}

export const CHANCE = 1 / SLOTS.length;

export function summariseProbe(outcomes: readonly ProbeOutcome[], sampled: number): ProbeReport {
  const conditions = [...new Set(outcomes.map((o) => o.condition))].map<ConditionResult>((condition) => {
    const rows = outcomes.filter((o) => o.condition === condition);
    const committed = rows.filter((o) => o.chosen !== "unknown");
    const correct = rows.filter((o) => o.chosen === o.truth).length;
    return {
      condition,
      n: rows.length,
      correct,
      unknown: rows.length - committed.length,
      accuracy: rows.length ? correct / rows.length : 0,
      accuracyWhenCommitted: committed.length ? correct / committed.length : 0,
      meanConfidence: rows.length ? rows.reduce((t, o) => t + o.confidence, 0) / rows.length : 0,
    };
  });

  const byRevenueBand = conditions.flatMap(({ condition }) => {
    const sorted = outcomes
      .filter((o) => o.condition === condition && typeof o.revenue === "number")
      .sort((a, b) => (a.revenue ?? 0) - (b.revenue ?? 0));
    const third = Math.ceil(sorted.length / 3) || 1;

    return ([
      ["smallest third by revenue", sorted.slice(0, third)],
      ["middle third", sorted.slice(third, third * 2)],
      ["largest third by revenue", sorted.slice(third * 2)],
    ] as const)
      .filter(([, rows]) => rows.length > 0)
      .map(([band, rows]) => ({
        condition, band, n: rows.length,
        accuracy: rows.filter((o) => o.chosen === o.truth).length / rows.length,
      }));
  });

  const best = conditions.reduce((a, b) => (b.accuracy > a.accuracy ? b : a), conditions[0] ?? {
    condition: "none", n: 0, correct: 0, unknown: 0, accuracy: 0, accuracyWhenCommitted: 0, meanConfidence: 0,
  });

  const reading = best.accuracy <= CHANCE * 1.2
    ? `Recognition is at or near chance (${(CHANCE * 100).toFixed(0)}%). A historical run is less exposed to recall than assumed — though a model can recognise a situation without naming it, so this bounds the risk rather than removing it.`
    : `Recognition runs at ${(best.accuracy * 100).toFixed(0)}% against ${(CHANCE * 100).toFixed(0)}% chance under "${best.condition}". jev identifies these companies, so anything it says about their past is partly recall, and a historical screen over this universe cannot be read as skill.`;

  return { sampled, conditions, byRevenueBand, reading };
}
