import assert from "node:assert/strict";
import test from "node:test";
import { MIN_REVENUE_QUARTERS } from "./constants.ts";
import { buildSlice, cik, isoDate, observation, ticker, type Observation } from "./observation.ts";
import { assessEligibility, buildUniverse, displayLabel, resolveTickers, sectorForSic, type FilerProfile } from "./universe.ts";

const ASOF = isoDate("2026-09-01");
const ACME = cik("320193");

function profile(overrides: Partial<FilerProfile> = {}): FilerProfile {
  return {
    entity: ACME,
    cik: cik(1234),
    tickers: [ticker("ACME")],
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
    entity: cik("111111"),
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

// ── Symbols are labels, the CIK is the identity ───────────────────────────────

test("one filer can carry several symbols, and each resolves to it", () => {
  // Alphabet files under one CIK and lists GOOGL, GOOG, GOOGM and GOOGN. Keeping
  // only one meant a screen for three perfectly ordinary tickers returned nothing.
  const alphabet = profile({
    entity: cik(1652044),
    cik: cik(1652044),
    tickers: [ticker("GOOG"), ticker("GOOGL"), ticker("GOOGM"), ticker("GOOGN")],
  });

  for (const symbol of ["GOOG", "GOOGL", "GOOGM", "GOOGN"]) {
    assert.deepEqual(resolveTickers([alphabet], [ticker(symbol)]).entities, [cik(1652044)]);
  }
});

test("a symbol no filer carries is reported, not silently dropped", () => {
  const resolution = resolveTickers([profile()], [ticker("NOSUCH")]);
  assert.deepEqual(resolution.entities, []);
  assert.deepEqual(resolution.unknown, [ticker("NOSUCH")]);
});

test("a symbol two filers claim is surfaced as ambiguous, never picked between", () => {
  // The XOM case: choosing one of two filers that claim a symbol is how a screener
  // ends up confidently describing the wrong company.
  const real = profile({ entity: cik(34088), cik: cik(34088), tickers: [ticker("XOM")], name: "Exxon Mobil Corp" });
  const other = profile({ entity: cik(2115436), cik: cik(2115436), tickers: [ticker("XOM")], name: "ExxonMobil Holdings Corp" });

  const resolution = resolveTickers([real, other], [ticker("XOM")]);
  assert.equal(resolution.ambiguous.length, 1);
  assert.deepEqual(resolution.ambiguous[0]?.entities, [cik(34088), cik(2115436)]);
  assert.equal(resolution.entities.length, 2, "both are judged rather than one guessed at");
});

test("a filer with no symbol is shown by CIK rather than hidden", () => {
  const unlisted = profile({ entity: cik(34088), cik: cik(34088), tickers: [] });
  assert.equal(displayLabel(unlisted), "CIK0000034088");
  assert.equal(displayLabel(profile()), "ACME");
});

test("healthcare is not scattered across three SIC divisions", () => {
  // UnitedHealth (6324) was being peer-compared against banks and REITs, and a
  // biotech (2836) against steel mills. Both make the yardstick meaningless.
  assert.equal(sectorForSic("6324"), "healthcare", "hospital and medical service plans");
  assert.equal(sectorForSic("6321"), "healthcare", "accident and health insurance");
  assert.equal(sectorForSic("2834"), "healthcare", "pharmaceutical preparations");
  assert.equal(sectorForSic("2836"), "healthcare", "biological products");
  assert.equal(sectorForSic("3845"), "healthcare", "electromedical apparatus");
  assert.equal(sectorForSic("8060"), "healthcare", "hospitals");

  // The neighbours those ranges were carved out of are untouched.
  assert.equal(sectorForSic("6022"), "finance & real estate", "a state bank is still finance");
  assert.equal(sectorForSic("2840"), "manufacturing", "soap is still manufacturing");
  assert.equal(sectorForSic("3861"), "manufacturing", "photographic equipment is still manufacturing");
  assert.equal(sectorForSic("8200"), "services", "schools are still services");
});
