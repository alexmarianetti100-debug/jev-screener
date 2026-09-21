/**
 * Bounded-concurrency runner.
 *
 * Every jev call in the screener goes through one of these. The SDK already retries
 * and backs off per request; this bounds how many are in flight at once, so a
 * 5,000-company sweep does not open 5,000 sockets.
 */

export interface PoolProgress {
  readonly done: number;
  readonly total: number;
  readonly failed: number;
}

export interface PoolOptions {
  readonly size: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PoolProgress) => void;
}

export interface PoolResult<T> {
  readonly results: readonly (T | undefined)[];
  readonly failures: readonly { readonly index: number; readonly error: unknown }[];
}

/**
 * Run `task` over `items` with at most `size` in flight.
 *
 * Results keep the input order. One failure does not cancel the rest: a single
 * company that will not parse should not throw away a sweep, so failures are
 * collected and reported alongside the results.
 */
export async function runPool<I, O>(
  items: readonly I[],
  task: (item: I, index: number) => Promise<O>,
  options: PoolOptions,
): Promise<PoolResult<O>> {
  const size = Math.max(1, Math.floor(options.size));
  // Dense, not sparse: a failed slot must read as `undefined`, not as a hole
  // that `map` and `forEach` silently skip.
  const results: (O | undefined)[] = Array.from({ length: items.length }, () => undefined);
  const failures: { index: number; error: unknown }[] = [];

  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;
      const index = next++;
      if (index >= items.length) return;

      try {
        results[index] = await task(items[index]!, index);
      } catch (error) {
        failures.push({ index, error });
      } finally {
        done++;
        options.onProgress?.({ done, total: items.length, failed: failures.length });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  failures.sort((a, b) => a.index - b.index);
  return { results, failures };
}

/**
 * A fixed-rate gate, used by the HTTP adapters.
 *
 * Serialises through a promise chain rather than a timer queue so that bursts are
 * spaced evenly instead of arriving together at the top of each second.
 */
export function rateLimiter(
  requestsPerSecond: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<void> {
  const minIntervalMs = 1000 / requestsPerSecond;
  let chain: Promise<void> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  return () => {
    const ready = chain.then(async () => {
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
    });
    // Keep the chain alive even if a caller rejects, so the gate never wedges.
    chain = ready.then(
      () => undefined,
      () => undefined,
    );
    return ready;
  };
}
