/**
 * Drives the MCP server through a real client over an in-memory transport, so the
 * tools are exercised the way Claude would call them — not by poking the handlers.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient } from "./client.ts";
import { runIngest, runScreen } from "./cli.ts";
import type { EdgarClient } from "./edgar.ts";
import { createMcpServer } from "./mcp.ts";
import { cik, type Entity, isoDate, ticker, type Observation, type Ticker } from "./observation.ts";
import type { PriceClient } from "./prices.ts";
import { openStore, type Store } from "./store.ts";

// ── Minimal fixture: one eligible company jev includes ────────────────────────

const plusDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function quarterEnds(count: number): string[] {
  const now = new Date();
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 1));
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - (count - 1 - i) * 3 + 1, 0))
      .toISOString().slice(0, 10),
  );
}

const QUARTERS = quarterEnds(16);
const LATEST_FILED = plusDays(QUARTERS.at(-1)!, 30);

function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

async function stubEdgar(): Promise<EdgarClient> {
  const dir = await mkdtemp(join(tmpdir(), "jev-mcp-"));

  const quarterly = (base: number) =>
    QUARTERS.map((end, i) => ({
      start: plusDays(end, -89), end, val: Math.round(base * (1 + i * 0.02)),
      filed: plusDays(end, 30), form: i === QUARTERS.length - 1 ? "10-K" : "10-Q", accn: `a${i}`,
    }));
  const instant = (base: number) =>
    QUARTERS.map((end, i) => ({ end, val: Math.round(base * (1 + i * 0.01)), filed: plusDays(end, 30), form: "10-Q", accn: `a${i}` }));
  const usd = (entries: unknown[]) => ({ units: { USD: entries } });

  const facts = {
    cik: 1, entityName: "Acme Corp",
    facts: {
      "us-gaap": {
        Revenues: usd(quarterly(1000)), GrossProfit: usd(quarterly(400)),
        OperatingIncomeLoss: usd(quarterly(200)), NetIncomeLoss: usd(quarterly(100)),
        NetCashProvidedByUsedInOperatingActivities: usd(quarterly(150)),
        PaymentsToAcquirePropertyPlantAndEquipment: usd(quarterly(50)),
        DepreciationDepletionAndAmortization: usd(quarterly(40)),
        Assets: usd(instant(10000)), Liabilities: usd(instant(4000)),
        CashAndCashEquivalentsAtCarryingValue: usd(instant(1000)),
        LongTermDebtNoncurrent: usd(instant(2000)),
      },
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: instant(1000) } } },
    },
  };

  const subs = {
    cik: 1, name: "Acme Corp", sic: "3571", tickers: ["ACME"],
    filings: {
      recent: {
        form: QUARTERS.map((_, i) => (i === QUARTERS.length - 1 ? "10-K" : "10-Q")).reverse(),
        filingDate: QUARTERS.map((q) => plusDays(q, 30)).reverse(),
        accessionNumber: QUARTERS.map((_, i) => `a${i}`).reverse(),
        primaryDocument: QUARTERS.map(() => "acme.htm").reverse(),
      },
    },
  };

  const factsZip = join(dir, "f.zip");
  const subsZip = join(dir, "s.zip");
  await writeFile(factsZip, makeZip({ "CIK0000000001.json": JSON.stringify(facts) }));
  await writeFile(subsZip, makeZip({ "CIK0000000001.json": JSON.stringify(subs) }));

  return {
    async getJson<T>(): Promise<T> {
      return { "0": { cik_str: 1, ticker: "ACME", title: "Acme Corp" } } as T;
    },
    async getText(): Promise<string> {
      return "<html>Item 1A. Risk Factors " + "Risks abound. ".repeat(20) +
        "Item 1B. x Item 7. Management's Discussion and Analysis " + "We grew. ".repeat(20) + "Item 8. x</html>";
    },
    async download(url: string): Promise<string> {
      return url.includes("companyfacts") ? factsZip : subsZip;
    },
  };
}

const stubPrices = (): PriceClient => ({
  async closes(symbol: Ticker, entity: Entity): Promise<Observation[]> {
    return [{
      value: 50, metric: "close", entity,
      validAt: isoDate(LATEST_FILED), knownAt: isoDate(LATEST_FILED),
      source: "stooq", reliability: "market",
    }];
  },
});

function stubJev() {
  const choice = (value: string, probabilities: Record<string, number>) =>
    ({ type: "choice", choice: value, confidence: probabilities[value] ?? 0.9, probabilities });

  return createClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const triage = "advance" in body.questions;

      return Response.json({
        model: "typesafe/jev-1.13-test",
        answers: triage
          ? { advance: choice("advance", { advance: 0.85, drop: 0.15 }) }
          : {
              verdict: choice("include", { include: 0.72, watch: 0.2, exclude: 0.08 }),
              attractiveness: { type: "score", score: 3.8, confidence: 0.77, legend: {}, probabilities: { 0: 0.05, 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.35 } },
              durability: { type: "score", score: 3.1, confidence: 0.7, legend: {}, probabilities: {} },
              accountingQuality: choice("clean", { clean: 0.8, questionable: 0.15, deteriorating: 0.05 }),
              dominantRisk: choice("demand", { demand: 0.5, margin: 0.2, balanceSheet: 0.15, regulatory: 0.1, none: 0.05 }),
              managementCandor: choice("direct", { direct: 0.6, guarded: 0.3, evasive: 0.1 }),
              sufficiency: choice("sufficient", { sufficient: 0.92, thin: 0.06, insufficient: 0.02 }),
            },
        usage: { input_tokens: triage ? 300 : 15000, output_tokens: 20 },
      });
    },
  });
}

/** A store with one screened company, plus a connected MCP client. */
async function connected(): Promise<{ store: Store; client: Client; close: () => Promise<void> }> {
  const store = await openStore(":memory:");
  const edgar = await stubEdgar();
  await runIngest({ store, edgar });
  await runScreen({ store, edgar, prices: stubPrices(), client: stubJev() });

  const server = createMcpServer(store);
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    store, client,
    close: async () => {
      await client.close();
      await store.close();
    },
  };
}

const parse = (result: unknown): Record<string, unknown> => {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

test("the server advertises exactly three read-only tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((t) => t.name).sort(), ["coverage_status", "explain_pick", "screen_run"]);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} is documented`);
      assert.equal(tool.inputSchema.type, "object");
      // Every tool takes an optional asOf.
      assert.ok("asOf" in (tool.inputSchema.properties as Record<string, unknown>));
    }
  } finally {
    await close();
  }
});

test("screen_run returns jev's picks with full distributions", async () => {
  const { client, close } = await connected();
  try {
    const result = parse(await client.callTool({ name: "screen_run", arguments: {} }));
    const picks = result["picks"] as Record<string, unknown>[];

    assert.equal(picks.length, 1);
    const pick = picks[0]!;
    assert.equal(pick["ticker"], "ACME");
    assert.equal((pick["attractiveness"] as { score: number }).score, 3.8);
    assert.equal((pick["verdict"] as { choice: string }).choice, "include");
    // The full probability distribution travels with the answer, not just the argmax.
    assert.ok((pick["verdict"] as { probabilities: Record<string, number> }).probabilities["watch"]);
    assert.equal(pick["fromCache"], true, "served from the judgment cache");

    assert.match(String(result["disclaimer"]), /Not a recommendation/);
    assert.equal(result["contaminated"], false);
  } finally {
    await close();
  }
});

test("screen_run's limit truncates output without changing selection", async () => {
  const { client, close } = await connected();
  try {
    const full = parse(await client.callTool({ name: "screen_run", arguments: {} }));
    const limited = parse(await client.callTool({ name: "screen_run", arguments: { limit: 1 } }));

    assert.equal((limited["picks"] as unknown[]).length, 1);
    assert.deepEqual(
      (limited["counts"] as Record<string, number>)["judged"],
      (full["counts"] as Record<string, number>)["judged"],
      "the same companies were judged either way",
    );
  } finally {
    await close();
  }
});

test("screen_run refuses a stale asOf and explains why", async () => {
  const { client, close } = await connected();
  try {
    const result = await client.callTool({ name: "screen_run", arguments: { asOf: "2024-01-15" } });

    assert.equal((result as { isError?: boolean }).isError, true);
    const text = (result as { content: { text: string }[] }).content[0]!.text;
    assert.match(text, /hindsight, not skill/);

    const forced = parse(await client.callTool({
      name: "screen_run", arguments: { asOf: "2024-01-15", allowContaminated: true },
    }));
    assert.equal(forced["contaminated"], true);
    assert.match(String(forced["notice"]), /CONTAMINATED/);
  } finally {
    await close();
  }
});

test("explain_pick exposes provenance for every number", async () => {
  const { client, close } = await connected();
  try {
    const result = parse(await client.callTool({ name: "explain_pick", arguments: { ticker: "acme" } }));

    assert.equal(result["ticker"], "ACME");
    assert.equal(result["entity"], "0000000001", "resolved to the filer's CIK");
    assert.equal(result["eligible"], true);

    const observations = result["observations"] as Record<string, unknown>[];
    assert.ok(observations.length > 50);
    const revenue = observations.find((o) => o["metric"] === "revenue")!;
    assert.equal(revenue["tag"], "Revenues");
    assert.ok(revenue["knownAt"]);
    assert.match(String(revenue["source"]), /^edgar:/);

    const judgments = result["judgments"] as Record<string, unknown>[];
    assert.deepEqual(judgments.map((j) => j["stage"]).sort(), ["judgment", "triage"]);
    assert.equal(judgments[0]?.["fromCache"], true);
  } finally {
    await close();
  }
});

test("explain_pick on an unknown ticker reports it rather than throwing", async () => {
  const { client, close } = await connected();
  try {
    const result = parse(await client.callTool({ name: "explain_pick", arguments: { ticker: "NOSUCH" } }));

    assert.equal(result["eligible"], false);
    assert.ok((result["missing"] as string[]).includes("filer not in store"));
  } finally {
    await close();
  }
});

test("explain_pick without a ticker is an error, not a crash", async () => {
  const { client, close } = await connected();
  try {
    const result = await client.callTool({ name: "explain_pick", arguments: {} });
    assert.equal((result as { isError?: boolean }).isError, true);
  } finally {
    await close();
  }
});

test("coverage_status reports universe, sources and cache health", async () => {
  const { client, close } = await connected();
  try {
    const result = parse(await client.callTool({ name: "coverage_status", arguments: {} }));

    assert.equal(result["filers"], 1);
    assert.equal(result["eligible"], 1);
    assert.equal(result["runs"], 1);
    assert.ok(Number(result["observations"]) > 100);
    assert.ok(result["lastRun"]);
    assert.ok((result["sources"] as unknown[]).length > 0);
    assert.ok(result["questionSetVersion"]);

    const cache = result["cache"] as Record<string, number>;
    assert.ok(cache["hits"]! + cache["misses"]! > 0);
  } finally {
    await close();
  }
});

test("an unknown tool name is reported, not silently ignored", async () => {
  const { client, close } = await connected();
  try {
    const result = await client.callTool({ name: "delete_everything", arguments: {} });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match((result as { content: { text: string }[] }).content[0]!.text, /unknown tool/);
  } finally {
    await close();
  }
});
