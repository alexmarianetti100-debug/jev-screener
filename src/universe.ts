/**
 * Eligibility: can we evaluate this company at all?
 *
 * Every predicate here references only the **presence, recency or completeness** of
 * data — never its value. "Has filed a 10-K in the last 18 months" is a statement
 * about our inputs. "Has revenue growth above 10%" would be a statement about the
 * business, and belongs to jev.
 *
 * The distinction is the load-bearing one in this project. Eligibility narrows the
 * universe to companies we can describe; it must never narrow it to companies we
 * like, because that would quietly make this file the screener.
 */

import { MAX_ANNUAL_REPORT_AGE_MONTHS, MIN_REVENUE_QUARTERS } from "./constants.ts";
import { addMonths, type CIK, type ISODate, type ObservationSlice, type Ticker } from "./observation.ts";

/** A filing as recorded in EDGAR's submissions index. */
export interface FilingRef {
  readonly form: string;
  readonly filedAt: ISODate;
  readonly accession: string;
  readonly primaryDocument: string;
}

/** What the submissions index tells us about a filer. */
export interface FilerProfile {
  readonly entity: Ticker;
  readonly cik: CIK;
  readonly name: string;
  readonly sic: string;
  readonly sector: string;
  /** Newest first. */
  readonly filings: readonly FilingRef[];
}

/** Forms that mark a domestic operating company. */
const DOMESTIC_FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A"]);

/**
 * Forms that mark something this screener cannot evaluate: foreign private issuers
 * reporting under a different regime, and funds, which have no operating business.
 */
const NON_OPERATING_FORMS = new Set(["20-F", "40-F", "N-CSR", "N-CSRS", "N-Q", "N-1A", "485BPOS", "24F-2NT"]);

export interface EligibilityVerdict {
  readonly entity: Ticker;
  readonly eligible: boolean;
  /** Which predicates failed, for `coverage_status`. Empty when eligible. */
  readonly missing: readonly string[];
  readonly latestAnnualReport?: FilingRef;
}

/** Newest filing matching any of `forms`, or `undefined`. */
export function latestFiling(
  profile: FilerProfile,
  forms: readonly string[],
  asOf: ISODate,
): FilingRef | undefined {
  return profile.filings
    .filter((f) => forms.includes(f.form) && f.filedAt <= asOf)
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt))[0];
}

/**
 * Decide whether a company can be evaluated as of `asOf`.
 *
 * Each check below is a question about data availability. If you find yourself
 * wanting to add one about a value — profitability, size, leverage — that is the
 * screener trying to escape into this file. Put it in a jev question instead.
 */
export function assessEligibility(
  profile: FilerProfile,
  slice: ObservationSlice,
  asOf: ISODate,
): EligibilityVerdict {
  const missing: string[] = [];

  // 1. Reports on the domestic operating-company schedule.
  const filesDomestic = profile.filings.some((f) => DOMESTIC_FORMS.has(f.form) && f.filedAt <= asOf);
  const filesNonOperating = profile.filings.some((f) => NON_OPERATING_FORMS.has(f.form) && f.filedAt <= asOf);
  if (!filesDomestic) missing.push("no 10-K or 10-Q on file");
  if (filesNonOperating) missing.push("files as a foreign issuer or fund");

  // 2. Recent enough that the filings still describe the company.
  const annual = latestFiling(profile, ["10-K", "10-K/A"], asOf);
  const cutoff = addMonths(asOf, -MAX_ANNUAL_REPORT_AGE_MONTHS);
  if (!annual) missing.push("no 10-K on file");
  else if (annual.filedAt < cutoff) missing.push(`newest 10-K (${annual.filedAt}) older than ${MAX_ANNUAL_REPORT_AGE_MONTHS} months`);

  // 3. Enough history for the trend arithmetic to have anything to work with.
  const revenueQuarters = slice.series(profile.entity, "revenue").length;
  if (revenueQuarters < MIN_REVENUE_QUARTERS) {
    missing.push(`${revenueQuarters} revenue quarters, need ${MIN_REVENUE_QUARTERS}`);
  }

  // 4. The handful of figures without which most metrics cannot be computed.
  for (const metric of ["netIncome", "operatingCashFlow", "totalAssets"]) {
    if (!slice.latest(profile.entity, metric)) missing.push(`no ${metric} observation`);
  }

  const verdict: EligibilityVerdict = {
    entity: profile.entity,
    eligible: missing.length === 0,
    missing,
  };
  // Note: price is deliberately not required. Triage judges operating fundamentals
  // without it, and prices are fetched only for the companies that survive.
  return annual ? { ...verdict, latestAnnualReport: annual } : verdict;
}

export interface UniverseReport {
  readonly asOf: ISODate;
  readonly considered: number;
  readonly eligible: readonly EligibilityVerdict[];
  readonly ineligible: readonly EligibilityVerdict[];
  /** How many companies each failing predicate knocked out, commonest first. */
  readonly reasonCounts: readonly { readonly reason: string; readonly count: number }[];
}

export function buildUniverse(
  profiles: readonly FilerProfile[],
  slice: ObservationSlice,
  asOf: ISODate,
): UniverseReport {
  const eligible: EligibilityVerdict[] = [];
  const ineligible: EligibilityVerdict[] = [];
  const counts = new Map<string, number>();

  for (const profile of profiles) {
    const verdict = assessEligibility(profile, slice, asOf);
    if (verdict.eligible) {
      eligible.push(verdict);
      continue;
    }
    ineligible.push(verdict);
    for (const reason of verdict.missing) {
      // Collapse the parameterised messages so the tally stays readable.
      const key = reason.replace(/\(\d{4}-\d{2}-\d{2}\)/, "(date)").replace(/^\d+ revenue quarters/, "too few revenue quarters");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return {
    asOf,
    considered: profiles.length,
    eligible,
    ineligible,
    reasonCounts: [...counts]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

/**
 * Coarse sector grouping from an SIC code.
 *
 * A mapping, not a judgment: it only decides which companies are compared with which,
 * and applies the same way to every company in a division.
 */
export function sectorForSic(sic: string): string {
  const code = Number.parseInt(sic, 10);
  if (!Number.isFinite(code)) return "unknown";
  if (code < 1000) return "agriculture";
  if (code < 1500) return "mining & energy";
  if (code < 1800) return "construction";
  if (code < 4000) return "manufacturing";
  if (code < 5000) return "transport & utilities";
  if (code < 5200) return "wholesale";
  if (code < 6000) return "retail";
  if (code < 6800) return "finance & real estate";
  if (code < 9000) return "services";
  return "public administration";
}
