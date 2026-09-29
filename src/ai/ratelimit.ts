/**
 * Client-side rate limiting for AI calls: minimum spacing per key,
 * max concurrent requests globally, and in-flight deduplication so
 * duplicate renders and double-clicks never fan out.
 */

export const AI_MIN_INTERVAL_MS = 10_000;
export const AI_MAX_CONCURRENT = 2;

const lastCallByKey = new Map<string, number>();
const inflight = new Map<string, Promise<unknown>>();
let activeCount = 0;
const queue: (() => void)[] = [];

function pump(): void {
  while (activeCount < AI_MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (next) {
      activeCount += 1;
      next();
    }
  }
}

function release(): void {
  activeCount = Math.max(0, activeCount - 1);
  pump();
}

/** Wait until `key` is outside its throttle window (0ms when clear). */
export function throttleDelayMs(key: string, now = Date.now()): number {
  const last = lastCallByKey.get(key);
  if (last === undefined) return 0;
  return Math.max(0, AI_MIN_INTERVAL_MS - (now - last));
}

export function markCalled(key: string, now = Date.now()): void {
  lastCallByKey.set(key, now);
}

/**
 * Run `task` deduplicated by key (concurrent callers share one promise)
 * and bounded by the global concurrency cap.
 */
export function dedupedRequest<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = new Promise<T>((resolve, reject) => {
    queue.push(() => {
      task().then(
        (v) => {
          release();
          resolve(v);
        },
        (e: unknown) => {
          release();
          reject(e);
        },
      );
    });
    pump();
  });
  inflight.set(key, promise);
  const cleanup = () => {
    if (inflight.get(key) === promise) inflight.delete(key);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

export function resetRateLimitForTests(): void {
  lastCallByKey.clear();
  inflight.clear();
  activeCount = 0;
  queue.length = 0;
}

/** In-flight + queued AI tasks (dev monitor; the cap is AI_MAX_CONCURRENT). */
export function aiQueueDepth(): number {
  return activeCount + queue.length;
}
