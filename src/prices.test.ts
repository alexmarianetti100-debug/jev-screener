import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cik, isoDate, ticker, type Entity, type Ticker } from "./observation.ts";
import {
  closesToObservations, createPriceClient, parseGroupedBars, polygonUrl, recentDays,
} from "./prices.ts";

const noWait = async (): Promise<void> => {};
const scratch = (): Promise<string> => mkdtemp(join(tmpdir(), "jev-prices-"));

const bars = (results: unknown[]): string => JSON.stringify({ status: "OK", results });

test("the grouped response keeps usable bars and drops the rest", () => {
  const closes = parseGroupedBars(JSON.parse(bars([
    { T: "aapl", c: 338.98 },
    { T: "MSFT", c: 501.2 },
    { T: "BAD", c: 0 },          // a zero close is not a price
    { T: "WORSE", c: -3 },
    { T: "NAN", c: Number.NaN },
    { T: "", c: 10 },            // no symbol to key on
    { c: 12 },
  ])));

  assert.deepEqual([...closes.entries()].sort(), [["AAPL", 338.98], ["MSFT", 501.2]]);
});

test("a day with no bars is an empty map, not an error", () => {
  assert.equal(parseGroupedBars(JSON.parse(JSON.stringify({ status: "OK" }))).size, 0);
  assert.equal(parseGroupedBars(JSON.parse(bars([]))).size, 0);
});

test("recent days skip weekends and run newest first", () => {
  // 2026-09-21 is a Monday, so walking back must jump the weekend.
  const days = recentDays(isoDate("2026-09-21"), 4);
  assert.deepEqual(days, ["2026-09-21", "2026-09-18", "2026-09-17", "2026-09-16"]);
  assert.deepEqual([...days].sort().reverse(), days, "newest first");
});

test("a close is knowable on its own date, and only for tickers we track", () => {
  const entityFor = new Map<Ticker, Entity>([[ticker("AAPL"), cik(320193)]]);
  const rows = closesToObservations(
    isoDate("2026-09-21"),
    new Map<Ticker, number>([[ticker("AAPL"), 338.98], [ticker("NOTOURS"), 12]]),
    entityFor,
  );

  assert.equal(rows.length, 1, "a ticker with no filer is not an observation");
  const row = rows[0]!;
  assert.equal(row.entity, cik(320193));
  assert.equal(row.metric, "close");
  assert.equal(row.value, 338.98);
  assert.equal(row.validAt, "2026-09-21");
  assert.equal(row.knownAt, "2026-09-21", "a close is knowable the day it prints");
  assert.equal(row.reliability, "market");
});

test("one request covers the whole market, and a trading day is cached forever", async () => {
  const cacheDir = await scratch();
  let calls = 0;
  const client = createPriceClient({
    apiKey: "test-key", gate: noWait, cacheDir,
    fetch: async (url) => {
      calls++;
      assert.match(url, /adjusted=true/);
      return new Response(bars([{ T: "AAPL", c: 1 }, { T: "MSFT", c: 2 }]));
    },
  });

  const first = await client.dailyCloses(isoDate("2026-09-21"));
  const second = await client.dailyCloses(isoDate("2026-09-21"));

  assert.equal(first.size, 2, "every ticker arrives in a single call");
  assert.equal(second.size, 2);
  assert.equal(calls, 1, "a completed trading day never changes, so it is fetched once");
});

test("an empty day is not cached — it is indistinguishable from one not yet fetched", async () => {
  const cacheDir = await scratch();
  const client = createPriceClient({
    apiKey: "test-key", gate: noWait, cacheDir,
    fetch: async () => new Response(bars([])),
  });

  assert.equal((await client.dailyCloses(isoDate("2026-09-19"))).size, 0);
  assert.deepEqual(await readdir(cacheDir), [], "nothing written for a holiday or weekend");
});

test("a rejected key says so, rather than looking like an outage", async () => {
  const client = createPriceClient({
    apiKey: "bad", gate: noWait, cacheDir: await scratch(),
    fetch: async () => new Response("nope", { status: 401 }),
  });

  await assert.rejects(client.dailyCloses(isoDate("2026-09-21")), /POLYGON_API_KEY/);
});

test("a rate limit is named, so it is not mistaken for a dead source", async () => {
  const client = createPriceClient({
    apiKey: "test-key", gate: noWait, cacheDir: await scratch(),
    fetch: async () => new Response("slow down", { status: 429 }),
  });

  await assert.rejects(client.dailyCloses(isoDate("2026-09-21")), /5 requests a minute/);
});

test("the key is encoded into the query, not interpolated raw", () => {
  const url = polygonUrl(isoDate("2026-09-21"), "a key/with+chars");
  assert.match(url, /apiKey=a%20key%2Fwith%2Bchars/);
  assert.match(url, /\/2026-09-21\?/);
});
