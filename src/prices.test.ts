import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cik, isoDate, ticker, type Entity, type Ticker } from "./observation.ts";
import {
  closesToObservations, createPriceClient, earlierDay, lastPossibleCloseDay, parseGroupedBars,
  polygonUrl, recentDays,
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

test("the price window stops at the closing bell, not at UTC midnight", () => {
  // Two effects compose here, and they are not the same thing. The bell decides
  // whether a session has finished; PRICE_PUBLISH_LAG_DAYS decides whether the plan
  // will serve it. Expectations below are one trading day behind the bell because the
  // free tier is — measured at 18:42 ET, which returned 403 for that day while serving
  // 12,591 results for the one before it.

  // 18:00 Pacific on the 23rd. UTC has already rolled to the 24th, and asking for the
  // 24th earns a 403 — the same status a revoked key returns, recorded as a source
  // failure every single evening the scheduler ran.
  assert.equal(lastPossibleCloseDay(new Date("2026-09-24T01:00:00Z")), "2026-09-22");

  // 09:30 ET, the opening bell: today has not closed.
  assert.equal(lastPossibleCloseDay(new Date("2026-09-23T13:30:00Z")), "2026-09-21");
  // 16:00 ET exactly, the bell itself.
  assert.equal(lastPossibleCloseDay(new Date("2026-09-23T20:00:00Z")), "2026-09-22");
  // 15:59 ET, one minute short of it.
  assert.equal(lastPossibleCloseDay(new Date("2026-09-23T19:59:00Z")), "2026-09-21");

  // Winter, when Eastern is UTC-5 rather than UTC-4: the offset is not hardcoded.
  assert.equal(lastPossibleCloseDay(new Date("2026-01-15T20:30:00Z")), "2026-01-13");
  assert.equal(lastPossibleCloseDay(new Date("2026-01-15T21:30:00Z")), "2026-01-14");

  // A Saturday anchor is fine: recentDays drops weekends from the window it opens.
  assert.deepEqual(
    recentDays(lastPossibleCloseDay(new Date("2026-09-26T21:00:00Z")), 2),
    ["2026-09-25", "2026-09-24"],
  );
});

test("the plan's lag is separate from the bell, and both are honoured", async () => {
  const { PRICE_PUBLISH_LAG_DAYS } = await import("./constants.ts");

  // Conflating "the session has ended" with "the source will serve it" is what made
  // the first fix fall one day short: correct about timezones, still 403 every night.
  // Well after the bell, the answer is still the lag behind it.
  const afterTheBell = lastPossibleCloseDay(new Date("2026-09-23T22:00:00Z")); // 18:00 ET
  assert.equal(afterTheBell, "2026-09-22");
  assert.equal(PRICE_PUBLISH_LAG_DAYS, 1, "a paid tier would set this to zero");
});

test("a point-in-time anchor may be older than the bell, never newer", () => {
  // A screen replaying an older date keeps its own asOf; the bell does not drag it forward.
  assert.equal(earlierDay(isoDate("2026-03-02"), isoDate("2026-09-23")), "2026-03-02");
  // A screen run today must not ask for closes that have not printed.
  assert.equal(earlierDay(isoDate("2026-09-24"), isoDate("2026-09-23")), "2026-09-23");
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
