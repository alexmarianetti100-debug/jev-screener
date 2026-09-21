import assert from "node:assert/strict";
import test from "node:test";
import { MIN_REVENUE_QUARTERS } from "./constants.ts";
import { buildSlice, cik, isoDate, observation, ticker, type Observation } from "./observation.ts";
import { assessEligibility, buildUniverse, sectorForSic, type FilerProfile } from "./universe.ts";

const ASOF = isoDate("2026-09-01");
const ACME = ticker("ACME");

function profile(overrides: Partial<FilerProfile> = {}): FilerProfile {
  return {
    entity: ACME,
    cik: cik(1234),
    name: "Acme Corp",
    sic: "3571",
    sector: "manufacturing",
    filings: [
      { form: "10-K", filedAt: isoDate("2026-02-15"), accession: "0001-26-000001", primaryDocument: "acme-10k.htm" },
      { form: "10-Q", filedAt: isoDate("2026-07-20"), accession: "0001-26-000002", primaryDocument: "acme-10q.htm" },
    ],
    ...overrides,
  };
}

/** `count` quarters of revenue plus the three completeness metrics. */
function observations(count = MIN_REVENUE_QUARTERS): Observation[] {
  const rows: Observation[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(2023, 2 + i * 3, 31));
    rows.push(
      observation({
        value: 100, metric: "revenue", entity: ACME,
        validAt: isoDate(date.toISOString()), knownAt: isoDate(date.toISOString()),
        source: "edgar", reliability: "reported",
      }),
    );
  }
  for (const metric of ["netIncome", "operatingCashFlow", "totalAssets"]) {
    rows.push(
      observation({
        value: 10, metric, entity: ACME,
        validAt: isoDate("2026-06-30"), knownAt: isoDate("2026-07-20"),
        source: "edgar", reliability: "reported",
      }),
    );
  }
  return rows;
}

const assess = (p: FilerProfile, rows: Observation[] = observations()) =>
  assessEligibility(p, buildSlice(rows, ASOF), ASOF);

test("a complete, current domestic filer is eligible", () => {
  const verdict = assess(profile());

  assert.equal(verdict.eligible, true);
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.latestAnnualReport?.form, "10-K");
});

test("a stale annual report makes a company unevaluable", () => {
  const verdict = assess(profile({
    filings: [{ form: "10-K", filedAt: isoDate("2024-01-10"), accession: "x", primaryDocument: "d.htm" }],
  }));

  assert.equal(verdict.eligible, false);
  assert.match(verdict.missing.join(" "), /older than 18 months/);
});

test("foreign issuers and funds are out", () => {
  const foreign = assess(profile({
    filings: [
      { form: "20-F", filedAt: isoDate("2026-03-01"), accession: "x", primaryDocument: "d.htm" },
      { form: "10-K", filedAt: isoDate("2026-03-01"), accession: "y", primaryDocument: "e.htm" },
    ],
  }));
  assert.equal(foreign.eligible, false);
  assert.match(foreign.missing.join(" "), /foreign issuer or fund/);

  const fund = assess(profile({
    filings: [{ form: "N-CSR", filedAt: isoDate("2026-03-01"), accession: "x", primaryDocument: "d.htm" }],
  }));
  assert.equal(fund.eligible, false);
});

test("too little history is an eligibility failure, not a judgment", () => {
  const verdict = assess(profile(), observations(MIN_REVENUE_QUARTERS - 1));

  assert.equal(verdict.eligible, false);
  assert.match(verdict.missing.join(" "), /revenue quarters, need 12/);
});

test("a missing core figure is named specifically", () => {
  const withoutCashFlow = observations().filter((o) => o.metric !== "operatingCashFlow");
  const verdict = assess(profile(), withoutCashFlow);

  assert.equal(verdict.eligible, false);
  assert.ok(verdict.missing.includes("no operatingCashFlow observation"));
});

test("eligibility never looks at what a value is, only that it exists", () => {
  // Same shape of data, wildly different businesses: both must be eligible.
  const thriving = observations().map((o) => ({ ...o, value: o.value * 1000 }));
  const collapsing = observations().map((o) => ({ ...o, value: -o.value }));

  assert.equal(assess(profile(), thriving).eligible, true);
  assert.equal(assess(profile(), collapsing).eligible, true);
});

test("price data is not required — triage runs without it", () => {
  const verdict = assess(profile());
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.missing.join(" ").includes("close"), false);
});

test("the universe report tallies why companies were dropped", () => {
  const good = profile();
  const stale = profile({
    entity: ticker("OLD"),
    filings: [{ form: "10-K", filedAt: isoDate("2023-01-10"), accession: "x", primaryDocument: "d.htm" }],
  });

  const report = buildUniverse([good, stale], buildSlice(observations(), ASOF), ASOF);

  assert.equal(report.considered, 2);
  assert.equal(report.eligible.length, 1);
  assert.equal(report.ineligible.length, 1);
  assert.ok(report.reasonCounts.length > 0);
  assert.ok(report.reasonCounts.every((r) => r.count >= 1));
});

test("SIC codes map to coarse sectors", () => {
  assert.equal(sectorForSic("3571"), "manufacturing");
  assert.equal(sectorForSic("5812"), "retail");
  assert.equal(sectorForSic("6022"), "finance & real estate");
  assert.equal(sectorForSic(""), "unknown");
});
