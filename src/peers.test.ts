import assert from "node:assert/strict";
import test from "node:test";
import { cik,derive, isoDate, observation, ticker, type Observation } from "./observation.ts";
import type { DerivedMetric, MetricRow } from "./metrics.ts";
import { buildPeerTables, distributionsOver, overlayDistributions, peerContextFor } from "./peers.ts";

const ASOF = isoDate("2026-09-01");

function row(symbol: string, sector: string, metrics: Partial<Record<DerivedMetric, number>>): MetricRow {
  const entity = cik(String(symbol.length * 1000 + symbol.charCodeAt(0)));
  const seed = observation({
    value: 1, metric: "revenue", entity,
    validAt: ASOF, knownAt: ASOF, source: "test", reliability: "reported",
  });

  const built: Partial<Record<DerivedMetric, Observation>> = {};
  for (const [metric, value] of Object.entries(metrics)) {
    built[metric as DerivedMetric] = derive(value as number, metric, [seed]);
  }
  return { entity, label: symbol, sector, asOf: ASOF, metrics: built, inputs: [seed], hasPrice: false };
}

test("quartiles interpolate across the values present", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => row(`C${n}`, "retail", { operatingMargin: n / 10 }));
  const distribution = distributionsOver(rows).operatingMargin;

  assert.equal(distribution?.count, 5);
  assert.equal(distribution?.min, 0.1);
  assert.equal(distribution?.median, 0.3);
  assert.equal(distribution?.max, 0.5);
  assert.equal(distribution?.p25.toFixed(2), "0.20");
});

test("companies missing a metric are left out rather than zero-filled", () => {
  const rows = [
    row("A", "retail", { operatingMargin: 0.2 }),
    row("B", "retail", {}),
    row("C", "retail", { operatingMargin: 0.4 }),
  ];
  const distribution = distributionsOver(rows).operatingMargin;

  // A zero-fill would drag the median to 0.2 and quietly misrepresent the universe.
  assert.equal(distribution?.count, 2);
  assert.equal(distribution?.median.toFixed(6), "0.300000");
});

test("every company in a sector sees the same yardstick", () => {
  const rows = [
    row("R1", "retail", { operatingMargin: 0.1 }),
    row("R2", "retail", { operatingMargin: 0.3 }),
    row("M1", "manufacturing", { operatingMargin: 0.9 }),
  ];
  const tables = buildPeerTables(rows, ASOF);

  const first = peerContextFor(tables, "retail");
  const second = peerContextFor(tables, "retail");
  assert.deepEqual(first, second);

  // Universe spans both sectors; sector context does not.
  assert.equal(first.universe.count, 3);
  assert.equal(first.sector.count, 2);
  assert.equal(first.universe.distributions.operatingMargin?.max, 0.9);
  assert.equal(first.sector.distributions.operatingMargin?.max, 0.3);
});

test("a sector with no members yields an empty context, not a throw", () => {
  const tables = buildPeerTables([row("A", "retail", { operatingMargin: 0.2 })], ASOF);
  const context = peerContextFor(tables, "mining & energy");

  assert.equal(context.sector.count, 0);
  assert.deepEqual(context.sector.distributions, {});
});

test("price metrics overlay onto the universe table without disturbing the rest", () => {
  const all = [
    row("A", "retail", { operatingMargin: 0.1 }),
    row("B", "retail", { operatingMargin: 0.3 }),
    row("C", "retail", { operatingMargin: 0.5 }),
  ];
  const survivors = [
    row("B", "retail", { operatingMargin: 0.3, priceToEarnings: 12 }),
    row("C", "retail", { operatingMargin: 0.5, priceToEarnings: 20 }),
  ];

  const base = buildPeerTables(all, ASOF);
  const merged = overlayDistributions(base, survivors, ["priceToEarnings"]);

  // Operating margin still spans all three; P/E covers the two that have a price,
  // and `count` says so rather than pretending it covers the universe.
  assert.equal(merged.universe.operatingMargin?.count, 3);
  assert.equal(merged.universe.priceToEarnings?.count, 2);
  assert.equal(merged.universe.priceToEarnings?.median, 16);
  assert.equal(merged.universeCount, 3);
});

test("the merged table is identical for every company in a stage", () => {
  const survivors = [row("B", "retail", { priceToEarnings: 12 }), row("C", "retail", { priceToEarnings: 20 })];
  const merged = overlayDistributions(buildPeerTables(survivors, ASOF), survivors, ["priceToEarnings"]);

  const forB = peerContextFor(merged, "retail");
  const forC = peerContextFor(merged, "retail");
  assert.deepEqual(forB, forC);
});

test("an empty universe produces no distributions rather than NaN", () => {
  const tables = buildPeerTables([], ASOF);
  assert.deepEqual(tables.universe, {});
  assert.equal(tables.universeCount, 0);
});

test("a single-company universe still yields a usable distribution", () => {
  const distribution = distributionsOver([row("ONLY", "retail", { operatingMargin: 0.42 })]).operatingMargin;

  assert.equal(distribution?.count, 1);
  assert.equal(distribution?.min, 0.42);
  assert.equal(distribution?.median, 0.42);
  assert.equal(distribution?.max, 0.42);
});

test("peer tables never rank or filter — they only summarise", () => {
  const rows = [row("BAD", "retail", { operatingMargin: -5 }), row("GOOD", "retail", { operatingMargin: 5 })];
  const tables = buildPeerTables(rows, ASOF);

  // Both companies are represented; nothing was dropped for being unattractive.
  assert.equal(tables.universe.operatingMargin?.count, 2);
  assert.equal(tables.universe.operatingMargin?.min, -5);
});
