import assert from "node:assert/strict";
import test from "node:test";
import { OPENROUTER_BASE_URL, resolveTransport } from "./client.ts";

/** Run `fn` with the given env vars applied, restoring the real environment afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("an OpenRouter key routes to OpenRouter", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-test", TYPESAFE_BASE_URL: undefined }, () => {
    assert.deepEqual(resolveTransport(), { apiKey: "sk-or-test", baseURL: OPENROUTER_BASE_URL });
  });
});

test("an explicit TYPESAFE_BASE_URL still wins", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-test", TYPESAFE_BASE_URL: "https://proxy.internal/api" }, () => {
    assert.equal(resolveTransport()?.baseURL, "https://proxy.internal/api");
  });
});

test("no OpenRouter key leaves the SDK's own TYPESAFE_* defaults alone", () => {
  withEnv({ OPENROUTER_API_KEY: undefined }, () => {
    assert.equal(resolveTransport(), null);
  });
});

test("a blank OpenRouter key is ignored, not treated as set", () => {
  withEnv({ OPENROUTER_API_KEY: "   " }, () => {
    assert.equal(resolveTransport(), null);
  });
});
