/**
 * MCP stdio server: three read-only tools over the screener.
 *
 * All three read what the pipeline has already produced. None of them triggers a
 * full sweep — `screen_run` serves from the judgment cache, so a conversation with
 * Claude costs nothing but a database read. Ingest and the nightly sweep are jobs
 * you schedule, not things a chat turn sets off by accident.
 *
 * This is deliberately built on the SDK's lower-level `Server` with plain JSON
 * Schema, rather than `McpServer`, which would require zod as a direct dependency.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_SCREEN_LIMIT, EXPLAIN_PERIODS_PER_METRIC } from "./constants.ts";
import { coverageStatus, explainPick, runScreen } from "./cli.ts";
import { isoDate, todayISO, type ISODate, type Ticker } from "./observation.ts";
import { openStore, type Store } from "./store.ts";

const ISO_DATE_SCHEMA = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Point-in-time date. Defaults to today. More than 7 days in the past is refused as contaminated.",
} as const;

const TOOLS = [
  {
    name: "screen_run",
    description:
      "The picks from the most recent completed screen, in jev's order, with each answer's full " +
      "probability distribution. Reads the persisted run; it cannot start a sweep — that is a CLI " +
      "batch job. `limit` truncates the output only — presentation, never selection.",
    inputSchema: {
      type: "object",
      properties: {
        tickers: { type: "array", items: { type: "string" }, description: "Restrict to these symbols. Peer distributions still cover the whole universe." },
        sector: { type: "string", description: "Restrict to one coarse sector grouping." },
        asOf: ISO_DATE_SCHEMA,
        limit: { type: "integer", minimum: 1, description: `Rows to return. Default ${DEFAULT_SCREEN_LIMIT}.` },
        allowContaminated: { type: "boolean", description: "Run a stale asOf anyway. Results are stamped and must not be used to judge performance." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "explain_pick",
    description:
      "Everything behind one company: every observation with its knownAt date and the XBRL tag " +
      "that matched, every derived metric with its provenance, and each jev answer with its " +
      "complete probability distribution — including whether it came from cache.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Symbol, e.g. AAPL." },
        asOf: ISO_DATE_SCHEMA,
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "coverage_status",
    description:
      "Operational health: universe size, eligibility counts and why companies were excluded, " +
      "per-source last successful fetch and recent failures, run count, and cache hit rate.",
    inputSchema: {
      type: "object",
      properties: { asOf: ISO_DATE_SCHEMA },
      additionalProperties: false,
    },
  },
] as const;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

function readAsOf(args: Record<string, unknown>): ISODate {
  const raw = args["asOf"];
  return typeof raw === "string" && raw.length > 0 ? isoDate(raw) : todayISO();
}

export function createMcpServer(store: Store): Server {
  const server = new Server(
    { name: "jev-screener", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      switch (request.params.name) {
        case "screen_run": {
          // Serves the last completed screen. It deliberately cannot start one: a
          // sweep judges ~4,000 companies, costs real money and takes a quarter of
          // an hour, and a chat message should not be able to trigger that. It also
          // could not, in practice — the first live probe of this tool timed out at
          // 60 seconds recomputing a fully cached run.
          const last = await store.latestRun(readAsOf(args));
          if (!last) {
            return failure(
              "No screen has been run yet. Run `npm run screen` from the CLI — a sweep is a batch " +
                "job, not something a conversation should start.",
            );
          }

          const payload = last.payload as {
            picks?: readonly {
              label: string; entity: string; sector: string;
              attractiveness: unknown; verdict: unknown;
              answers: Record<string, unknown>;
            }[];
            considered?: number; eligible?: number; judged?: number;
            stamp?: { notice?: string };
            usage?: unknown;
          };
          const all = payload.picks ?? [];

          const wanted = Array.isArray(args["tickers"])
            ? new Set((args["tickers"] as string[]).map((t) => t.trim().toUpperCase()))
            : undefined;
          const sector = typeof args["sector"] === "string" ? args["sector"] : undefined;
          const matching = all.filter(
            (pick) => (!wanted || wanted.has(String(pick.label).toUpperCase())) && (!sector || pick.sector === sector),
          );

          const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_SCREEN_LIMIT;

          return json({
            runId: last.runId,
            asOf: last.asOf,
            contaminated: last.contaminated,
            ...(payload.stamp?.notice ? { notice: payload.stamp.notice } : {}),
            questionSetVersion: last.questionSetVersion,
            counts: {
              considered: payload.considered, eligible: payload.eligible, judged: payload.judged,
              included: all.length, matching: matching.length, returned: Math.min(matching.length, limit),
            },
            picks: matching.slice(0, limit).map((pick) => ({
              ticker: pick.label,
              cik: pick.entity,
              sector: pick.sector,
              attractiveness: pick.attractiveness,
              verdict: pick.verdict,
              durability: pick.answers.durability,
              accountingQuality: pick.answers.accountingQuality,
              dominantRisk: pick.answers.dominantRisk,
              managementCandor: pick.answers.managementCandor,
              horizonDriver: pick.answers.horizonDriver,
              horizonBand: pick.answers.horizonBand,
              sufficiency: pick.answers.sufficiency,
            })),
            disclaimer: "Candidates for human review. Not a recommendation to buy or sell anything.",
          });
        }

        case "explain_pick": {
          const ticker = args["ticker"];
          if (typeof ticker !== "string" || ticker.trim() === "") return failure("explain_pick requires a `ticker`.");
          const report = await explainPick({ store, ticker: ticker.trim().toUpperCase() as Ticker, asOf: readAsOf(args) });

          // Apple's full provenance is 503 observations and 138 KB — more than a
          // conversation can hold, and most of it is a decade of history nobody asked
          // for. Keep the newest few periods of each metric, which is what makes a
          // number checkable, and say how many were left behind.
          const perMetric = new Map<string, number>();
          const kept: typeof report.observations[number][] = [];
          for (const row of [...report.observations].sort((a, b) => b.validAt.localeCompare(a.validAt))) {
            const seen = perMetric.get(row.metric) ?? 0;
            if (seen >= EXPLAIN_PERIODS_PER_METRIC) continue;
            perMetric.set(row.metric, seen + 1);
            kept.push(row);
          }
          kept.sort((a, b) => a.metric.localeCompare(b.metric) || a.validAt.localeCompare(b.validAt));

          return json({
            ...report,
            observations: kept,
            observationsOmitted: report.observations.length - kept.length,
            ...(report.observations.length > kept.length
              ? { note: `Newest ${EXPLAIN_PERIODS_PER_METRIC} periods per metric. Use the CLI for the full series.` }
              : {}),
          });
        }

        case "coverage_status":
          return json(await coverageStatus(store, readAsOf(args)));

        default:
          return failure(`unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      return failure((error as Error).message);
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const store = await openStore();
  const server = createMcpServer(store);

  const shutdown = async (): Promise<void> => {
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // stdout carries the protocol, so every log must go to stderr.
  await server.connect(new StdioServerTransport());
  console.error("jev screener MCP server ready on stdio (screen_run, explain_pick, coverage_status)");
}

if (process.argv[1]?.endsWith("mcp.ts") || process.argv[1]?.endsWith("mcp.js")) {
  await main();
}
