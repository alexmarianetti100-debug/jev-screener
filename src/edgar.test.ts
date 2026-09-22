import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMPANY_TICKERS, createEdgarClient, extractItem, factsToObservations, fetchFilingText,
  cikFromEntryName, fetchTickerMap, filingUrl, isPrimaryCikEntry, iterateZipJson, quarterize, submissionsToProfile,
  type CompanyFacts, type Submissions,
} from "./edgar.ts";
import { cik, isoDate, ticker } from "./observation.ts";

const ACME = ticker("ACME");
const noWait = async (): Promise<void> => {};

/** Build a real ZIP (stored, no compression) so the reader is exercised, not mocked. */
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
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 14); // crc (unverified by the reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
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

test("the bulk ZIP path parses a real archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-zip-"));
  const path = join(dir, "bulk.zip");
  await writeFile(path, makeZip({
    "CIK0000000001.json": JSON.stringify({ cik: 1, entityName: "One" }),
    "CIK0000000002.json": JSON.stringify({ cik: 2, entityName: "Two" }),
    "README.txt": "not json",
    "broken.json": "{ this is not json",
  }));

  const seen: string[] = [];
  for await (const { data } of iterateZipJson<{ entityName: string }>(path, (n) => n.endsWith(".json"))) {
    seen.push(data.entityName);
  }

  // The malformed member is skipped rather than abandoning a 500k-entry ingest.
  assert.deepEqual(seen.sort(), ["One", "Two"]);
});

test("the ticker map zero-pads CIKs and prefers the common share", async () => {
  const client = createEdgarClient({
    userAgent: "test", gate: noWait,
    fetch: async (url) => {
      assert.equal(url, COMPANY_TICKERS);
      return Response.json({
        "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
        "1": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA" },
        "2": { cik_str: 1045810, ticker: "NVDA.WS", title: "NVIDIA warrant" },
      });
    },
  });

  const map = await fetchTickerMap(client);
  assert.equal(map.get(cik(320193)), "AAPL");
  assert.equal(map.get(cik(1045810)), "NVDA");
});

test("a non-2xx response from EDGAR is an error, not an empty result", async () => {
  const client = createEdgarClient({
    userAgent: "test", gate: noWait,
    fetch: async () => new Response("nope", { status: 403 }),
  });

  await assert.rejects(() => fetchTickerMap(client), /EDGAR 403/);
});

test("the User-Agent the SEC requires is actually sent", async () => {
  let sent: string | undefined;
  const client = createEdgarClient({
    userAgent: "jevproject test@example.com", gate: noWait,
    fetch: async (_url, init) => {
      sent = new Headers(init?.headers).get("user-agent") ?? undefined;
      return Response.json({});
    },
  });

  await fetchTickerMap(client);
  assert.equal(sent, "jevproject test@example.com");
});

// ── Tag resolution ────────────────────────────────────────────────────────────

const facts = (tag: string, entries: unknown[]): CompanyFacts => ({
  cik: 1, entityName: "Acme",
  facts: { "us-gaap": { [tag]: { units: { USD: entries as never } } } },
});

test("the fallback chain records which tag actually matched", () => {
  const modern = factsToObservations(
    facts("RevenueFromContractWithCustomerExcludingAssessedTax", [
      { start: "2026-01-01", end: "2026-03-31", val: 100, filed: "2026-05-01", form: "10-Q", accn: "a" },
    ]),
    ACME,
  );
  assert.equal(modern[0]?.tag, "RevenueFromContractWithCustomerExcludingAssessedTax");

  const legacy = factsToObservations(
    facts("SalesRevenueNet", [
      { start: "2026-01-01", end: "2026-03-31", val: 100, filed: "2026-05-01", form: "10-Q", accn: "a" },
    ]),
    ACME,
  );
  assert.equal(legacy[0]?.tag, "SalesRevenueNet");
  assert.equal(legacy[0]?.metric, "revenue");
});

test("figures from a 10-K are audited; from a 10-Q, reported", () => {
  const rows = factsToObservations(
    facts("Revenues", [
      { start: "2026-01-01", end: "2026-03-31", val: 100, filed: "2026-05-01", form: "10-Q", accn: "q" },
      { start: "2026-04-01", end: "2026-06-30", val: 110, filed: "2026-08-01", form: "10-K", accn: "k" },
    ]),
    ACME,
  );

  assert.equal(rows.find((r) => r.validAt === "2026-03-31")?.reliability, "reported");
  assert.equal(rows.find((r) => r.validAt === "2026-06-30")?.reliability, "audited");
});

test("capex is stored as a magnitude, whatever sign the filer used", () => {
  const rows = factsToObservations(
    facts("PaymentsToAcquirePropertyPlantAndEquipment", [
      { start: "2026-01-01", end: "2026-03-31", val: -25, filed: "2026-05-01", form: "10-Q", accn: "a" },
    ]),
    ACME,
  );

  assert.equal(rows[0]?.value, 25);
});

test("instants are kept and durations dropped for balance-sheet concepts", () => {
  const rows = factsToObservations(
    facts("Assets", [
      { end: "2026-03-31", val: 1000, filed: "2026-05-01", form: "10-Q", accn: "a" },
      { start: "2026-01-01", end: "2026-03-31", val: 999, filed: "2026-05-01", form: "10-Q", accn: "a" },
    ]),
    ACME,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.value, 1000);
});

// ── Quarterisation ────────────────────────────────────────────────────────────

const period = (start: string, end: string, value: number, filed: string) => ({
  start, end: isoDate(end), filed: isoDate(filed), value, form: "10-Q", accession: "a", tag: "Revenues",
});

test("Q4 is derived as the residual when only the full year is reported", () => {
  const quarters = quarterize([
    period("2025-01-01", "2025-03-31", 100, "2025-05-01"),
    period("2025-04-01", "2025-06-30", 110, "2025-08-01"),
    period("2025-07-01", "2025-09-30", 120, "2025-11-01"),
    { ...period("2025-01-01", "2025-12-31", 500, "2026-02-01"), form: "10-K" },
  ]);

  assert.equal(quarters.length, 4);
  const q4 = quarters.at(-1);
  assert.equal(q4?.value, 170); // 500 - 330
  assert.match(q4?.tag ?? "", /Q4 residual/);
  // Knowable only when the 10-K landed.
  assert.equal(q4?.filed, "2026-02-01");
});

test("a directly reported Q4 is not overwritten by a residual", () => {
  const quarters = quarterize([
    period("2025-01-01", "2025-03-31", 100, "2025-05-01"),
    period("2025-04-01", "2025-06-30", 110, "2025-08-01"),
    period("2025-07-01", "2025-09-30", 120, "2025-11-01"),
    period("2025-10-01", "2025-12-31", 200, "2026-02-01"),
    { ...period("2025-01-01", "2025-12-31", 500, "2026-02-01"), form: "10-K" },
  ]);

  assert.equal(quarters.length, 4);
  assert.equal(quarters.at(-1)?.value, 200);
});

test("an annual figure with no quarters produces nothing rather than a fake quarter", () => {
  const quarters = quarterize([{ ...period("2025-01-01", "2025-12-31", 500, "2026-02-01"), form: "10-K" }]);
  assert.deepEqual(quarters, []);
});

// ── Submissions ───────────────────────────────────────────────────────────────

test("submissions become a profile with filings newest first", () => {
  const submissions: Submissions = {
    cik: 1234, name: "Acme Corp", sic: "3571", tickers: ["ACME"],
    filings: {
      recent: {
        form: ["10-Q", "10-K"],
        filingDate: ["2026-07-20", "2026-02-15"],
        accessionNumber: ["0001-26-000002", "0001-26-000001"],
        primaryDocument: ["q.htm", "k.htm"],
      },
    },
  };

  const profile = submissionsToProfile(submissions);
  assert.ok(profile);
  assert.equal(profile.entity, "ACME");
  assert.equal(profile.cik, "0000001234");
  assert.equal(profile.sector, "manufacturing");
  assert.equal(profile.filings[0]?.filedAt, "2026-07-20");
});

test("a filer with no ticker is not screenable", () => {
  assert.equal(submissionsToProfile({ cik: 1, name: "Private Co" }), undefined);
});

// ── Filing text ───────────────────────────────────────────────────────────────

test("item extraction prefers the body over the table of contents", () => {
  const text =
    "TABLE OF CONTENTS Item 1A. Risk Factors 12 Item 7. Management's Discussion 30 " +
    "Item 1A. Risk Factors " + "Our supply chain is concentrated. ".repeat(40) +
    "Item 1B. Unresolved Staff Comments None.";

  const risks = extractItem(text, /Item\s+1A\.?\s*R/gi, /Item\s+1B\.?\s|Item\s+2\.?\s/i);
  assert.ok(risks.includes("supply chain is concentrated"));
  assert.equal(risks.includes("Unresolved Staff Comments"), false);
});

test("a filing with no such item yields an empty string, not a throw", () => {
  assert.equal(extractItem("nothing here", /Item\s+7\.?\s*M/gi, /Item\s+8/i), "");
});

test("filing text is fetched from the accession path with zeros stripped from the CIK", async () => {
  let requested = "";
  const client = createEdgarClient({
    userAgent: "test", gate: noWait,
    fetch: async (url) => {
      requested = url;
      return new Response(
        "<html><body>Item 7. Management's Discussion and Analysis " +
          "Revenue rose on volume. ".repeat(20) +
          "Item 8. Financial Statements</body></html>",
      );
    },
  });

  const filing = { form: "10-K", filedAt: isoDate("2026-02-15"), accession: "0000320193-26-000001", primaryDocument: "aapl-10k.htm" };
  assert.equal(filingUrl(cik(320193), filing), "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-10k.htm");

  const fetched = await fetchFilingText(client, cik(320193), filing);
  assert.equal(requested, filingUrl(cik(320193), filing));
  assert.ok(fetched.mdna.includes("Revenue rose on volume"));
  assert.equal(fetched.form, "10-K");
});

test("overflow submissions members are skipped, primary ones kept", () => {
  // Shapes taken from the live submissions.zip central directory.
  assert.equal(isPrimaryCikEntry("CIK0000320193.json"), true);
  assert.equal(isPrimaryCikEntry("CIK0000005981-submissions-001.json"), false);
  assert.equal(isPrimaryCikEntry("metadata.json"), false);
  assert.equal(isPrimaryCikEntry("CIK0000320193.json.bak"), false);
});

test("a member's CIK is readable from its filename, before parsing it", () => {
  assert.equal(cikFromEntryName("CIK0000320193.json"), "0000320193");
  assert.equal(cikFromEntryName("CIK1750.json"), "0000001750");
  assert.equal(cikFromEntryName("CIK0000005981-submissions-001.json"), undefined);
  assert.equal(cikFromEntryName("metadata.json"), undefined);
});

test("a bulk download streams to disk and gets a long timeout", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "jev-dl-"));
  const payload = Buffer.alloc(64 * 1024, 7);
  let requestedTimeout = 0;

  const client = createEdgarClient({
    userAgent: "test", gate: noWait, cacheDir,
    fetch: async (_url, init) => {
      // The archive timeout must be far larger than the small-request one.
      const signal = init?.signal as (AbortSignal & { _t?: number }) | undefined;
      requestedTimeout = signal ? 1 : 0;
      return new Response(payload, { headers: { "content-length": String(payload.length) } });
    },
  });

  const path = await client.download("https://www.sec.gov/x/companyfacts.zip", "bulk.zip");
  const { readFile: read } = await import("node:fs/promises");
  assert.deepEqual(await read(path), payload, "the whole body reached disk intact");
  assert.equal(requestedTimeout, 1, "a timeout signal was attached");
});

test("an interrupted download leaves no file to be mistaken for complete", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "jev-dl-"));
  const client = createEdgarClient({
    userAgent: "test", gate: noWait, cacheDir,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
            controller.error(new Error("connection reset"));
          },
        }),
      ),
  });

  await assert.rejects(() => client.download("https://www.sec.gov/x/bulk.zip", "bulk.zip"), /connection reset/);

  const { stat: statFile } = await import("node:fs/promises");
  await assert.rejects(() => statFile(join(cacheDir, "bulk.zip")), /ENOENT/);
  await assert.rejects(() => statFile(join(cacheDir, "bulk.zip.part")), /ENOENT/);
});

test("a cached archive is reused without re-reading it into memory", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "jev-dl-"));
  let fetches = 0;
  const client = createEdgarClient({
    userAgent: "test", gate: noWait, cacheDir,
    fetch: async () => {
      fetches++;
      return new Response(Buffer.alloc(2048, 3));
    },
  });

  await client.download("https://www.sec.gov/x/bulk.zip", "bulk.zip");
  await client.download("https://www.sec.gov/x/bulk.zip", "bulk.zip");
  assert.equal(fetches, 1);
});
