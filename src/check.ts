/**
 * Preflight: confirms the API key works and that this account can actually reach jev.
 *
 * Run with `npm run check`. Exits non-zero on the first hard failure.
 *
 * Note: OpenRouter's `/api/v1/models` lists chat models only — jev is a System One
 * model and does not appear there, so a round trip is the real access test.
 */
import { APIError, AuthenticationError, PermissionDeniedError, TypeSafeError, noul } from "@typesafe-ai/sdk";
import { createClient, resolveTransport } from "./client.ts";

const pass = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
const fail = (msg: string): never => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 6 : 2)}`;

/** Ask OpenRouter about the key itself. Independent of jev — isolates auth from model access. */
async function checkOpenRouterKey(apiKey: string, baseURL: string): Promise<void> {
  const response = await fetch(`${baseURL}/v1/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (response.status === 401) fail("OpenRouter rejected the key (401). Check OPENROUTER_API_KEY in .env.");
  if (!response.ok) {
    warn(`could not read key info (HTTP ${response.status}); continuing to the live call`);
    return;
  }

  const { data } = (await response.json()) as {
    data: { label: string; limit: number | null; limit_remaining: number | null; usage: number; expires_at: string | null };
  };
  pass(`key accepted — ${data.label}`);

  if (data.limit_remaining !== null && data.limit !== null) {
    const line = `credit ${usd(data.limit_remaining)} of ${usd(data.limit)} remaining (used ${usd(data.usage)})`;
    data.limit_remaining <= 0 ? fail(`${line} — out of credit`) : pass(line);
  }
  if (data.expires_at) {
    const daysLeft = Math.round((Date.parse(data.expires_at) - Date.now()) / 86_400_000);
    daysLeft <= 14
      ? warn(`key expires in ${daysLeft} day(s), on ${data.expires_at.slice(0, 10)}`)
      : pass(`key valid until ${data.expires_at.slice(0, 10)} (${daysLeft} days)`);
  }
}

async function main(): Promise<void> {
  console.log("\nTypeSafe jev preflight\n");

  console.log("Transport");
  const transport = resolveTransport();
  const viaOpenRouter = transport !== null;
  if (viaOpenRouter) {
    pass(`OpenRouter → ${transport.baseURL}/v1/systemone`);
  } else if (process.env.TYPESAFE_API_KEY?.trim()) {
    pass("TypeSafe direct (no OPENROUTER_API_KEY set)");
  } else {
    fail("no API key found. Set OPENROUTER_API_KEY or TYPESAFE_API_KEY in .env — see .env.example.");
  }

  if (transport) {
    console.log("\nCredentials");
    await checkOpenRouterKey(transport.apiKey, transport.baseURL);
  }

  console.log("\nModel access");
  const client = createClient();
  const startedAt = performance.now();
  const result = await client
    .systemOne({
      state: { ticket: "I was charged twice for my subscription this month." },
      questions: { billing: noul("Is this ticket about billing?") },
    })
    .withResponse()
    .catch((error: unknown) => {
      if (error instanceof AuthenticationError) fail(`authentication failed (401): ${error.message}`);
      if (error instanceof PermissionDeniedError) fail(`this account cannot access ${client.defaultModel} (403): ${error.message}`);
      if (error instanceof APIError) fail(`API error ${error.status}${error.requestId ? ` (request ${error.requestId})` : ""}: ${error.message}`);
      if (error instanceof TypeSafeError) fail(`SDK error: ${error.message}`);
      throw error;
    });
  const elapsedMs = performance.now() - startedAt;

  const { data, requestId } = result;
  pass(`round trip in ${elapsedMs.toFixed(0)} ms${requestId ? ` (request ${requestId})` : ""}`);
  pass(`requested "${client.defaultModel}" → served by ${data.model}`);
  pass(`usage ${data.usage.input_tokens} in / ${data.usage.output_tokens} out tokens`);

  const answer = data.answers.billing;
  if (answer?.type !== "noul" || typeof answer.noul !== "number") {
    fail(`malformed answer: ${JSON.stringify(answer)}`);
  }
  if (answer.noul < 0 || answer.noul > 1) fail(`probability out of range: ${answer.noul}`);
  pass(`typed answer well-formed — noul = ${answer.noul.toFixed(4)}`);

  // Unambiguous question: a confident "yes" means the model is genuinely reasoning,
  // not just returning a well-shaped placeholder.
  answer.noul >= 0.9
    ? pass(`sanity check — "is this about billing?" answered yes at ${(answer.noul * 100).toFixed(1)}%`)
    : warn(`sanity check — expected a confident yes, got ${(answer.noul * 100).toFixed(1)}%. Shape is valid; double-check the model id.`);

  console.log("\nAll checks passed. jev is reachable.\n");
}

await main();
