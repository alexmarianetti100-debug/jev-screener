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
import { DEFAULT_SCREEN_LIMIT } from "./constants.ts";
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
      "jev's current picks, in jev's order. Returns included companies with the full verdict " +
      "distribution, attractiveness score, and the provenance of every input number. Reads the " +
      "judgment cache; does not trigger a sweep. `limit` truncates the output only — it is " +
      "presentation, never selection.",
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
          const rawTickers = Array.isArray(args["tickers"]) ? (args["tickers"] as string[]) : undefined;
          const report = await runScreen({
            store,
            asOf: readAsOf(args),
            allowContaminated: args["allowContaminated"] === true,
            limit: typeof args["limit"] === "number" ? args["limit"] : DEFAULT_SCREEN_LIMIT,
            ...(rawTickers?.length ? { tickers: rawTickers.map((t) => t.toUpperCase() as Ticker) } : {}),
            ...(typeof args["sector"] === "string" ? { sector: args["sector"] } : {}),
          });

          return json({
            asOf: report.stamp.asOf,
            contaminated: report.stamp.contaminated,
            ...(report.stamp.notice ? { notice: report.stamp.notice } : {}),
            questionSetVersion: report.questionSetVersion,
            counts: {
              considered: report.considered, eligible: report.eligible,
              triaged: report.triaged, advanced: report.advanced, judged: report.judged,
              included: report.picks.length,
            },
            cache: report.cache,
            usage: report.usage,
            picks: report.picks.map((pick) => ({
              ticker: pick.label,
              cik: pick.entity,
              sector: pick.sector,
              attractiveness: pick.attractiveness,
              verdict: pick.verdict,
              durability: pick.answers.durability,
              accountingQuality: pick.answers.accountingQuality,
              dominantRisk: pick.answers.dominantRisk,
              managementCandor: pick.answers.managementCandor,
              sufficiency: pick.answers.sufficiency,
              fromCache: pick.fromCache,
            })),
            disclaimer: "Candidates for human review. Not a recommendation to buy or sell anything.",
            ...(report.failures.length ? { failures: report.failures.slice(0, 20) } : {}),
          });
        }

        case "explain_pick": {
          const ticker = args["ticker"];
          if (typeof ticker !== "string" || ticker.trim() === "") return failure("explain_pick requires a `ticker`.");
          return json(await explainPick({ store, ticker: ticker.trim().toUpperCase() as Ticker, asOf: readAsOf(args) }));
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
