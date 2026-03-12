import {
  type CancellablePromise,
  type Promisified,
  type WrapOptions,
  wrap,
} from "./main";
import type { UnwrapTransferArgs, UnwrapReturn } from "./transfer";

export interface PoolOptions {
  /** Number of workers to spawn. Defaults to `navigator.hardwareConcurrency` or 4. */
  size?: number;
  /** Default timeout in milliseconds for every call. 0 or undefined means no timeout. */
  timeout?: number;
  /** Automatically replace workers that crash with fresh ones. Default: false. */
  respawn?: boolean;
}

export type Pool<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any
    ? K
    : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: UnwrapTransferArgs<A>) => CancellablePromise<UnwrapReturn<R>>
    : never;
} & {
  /** Terminate all workers in the pool and reject pending calls. */
  terminate(): void;
  /** Alias for terminate. */
  dispose(): void;
  /** Symbol.dispose support for `using` syntax. */
  [Symbol.dispose](): void;
  /** Number of workers in the pool. */
  readonly size: number;
};

/**
 * Create a pool of workers with automatic least-busy dispatch.
 * Calls are routed to the worker with the fewest in-flight requests.
 *
 * @param factory Function that creates a new Worker instance.
 * @param options Configuration options (e.g. pool size, timeout, respawn).
 * @returns A proxied object with the same method interface as a single wrapped worker.
 */
export function pool<T>(
  factory: () => Worker,
  options: PoolOptions = {},
): Pool<T> {
  const size =
    options.size ??
    (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) ??
    4;

  let terminated = false;

  const workers: Worker[] = [];
  const proxies: Promisified<T>[] = [];
  const pending = new Map<Promisified<T>, number>();
  const wrapOpts: WrapOptions = {};
  if (options.timeout) wrapOpts.timeout = options.timeout;

  function spawnWorker(idx: number) {
    const w = factory();
    workers[idx] = w;
    const p = wrap<T>(w, wrapOpts);
    proxies[idx] = p;
    pending.set(p, 0);

    if (options.respawn) {
      w.addEventListener("error", () => {
        if (terminated) return;
        p.dispose();
        pending.delete(p);
        w.terminate();
        spawnWorker(idx);
      });
    }
  }

  for (let i = 0; i < size; i++) {
    spawnWorker(i);
  }

  /** Pick the proxy with the fewest in-flight calls. */
  function pick(): Promisified<T> {
    let best = proxies[0];
    let bestCount = pending.get(best)!;
    for (let i = 1; i < proxies.length; i++) {
      const count = pending.get(proxies[i])!;
      if (count < bestCount) {
        best = proxies[i];
        bestCount = count;
      }
    }
    return best;
  }

  return new Proxy({} as Pool<T>, {
    get(_, prop: string | symbol) {
      if (prop === "then") return undefined;

      if (
        prop === "terminate" ||
        prop === "dispose" ||
        prop === Symbol.dispose
      ) {
        return () => {
          if (terminated) return;
          terminated = true;
          for (const p of proxies) p.dispose();
          for (const w of workers) w.terminate();
        };
      }

      if (prop === "size") {
        return size;
      }

      return (...args: any[]) => {
        if (terminated) {
          return Promise.reject(new Error("Worker pool has been terminated"));
        }
        const target = pick();
        pending.set(target, (pending.get(target) ?? 0) + 1);
        const result = (target as any)[prop](...args);
        // Bookkeeping side-chain — suppress its rejection since
        // the caller already receives `result` directly.
        result
          .finally(() => {
            const count = pending.get(target);
            if (count != null) {
              pending.set(target, count - 1);
            }
          })
          .catch(() => {});
        return result;
      };
    },
  });
}
