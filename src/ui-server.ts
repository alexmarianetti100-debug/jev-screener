/**
 * Entry point for the read-only view.
 *
 * Separate from `cli.ts` on purpose. The server needs `explainPick`, `coverageStatus`
 * and `gradeRuns`, which live in the CLI — so routing the `ui` subcommand through the
 * CLI's dispatch made cli.ts import serve.ts which imports cli.ts, and the ESM module
 * graph deadlocked: the process started, printed nothing, and exited 13 on an
 * unsettled top-level await. Its own entry breaks the cycle.
 */

import { UI_HOST } from "./constants.ts";
import { serve } from "./serve.ts";
import { lockError, openStore } from "./store.ts";

const portArg = process.argv.slice(2).map((a) => /^--port=(\d+)$/.exec(a)?.[1]).find(Boolean);

const store = await openStore().catch((error: unknown) => {
  const message = (error as Error).message ?? "";
  throw /Could not set lock|Conflicting lock/i.test(message) ? lockError("data/jev.duckdb", error as Error) : error;
});

const { port, close } = await serve(store, portArg ? { port: Number(portArg) } : {});

console.log(`\n  jev screener — http://${UI_HOST}:${port}\n`);
console.log("  Read-only. This view cannot start a screen; that is a CLI job.");
console.log("  Ctrl-C to stop.\n");

// Resolves on a signal rather than never, so the process has a settled path out and
// the store is closed rather than dropped.
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

console.log("  stopping");
await close();
await store.close();
