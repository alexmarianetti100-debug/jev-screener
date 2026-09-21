import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "./client.ts";
import { route, triageTicket } from "./triage.ts";
import type { Triage } from "./triage.ts";

/** A client whose transport is a stub, so tests never touch the network. */
function stubClient(answers: Triage["answers"]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = createClient({
    apiKey: "test-key",
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 42, output_tokens: 7 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { client, calls };
}

const angryBilling: Triage["answers"] = {
  category: {
    type: "choice",
    choice: "billing",
    confidence: 0.91,
    probabilities: { billing: 0.91, technical: 0.04, account: 0.03, other: 0.02 },
  },
  urgency: {
    type: "score",
    score: 2.8,
    confidence: 0.77,
    legend: { 0: null, 1: null, 2: null, 3: null },
    probabilities: { 0: 0.01, 1: 0.05, 2: 0.07, 3: 0.87 },
  },
  frustrated: { type: "noul", noul: 0.94 },
  needsHuman: { type: "noul", noul: 0.88 },
} as unknown as Triage["answers"];

test("sends the ticket and every question to /v1/systemone", async () => {
  const { client, calls } = stubClient(angryBilling);
  await triageTicket(client, "charged twice");

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/systemone$/);
  const body = calls[0]!.body as { state: { ticket: string }; questions: Record<string, unknown>; model: string };
  assert.equal(body.state.ticket, "charged twice");
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), ["category", "urgency", "frustrated", "needsHuman"]);
});

test("routes an angry billing ticket to P0 and escalates", async () => {
  const { client } = stubClient(angryBilling);
  const decision = route(await triageTicket(client, "charged twice"));

  assert.deepEqual(decision, { team: "billing", priority: "P0", escalate: true, confident: true });
});

test("a low-confidence category is not treated as confident", async () => {
  const hedged = structuredClone(angryBilling) as { category: { confidence: number } };
  hedged.category.confidence = 0.41;

  const { client } = stubClient(hedged as unknown as Triage["answers"]);
  const decision = route(await triageTicket(client, "not sure what this is"));

  assert.equal(decision.confident, false);
});

test("a calm, routine ticket stays low priority", async () => {
  const calm = structuredClone(angryBilling) as { urgency: { score: number }; frustrated: { noul: number } };
  calm.urgency.score = 0.9;
  calm.frustrated.noul = 0.08;

  const { client } = stubClient(calm as unknown as Triage["answers"]);
  const decision = route(await triageTicket(client, "how do I change my plan?"));

  assert.equal(decision.priority, "P2");
  assert.equal(decision.escalate, false);
});
