import {
  type CancellablePromise,
  type Promisified,
  type WrapOptions,
  wrap,
} from "./main";
import type { Transfer } from "./transfer";

/** Unwrap Transfer wrappers in a tuple of args. */
type UnwrapTransferArgs<T extends any[]> = {
  [K in keyof T]: T[K] | Transfer<T[K]>;
};

export interface PoolOptions {
  /** Number of workers to spawn. Defaults to `navigator.hardwareConcurrency` or 4. */
  size?: number;
  /** Default timeout in milliseconds for every call. 0 or undefined means no timeout. */
  timeout?: number;
}

export type Pool<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: UnwrapTransferArgs<A>) => CancellablePromise<Awaited<R>>
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

export function pool<T>(
  factory: () => Worker,
  options: PoolOptions = {},
): Pool<T> {
  const size =
    options.size ??
    (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) ??
    4;

  const workers: Worker[] = [];
  const proxies: Promisified<T>[] = [];
  const pending = new Map<Promisified<T>, number>();

  for (let i = 0; i < size; i++) {
    const w = factory();
    workers.push(w);
    const wrapOpts: WrapOptions = {};
    if (options.timeout) wrapOpts.timeout = options.timeout;
    const p = wrap<T>(w, wrapOpts);
    proxies.push(p);
    pending.set(p, 0);
  }

  let terminated = false;
  let robin = 0;

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
            pending.set(target, (pending.get(target) ?? 1) - 1);
          })
          .catch(() => {});
        return result;
      };
    },
  });
}
