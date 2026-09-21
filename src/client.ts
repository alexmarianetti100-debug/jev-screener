import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { TypeSafeClientConfig } from "@typesafe-ai/sdk";

/** OpenRouter's API root. The SDK appends `/v1/systemone` to whatever root it is given. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

/**
 * Where jev requests go.
 *
 * Setting `OPENROUTER_API_KEY` routes through OpenRouter; model ids stay bare
 * (`jev-latest`), which OpenRouter maps into its own `typesafe/` namespace.
 * With no OpenRouter key, this returns `null` and the SDK's own `TYPESAFE_*`
 * environment variables apply unchanged.
 */
export function resolveTransport(): { apiKey: string; baseURL: string } | null {
  const apiKey = env("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  return { apiKey, baseURL: env("TYPESAFE_BASE_URL") ?? OPENROUTER_BASE_URL };
}

/** Build a client. Explicit `config` wins over the resolved transport and over env vars. */
export function createClient(config: TypeSafeClientConfig = {}): TypeSafeClient {
  return new TypeSafeClient({
    timeout: 15_000,
    retry: { maxRetries: 3 },
    ...resolveTransport(),
    ...config,
  });
}
