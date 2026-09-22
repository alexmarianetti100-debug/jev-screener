import assert from "node:assert/strict";
import test from "node:test";
import { runScreen } from "./cli.ts";
import { demoClients, seedDemoStore } from "./demo.ts";
import { serve } from "./serve.ts";
import type { Store } from "./store.ts";

/** A server on an ephemeral port, seeded with a real (demo) run behind it. */
async function withServer(fn: (base: string, store: Store) => Promise<void>): Promise<void> {
  const store = await seedDemoStore();
  const { client, prices, edgar } = demoClients();
  await runScreen({ store, client, prices, edgar, limit: 10 });

  const { port, close } = await serve(store, { port: 0 });
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await close();
    await store.close();
  }
}

test("the page loads and the run behind it is served", async () => {
  await withServer(async (base) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /jev screener/);

    const run = await (await fetch(`${base}/api/run`)).json() as {
      picks: { ticker: string }[]; counts: { judged: number }; disclaimer: string;
    };
    assert.equal(run.counts.judged, 3);
    assert.deepEqual(run.picks.map((p) => p.ticker), ["GOODCO"]);
    assert.match(run.disclaimer, /Not a recommendation/);
  });
});

test("the view cannot start a screen, whatever it is sent", async () => {
  await withServer(async (base, store) => {
    const before = await store.runCount();

    // Every mutation verb is refused before routing, so no handler can be added
    // later that quietly accepts one. A page load must never cost money.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/api/run`, { method });
      assert.equal(res.status, 405, `${method} must be refused`);
      assert.match((await res.json() as { error: string }).error, /read-only/);
    }

    // And reading, repeatedly, does not judge anything either.
    await fetch(`${base}/api/run`);
    await fetch(`${base}/api/run`);
    assert.equal(await store.runCount(), before, "no run was created by serving the page");
  });
});

test("explain drills into one company's provenance", async () => {
  await withServer(async (base) => {
    const d = await (await fetch(`${base}/api/explain?ticker=goodco`)).json() as {
      ticker: string; eligible: boolean; observations: unknown[]; metrics: Record<string, unknown>;
    };
    assert.equal(d.ticker, "GOODCO", "lower case resolves");
    assert.equal(d.eligible, true);
    assert.ok(d.observations.length > 0, "every number can be traced");
    assert.ok(Object.keys(d.metrics).length > 0);
  });
});

test("a symbol nothing carries is reported, not a crash", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/explain?ticker=NOSUCH`);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { eligible: boolean }).eligible, false);

    const missing = await fetch(`${base}/api/explain`);
    assert.equal(missing.status, 400);
  });
});

test("coverage and the scorecard are reachable from the page", async () => {
  await withServer(async (base) => {
    const coverage = await (await fetch(`${base}/api/coverage`)).json() as { filers: number };
    assert.equal(coverage.filers, 3);

    const grade = await (await fetch(`${base}/api/grade`)).json() as { horizons: unknown[] }[];
    assert.ok(Array.isArray(grade));
    assert.ok(grade[0]?.horizons.length, "the demo run carries a roster, so it grades");
  });
});

test("an unknown path is a 404 rather than the page", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
  });
});
