/**
 * Module Worker detection utilities.
 *
 * Provides runtime detection of `{ type: "module" }` support in the Worker
 * constructor and a convenience factory that falls back to classic workers
 * automatically.
 */

let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;

/**
 * Detect whether the current environment supports module workers
 * (`new Worker(url, { type: "module" })`).
 *
 * The result is cached after the first call.
 *
 * @returns A promise that resolves to `true` if module workers are supported.
 *
 * @example
 * ```ts
 * if (await supportsModuleWorker()) {
 *   console.log("Module workers are supported!");
 * }
 * ```
 */
export function supportsModuleWorker(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (pending) return pending;

  if (typeof Worker === "undefined") {
    cached = false;
    return Promise.resolve(false);
  }

  pending = new Promise<boolean>((resolve) => {
    try {
      // Use ES module syntax (`export {}`) so classic mode will fail to parse it.
      const blob = new Blob(["export {};self.postMessage(0)"], {
        type: "text/javascript",
      });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url, { type: "module" });

      const cleanup = () => {
        w.terminate();
        URL.revokeObjectURL(url);
      };

      const timer = setTimeout(() => {
        if (cached === null) {
          cached = false;
          cleanup();
          resolve(false);
        }
      }, 2_000);

      w.addEventListener("message", () => {
        cached = true;
        clearTimeout(timer);
        cleanup();
        resolve(true);
      });

      w.addEventListener("error", () => {
        cached = false;
        clearTimeout(timer);
        cleanup();
        resolve(false);
      });
    } catch {
      // Constructor threw — unsupported
      cached = false;
      resolve(false);
    }
  });

  return pending;
}

/**
 * Reset the cached detection result. Useful for testing.
 * @internal
 */
export function _resetModuleWorkerCache(): void {
  cached = null;
  pending = null;
}

export interface CreateWorkerOptions extends Omit<WorkerOptions, "type"> {
  /**
   * Fallback URL to use when module workers are not supported.
   * If omitted the primary `url` is used for both module and classic modes.
   */
  fallbackUrl?: string | URL;
}

/**
 * Create a Worker with automatic module detection.
 *
 * When the browser supports `{ type: "module" }`, the worker is created as
 * a module worker. Otherwise it falls back to a classic worker, optionally
 * loading from a different URL (`fallbackUrl`).
 *
 * @param url        URL of the module worker script.
 * @param options    Worker options (except `type`, which is auto-detected).
 *                   Pass `fallbackUrl` to use a different script for classic mode.
 * @returns A promise that resolves to the created Worker.
 *
 * @example
 * ```ts
 * import { createWorker, wrap } from "thread-weaver";
 *
 * const worker = await createWorker(
 *   new URL("./my.worker.ts", import.meta.url),
 * );
 * const api = wrap<MyApi>(worker);
 * ```
 *
 * @example
 * ```ts
 * // With a classic fallback bundle:
 * const worker = await createWorker(
 *   new URL("./my.worker.mjs", import.meta.url),
 *   { fallbackUrl: new URL("./my.worker.iife.js", import.meta.url) },
 * );
 * ```
 */
export async function createWorker(
  url: string | URL,
  options?: CreateWorkerOptions,
): Promise<Worker> {
  const { fallbackUrl, ...workerOptions } = options ?? {};
  const moduleSupported = await supportsModuleWorker();

  if (moduleSupported) {
    return new Worker(url, { ...workerOptions, type: "module" });
  }

  return new Worker(fallbackUrl ?? url, { ...workerOptions, type: "classic" });
}
