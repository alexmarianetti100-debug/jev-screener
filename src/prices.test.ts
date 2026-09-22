import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cik, ticker } from "./observation.ts";
import { createPriceClient, parseStooqCsv, stooqUrl } from "./prices.ts";

const ACME = ticker("ACME");
const ACME_CIK = cik("320193");
const noWait = async (): Promise<void> => {};

const CSV = `Date,Open,High,Low,Close,Volume
2026-08-26,10.10,10.50,10.00,10.40,120000
2026-08-27,10.40,10.90,10.30,10.85,98000
2026-08-28,10.85,11.00,10.60,10.75,110000`;

test("Stooq's URL uses the lower-case .us suffix", () => {
  assert.equal(stooqUrl(ACME), "https://stooq.com/q/d/l/?s=acme.us&i=d");
});

test("a close is knowable on its own date", () => {
  const rows = parseStooqCsv(CSV, ACME, ACME_CIK);

  assert.equal(rows.length, 3);
  const last = rows.at(-1)!;
  assert.equal(last.value, 10.75);
  // knownAt === validAt is what makes prices safe to mix with filings in a slice.
  assert.equal(last.validAt, "2026-08-28");
  assert.equal(last.knownAt, "2026-08-28");
  assert.equal(last.reliability, "market");
  assert.equal(last.metric, "close");
});

test("rows come back oldest first", () => {
  const rows = parseStooqCsv(CSV, ACME, ACME_CIK);
  assert.deepEqual(rows.map((r) => r.validAt), ["2026-08-26", "2026-08-27", "2026-08-28"]);
});

test("Stooq's 'no data' answer yields no rows rather than an error", () => {
  assert.deepEqual(parseStooqCsv("N/D", ACME, ACME_CIK), []);
  assert.deepEqual(parseStooqCsv("", ACME, ACME_CIK), []);
});

test("malformed and non-positive rows are skipped, not zero-filled", () => {
  const messy = `Date,Open,High,Low,Close,Volume
2026-08-26,10,10,10,10.40,1
not-a-date,10,10,10,10.50,1
2026-08-27,10,10,10,,1
2026-08-28,10,10,10,0,1
2026-08-29,10,10,10,11.10,1`;

  const rows = parseStooqCsv(messy, ACME, ACME_CIK);
  assert.deepEqual(rows.map((r) => r.value), [10.4, 11.1]);
});

test("column order is read from the header, not assumed", () => {
  const reordered = `Date,Close,Open,High,Low,Volume
2026-08-26,42.50,10,10,10,1`;

  assert.equal(parseStooqCsv(reordered, ACME, ACME_CIK)[0]?.value, 42.5);
});

test("a fetched series is cached, and the second call does not hit the network", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "jev-prices-"));
  let calls = 0;

  const client = createPriceClient({
    cacheDir, gate: noWait,
    fetch: async () => {
      calls++;
      return new Response(CSV);
    },
  });

  const first = await client.closes(ACME, ACME_CIK);
  const second = await client.closes(ACME, ACME_CIK);

  assert.equal(calls, 1);
  assert.equal(first.length, 3);
  assert.deepEqual(second.map((r) => r.value), first.map((r) => r.value));
});

test("an empty series is not cached, so a later run can retry", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "jev-prices-"));
  let calls = 0;

  const client = createPriceClient({
    cacheDir, gate: noWait,
    fetch: async () => {
      calls++;
      return new Response(calls === 1 ? "N/D" : CSV);
    },
  });

  assert.deepEqual(await client.closes(ACME, ACME_CIK), []);
  assert.equal((await client.closes(ACME, ACME_CIK)).length, 3);
  assert.equal(calls, 2);
});

test("a non-2xx response is an error rather than a silent gap", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "jev-prices-"));
  const client = createPriceClient({
    cacheDir, gate: noWait,
    fetch: async () => new Response("rate limited", { status: 429 }),
  });

  await assert.rejects(() => client.closes(ACME, ACME_CIK), /Stooq 429/);
});
