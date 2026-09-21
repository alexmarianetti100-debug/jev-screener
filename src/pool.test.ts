import assert from "node:assert/strict";
import test from "node:test";
import { rateLimiter, runPool } from "./pool.ts";

test("results keep input order however the tasks interleave", async () => {
  const items = [40, 10, 30, 20, 0];
  const { results } = await runPool(
    items,
    async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    },
    { size: 5 },
  );

  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

test("concurrency never exceeds the pool size", async () => {
  let inFlight = 0;
  let peak = 0;

  await runPool(
    Array.from({ length: 30 }, (_, i) => i),
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    },
    { size: 4 },
  );

  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, "the pool did run tasks in parallel");
});

test("one failure does not throw away the rest of the sweep", async () => {
  const { results, failures } = await runPool(
    ["ok", "boom", "ok", "boom", "ok"],
    async (item, index) => {
      if (item === "boom") throw new Error(`failed at ${index}`);
      return index;
    },
    { size: 2 },
  );

  assert.deepEqual(results, [0, undefined, 2, undefined, 4]);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map((f) => f.index), [1, 3]);
  assert.match((failures[0]!.error as Error).message, /failed at 1/);
});

test("progress is reported as tasks land", async () => {
  const seen: number[] = [];
  await runPool([1, 2, 3], async () => undefined, {
    size: 1,
    onProgress: (p) => seen.push(p.done),
  });

  assert.deepEqual(seen, [1, 2, 3]);
});

test("an empty list is a no-op rather than a hang", async () => {
  const { results, failures } = await runPool([], async () => 1, { size: 8 });
  assert.deepEqual(results, []);
  assert.deepEqual(failures, []);
});

test("an aborted signal stops workers picking up new items", async () => {
  const controller = new AbortController();
  let started = 0;

  await runPool(
    Array.from({ length: 50 }, (_, i) => i),
    async () => {
      started++;
      if (started === 3) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    { size: 1, signal: controller.signal },
  );

  assert.ok(started < 50, `stopped after ${started} of 50`);
});

test("the rate limiter spaces calls without sharing state between limiters", async () => {
  let now = 0;
  const clock = () => now;
  const sleep = async (ms: number): Promise<void> => {
    now += ms;
  };

  const ten = rateLimiter(10, clock, sleep);   // 100ms apart
  const two = rateLimiter(2, clock, sleep);    // 500ms apart

  await ten();
  const firstTen = now;
  await ten();
  assert.equal(now - firstTen, 100);

  // A separate limiter must keep its own clock, not inherit the other's.
  const beforeTwo = now;
  await two();
  assert.equal(now, beforeTwo, "first call through a fresh limiter does not wait");
  await two();
  assert.equal(now - beforeTwo, 500);
});

test("a rejected caller does not wedge the gate", async () => {
  const gate = rateLimiter(1000);
  await assert.rejects(async () => {
    await gate();
    throw new Error("caller blew up");
  });

  // The chain must still be usable afterwards.
  await gate();
  assert.ok(true);
});
