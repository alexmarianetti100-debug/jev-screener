import { APIError, TypeSafeError } from "@typesafe-ai/sdk";
import { createClient } from "./client.ts";
import { route, triageTicket } from "./triage.ts";

const SAMPLE = "You charged my card twice this month and nobody has answered my last two emails. Refund it today or we're cancelling.";

async function readTicket(): Promise<string> {
  const fromArgs = process.argv.slice(2).join(" ").trim();
  if (fromArgs) return fromArgs;
  if (process.stdin.isTTY) return SAMPLE;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const piped = Buffer.concat(chunks).toString("utf8").trim();
  return piped || SAMPLE;
}

async function main(): Promise<void> {
  const ticket = await readTicket();
  const client = createClient();

  const triage = await triageTicket(client, ticket);
  const decision = route(triage);
  const { category, urgency, frustrated, needsHuman } = triage.answers;

  console.log(`\nTicket: ${ticket}\n`);
  console.log(`  team       ${decision.team} (${(category.confidence * 100).toFixed(0)}% confident)`);
  console.log(`  priority   ${decision.priority} — urgency ${urgency.score.toFixed(2)} of ${Object.keys(urgency.probabilities).length - 1}`);
  console.log(`  frustrated ${(frustrated.noul * 100).toFixed(0)}%`);
  console.log(`  needs human ${(needsHuman.noul * 100).toFixed(0)}%`);
  console.log(`  escalate   ${decision.escalate ? "yes" : "no"}${decision.confident ? "" : "  (low confidence — send to a human queue)"}`);
  console.log(`\n  model ${triage.model} · ${triage.usage.input_tokens} in / ${triage.usage.output_tokens} out tokens\n`);
}

try {
  await main();
} catch (error) {
  if (error instanceof APIError) {
    console.error(`TypeSafe API error ${error.status}${error.requestId ? ` (request ${error.requestId})` : ""}: ${error.message}`);
  } else if (error instanceof TypeSafeError) {
    console.error(`TypeSafe SDK error: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
