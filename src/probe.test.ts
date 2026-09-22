import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANCE, SLOTS, buildProbeState, buildSlate, identifyingWords, redact, summariseProbe,
  type ProbeOutcome, type Slot,
} from "./probe.ts";
import { cik, isoDate } from "./observation.ts";

const row = (label: string) => ({
  entity: cik(1), label, sector: "retail", asOf: isoDate("2026-09-22"),
  metrics: {}, obligations: {}, inputs: [], hasPrice: false,
});

const outcome = (condition: string, chosen: string, truth: Slot, revenue: number): ProbeOutcome =>
  ({ condition, entity: "1", label: "X", revenue, chosen, truth, confidence: 0.8 });

test("only the distinctive part of a name is worth hiding", () => {
  assert.deepEqual(identifyingWords("Apple Inc."), ["apple"]);
  assert.deepEqual(identifyingWords("Lockheed Martin Corp"), ["lockheed", "martin"]);
  // Redacting generic furniture from every filing would mangle prose and hide nobody.
  assert.deepEqual(identifyingWords("Acme Holdings Group International"), ["acme"]);
});

test("redaction catches inflections, and demonstrably leaks stem-derived brands", () => {
  const text = "Chipotle's restaurants grew. Chipotlanes drove digital sales at Chipotle.";
  const out = redact(text, ["Chipotle Mexican Grill, Inc."]);

  assert.equal(out.includes("Chipotle"), false, "the name and its possessive go");
  assert.ok(out.includes("restaurants"), "ordinary words survive");

  // "Chipotlane" shares a stem with "Chipotle" but not a prefix — it diverges at the
  // eighth character — so a word-prefix match cannot reach it. Matching a shorter
  // stem would fix this case and wreck others: "appl" would swallow "applied" and
  // "appliance", removing the business content the probe needs to test.
  //
  // So redaction is leaky by construction, and this test says so rather than hiding
  // it. That leak is exactly what the `text` condition measures: if recognition is
  // far higher with text than with numbers alone, this is why, and anonymisation is
  // not a route to an honest historical run.
  assert.ok(out.includes("Chipotlanes"), "a stem-derived brand survives redaction");
});

test("every candidate's name is stripped, not only the real one", () => {
  // Leaving decoy names in would let the answer be found by elimination.
  const out = redact("Kroger competes with Albertsons.", ["Kroger Co", "Albertsons Companies"]);
  assert.equal(/Kroger|Albertsons/.test(out), false);
});

test("the slate puts the truth somewhere reproducible, with decoys elsewhere", () => {
  const slate = buildSlate("Real Co", ["Decoy One", "Decoy Two", "Decoy Three"], "0000320193");
  const again = buildSlate("Real Co", ["Decoy One", "Decoy Two", "Decoy Three"], "0000320193");

  assert.equal(slate.truth, again.truth, "same company, same slot — a probe cannot be re-rolled");
  assert.equal(slate.candidates[slate.truth], "Real Co");
  assert.equal(SLOTS.filter((s) => slate.candidates[s] === "Real Co").length, 1, "the truth appears once");
  assert.equal(new Set(Object.values(slate.candidates)).size, 4, "four distinct names");
});

test("the state hands over the candidates and nothing that narrows them", () => {
  const slate = buildSlate("Real Co", ["A Co", "B Co", "C Co"], "1");
  const state = buildProbeState(row("REAL"), slate, undefined);

  assert.deepEqual(state["candidates"], slate.candidates);
  assert.equal(state["filing"], undefined, "the numbers-only condition carries no text");
  // Sector or ticker would collapse four candidates to one without jev knowing anything.
  assert.equal(state["sector"], undefined);
  assert.equal(state["ticker"], undefined);
  assert.equal(state["label"], undefined);
});

test("chance is a quarter, and a result at chance reads as no recognition", () => {
  assert.equal(CHANCE, 0.25);

  // One correct in four, which is exactly chance.
  const outcomes = [
    outcome("numbers", "a", "a", 1), outcome("numbers", "b", "a", 2),
    outcome("numbers", "c", "a", 3), outcome("numbers", "d", "a", 4),
  ];
  const report = summariseProbe(outcomes, 4);

  assert.equal(report.conditions[0]?.accuracy, 0.25);
  assert.match(report.reading, /at or near chance/);
  assert.match(report.reading, /bounds the risk rather than removing it/);
});

test("recognition well above chance reads as recall, and says so", () => {
  const outcomes = [
    outcome("text", "a", "a", 1), outcome("text", "a", "a", 2),
    outcome("text", "a", "a", 3), outcome("text", "b", "a", 4),
  ];
  const report = summariseProbe(outcomes, 4);

  assert.equal(report.conditions[0]?.accuracy, 0.75);
  assert.match(report.reading, /cannot be read as skill/);
});

test("abstentions are separated from wrong answers", () => {
  const outcomes = [
    outcome("numbers", "unknown", "a", 1), outcome("numbers", "unknown", "a", 2),
    outcome("numbers", "a", "a", 3), outcome("numbers", "b", "a", 4),
  ];
  const report = summariseProbe(outcomes, 4)!.conditions[0]!;

  assert.equal(report.unknown, 2);
  assert.equal(report.accuracy, 0.25, "correct over everything asked");
  // Declining to guess is not the same as guessing wrong, and conflating them would
  // understate how well it does when it commits.
  assert.equal(report.accuracyWhenCommitted, 0.5);
});

test("accuracy is broken out by size within each condition, never across them", () => {
  const outcomes = [
    outcome("text", "b", "a", 1), outcome("text", "b", "a", 2),        // small: wrong
    outcome("text", "b", "a", 3), outcome("text", "a", "a", 4),        // mid
    outcome("text", "a", "a", 5), outcome("text", "a", "a", 6),        // large: right
    outcome("numbers", "unknown", "a", 1), outcome("numbers", "unknown", "a", 2),
    outcome("numbers", "unknown", "a", 3), outcome("numbers", "unknown", "a", 4),
    outcome("numbers", "unknown", "a", 5), outcome("numbers", "unknown", "a", 6),
  ];
  const bands = summariseProbe(outcomes, 6).byRevenueBand;

  const text = bands.filter((b) => b.condition === "text");
  assert.equal(text.length, 3);
  assert.equal(text[0]?.accuracy, 0, "smallest third unrecognised");
  assert.equal(text[2]?.accuracy, 1, "largest third recognised");

  // Pooling would average a condition that abstains every time with one that rarely
  // misses, and report a middle number describing neither.
  assert.equal(bands.filter((b) => b.condition === "numbers").every((b) => b.accuracy === 0), true);
});
