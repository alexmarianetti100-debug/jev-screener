import { choice, noul, score } from "@typesafe-ai/sdk";
import type { SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * One question set, declared once. The answer types below are inferred from these
 * criteria — `category.choice` is a union of the four labels, not `string`.
 */
export const triageQuestions = {
  category: choice("Which team should own this ticket?", {
    billing: "Charges, invoices, refunds, subscriptions, or pricing.",
    technical: "Bugs, outages, errors, or anything that is broken.",
    account: "Login, permissions, seats, or profile changes.",
    other: "Anything that fits none of the above.",
  }),
  urgency: score("How urgently does this need a human?", [
    "Not time sensitive; a reply within a week is fine.",
    "Routine; reply within a couple of business days.",
    "Blocking the customer's work; reply today.",
    "Revenue or data is actively at risk; reply within the hour.",
  ]),
  frustrated: noul("Is the customer frustrated or upset?", {
    true: "Angry, disappointed, threatening to leave, or repeating an unanswered request.",
    false: "Neutral, patient, or positive in tone.",
  }),
  needsHuman: noul("Does this require a human, rather than a canned answer?"),
} as const;

export type Triage = SystemOneResult<typeof triageQuestions>;

/** Ask jev to triage one support ticket. */
export function triageTicket(
  client: TypeSafeClient,
  ticket: string,
  options: { signal?: AbortSignal } = {},
): Promise<Triage> {
  return client.systemOne(
    { state: { ticket }, questions: triageQuestions },
    options,
  );
}

/**
 * Turn the probabilistic answers into one routing decision.
 *
 * Every answer carries a distribution, so thresholds belong here in your code
 * rather than being guessed at by the model.
 */
export function route(triage: Triage): {
  team: keyof typeof triageQuestions.category.criteria;
  priority: "P0" | "P1" | "P2" | "P3";
  escalate: boolean;
  confident: boolean;
} {
  const { category, urgency, frustrated, needsHuman } = triage.answers;
  const priority = urgency.score >= 2.5 ? "P0" : urgency.score >= 1.5 ? "P1" : urgency.score >= 0.5 ? "P2" : "P3";

  return {
    team: category.choice,
    priority,
    escalate: frustrated.noul > 0.7 || urgency.score >= 2.5,
    confident: category.confidence >= 0.6 && needsHuman.noul !== 0.5,
  };
}
