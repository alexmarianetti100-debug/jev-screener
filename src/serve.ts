/**
 * A read-only local view of the last run.
 *
 * Deliberately small. Node's own http server, one inlined page, no framework and no
 * build step — a table of a thousand rows with a filter and a drill-down does not
 * need more, and a bundler here would be the first dependency in this project that
 * earns nothing.
 *
 * Three rules it exists under:
 *
 *  1. **It cannot start a screen.** Only GET is routed; there is no handler that
 *     judges anything. This is the same lesson the MCP server taught the hard way,
 *     where a tool that claimed not to trigger a sweep triggered one, timed out, and
 *     spent $2.17 returning nothing. A screen is a decision someone makes at a
 *     terminal, not something a page load can cause.
 *  2. **It binds to loopback.** There is no auth, because there is nothing to
 *     authenticate against and adding a login would imply this was safe to expose.
 *     It is not: bind it to a public interface and anyone can read your research.
 *  3. **It serves the same functions as everything else.** The CLI, the MCP server
 *     and this page all call `latestRun`, `explainPick`, `coverageStatus` and
 *     `gradeRuns`. There is no query written twice, so the page cannot quietly
 *     disagree with the terminal.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { UI_HOST, UI_PORT } from "./constants.ts";
import { coverageStatus, explainPick, gradeRuns } from "./cli.ts";
import { isoDate, type ISODate, type Ticker } from "./observation.ts";
import type { Store } from "./store.ts";
import { PAGE } from "./ui.ts";

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // Nothing here is embeddable or worth caching, and both are one fewer thing to
    // reason about when the page is showing numbers someone might act on.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(text);
};

const readAsOf = (url: URL): ISODate | undefined => {
  const raw = url.searchParams.get("asOf");
  return raw ? isoDate(raw) : undefined;
};

/**
 * The most recent persisted run, shaped for the page.
 *
 * Reads what was written rather than recomputing: a screen is minutes of work and
 * thousands of model calls, and a page load must never be able to cause either.
 */
async function latestRunPayload(store: Store, asOf?: ISODate): Promise<unknown> {
  const last = await store.latestRun(asOf);
  if (!last) return undefined;

  const payload = last.payload as {
    picks?: readonly {
      label: string; entity: string; sector: string;
      attractiveness: unknown; verdict: unknown; answers: Record<string, unknown>;
    }[];
    considered?: number; eligible?: number; judged?: number;
    stamp?: { notice?: string };
  };

  // Shaped exactly as the MCP tool shapes it — `ticker` and `cik`, answers hoisted —
  // so the page and a conversation are reading the same thing by the same names.
  const picks = (payload.picks ?? []).map((pick) => ({
    ticker: pick.label,
    cik: pick.entity,
    sector: pick.sector,
    attractiveness: pick.attractiveness,
    verdict: pick.verdict,
    durability: pick.answers["durability"],
    accountingQuality: pick.answers["accountingQuality"],
    dominantRisk: pick.answers["dominantRisk"],
    managementCandor: pick.answers["managementCandor"],
    horizonDriver: pick.answers["horizonDriver"],
    horizonBand: pick.answers["horizonBand"],
    sufficiency: pick.answers["sufficiency"],
  }));

  return {
    runId: last.runId,
    asOf: last.asOf,
    contaminated: last.contaminated,
    ...(payload.stamp?.notice ? { notice: payload.stamp.notice } : {}),
    questionSetVersion: last.questionSetVersion,
    counts: {
      considered: payload.considered ?? 0,
      eligible: payload.eligible ?? 0,
      judged: payload.judged ?? 0,
      included: picks.length,
    },
    picks,
    disclaimer: "Candidates for human review. Not a recommendation to buy or sell anything.",
  };
}

export async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Every mutation verb is refused before routing, so a handler cannot be added later
  // that quietly accepts one.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "This view is read-only. A screen is a CLI job." });
  }

  const url = new URL(req.url ?? "/", `http://${UI_HOST}`);

  try {
    switch (url.pathname) {
      case "/": {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
        });
        return void res.end(PAGE);
      }

      case "/api/run": {
        const payload = await latestRunPayload(store, readAsOf(url));
        return payload
          ? json(res, 200, payload)
          : json(res, 404, { error: "No screen has been run yet. Run `npm run screen` first." });
      }

      case "/api/explain": {
        const ticker = url.searchParams.get("ticker");
        if (!ticker?.trim()) return json(res, 400, { error: "explain needs a ticker" });
        return json(res, 200, await explainPick({
          store, ticker: ticker.trim().toUpperCase() as Ticker, ...(readAsOf(url) ? { asOf: readAsOf(url)! } : {}),
        }));
      }

      case "/api/coverage":
        return json(res, 200, await coverageStatus(store, readAsOf(url)));

      case "/api/grade":
        return json(res, 200, await gradeRuns(store));

      default:
        return json(res, 404, { error: "no such path" });
    }
  } catch (error) {
    return json(res, 500, { error: (error as Error).message });
  }
}

export async function serve(store: Store, options: { port?: number; host?: string } = {}): Promise<{
  port: number; close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    void handle(store, req, res);
  });

  const port = options.port ?? UI_PORT;
  const host = options.host ?? UI_HOST;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
