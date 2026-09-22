import assert from "node:assert/strict";
import test from "node:test";
import { runScreen } from "./cli.ts";
import { demoClients, seedDemoStore } from "./demo.ts";
import { todayISO } from "./observation.ts";

test("demo mode runs the real pipeline with no keys and no network", async () => {
  const store = await seedDemoStore();
  try {
    const { client, prices, edgar } = demoClients();
    const report = await runScreen({ store, client, prices, edgar, limit: 10 });

    // Eligibility, metrics, peers, judgment, assembly and persistence all execute.
    assert.equal(report.eligible, 3, "every fixture clears eligibility");
    assert.equal(report.judged, 3);
    assert.equal(report.usage.inputTokens, 0, "nothing was spent");
    assert.deepEqual(report.failures, [], "the expected path produces no failures");

    // The stub keys off revenue growth, so only the growing company survives.
    assert.deepEqual(report.picks.map((p) => p.label), ["GOODCO"]);
    assert.equal(report.picks[0]?.verdict.choice, "include");
  } finally {
    await store.close();
  }
});

test("demo fixtures follow the clock, so the demo cannot rot", async () => {
  const store = await seedDemoStore();
  try {
    // A hard-coded quarter list dates the newest filing into the future the moment
    // the calendar passes it, and eligibility then correctly screens everything out.
    // A demo that silently returns nothing is worse than no demo.
    const slice = await store.sliceAsOf(todayISO());
    assert.equal(slice.series("0001000001" as never, "revenue").length, 12,
      "twelve quarters are knowable as of today, whenever today is");
  } finally {
    await store.close();
  }
});

test("the demo run is persisted like any other, roster included", async () => {
  const store = await seedDemoStore();
  try {
    const { client, prices, edgar } = demoClients();
    await runScreen({ store, client, prices, edgar, limit: 10 });

    const last = await store.latestRun();
    assert.ok(last, "a demo run is a run");
    const roster = (last.payload as { roster?: unknown[] }).roster ?? [];
    assert.equal(roster.length, 3, "every judged company, not only the picks");
  } finally {
    await store.close();
  }
});
