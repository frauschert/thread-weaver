import {
  type Transfer,
  type UnwrapTransfer,
  type UnwrapTransferArgs,
  type UnwrapReturn,
  isTransfer,
  transfer,
} from "./transfer";
import { AsyncQueue } from "./queue";

export type {
  Transfer,
  UnwrapTransfer,
  UnwrapTransferArgs,
  UnwrapReturn,
} from "./transfer";
export { transfer };

/** Collect transferables from a list of args (any arg may be a Transfer wrapper). */
function extractTransferables(args: any[]): {
  rawArgs: any[];
  transferables: Transferable[];
} {
  const transferables: Transferable[] = [];
  const rawArgs = args.map((a) => {
    if (isTransfer(a)) {
      transferables.push(...a.transferables);
      return a.value;
    }
    return a;
  });
  return { rawArgs, transferables };
}

export interface WrapOptions {
  /** Default timeout in milliseconds for every call. 0 or undefined means no timeout. */
  timeout?: number;
}

export interface CancellablePromise<T> extends Promise<T> {
  /** Abort this call. Rejects with an AbortError. */
  abort(reason?: string): void;
  /** Override the default timeout for this call. 0 disables. Returns `this` for chaining. */
  timeout(ms: number): CancellablePromise<T>;
  /** Wire an AbortSignal to this call. Returns `this` for chaining. */
  signal(signal: AbortSignal): CancellablePromise<T>;
}

export type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: UnwrapTransferArgs<A>) => CancellablePromise<UnwrapReturn<R>>
    : never;
} & { dispose(): void; [Symbol.dispose](): void };

export function wrap<T>(
  worker: Worker,
  options: WrapOptions = {},
): Promisified<T> {
  const defaultTimeout = options.timeout ?? 0;
  let nextId = 0;
  let disposed = false;
  type Callback = {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  const callbacks = new Map<number, Callback>();
  const streams = new Map<number, AsyncQueue<any>>();

  function rejectAll(reason: string) {
    for (const [id, cb] of callbacks) {
      if (cb.timer) clearTimeout(cb.timer);
      cb.reject(new Error(reason));
    }
    callbacks.clear();
    for (const [id, queue] of streams) {
      queue.error(new Error(reason));
      worker.postMessage({ id, type: "cancel" });
    }
    streams.clear();
  }

  function deserializeError(err: unknown): Error {
    if (typeof err === "object" && err !== null && "message" in err) {
      const { message, name, stack } = err as {
        message: string;
        name?: string;
        stack?: string;
      };
      const error = new Error(message);
      if (name) error.name = name;
      if (stack) error.stack = stack;
      return error;
    }
    return new Error(String(err));
  }

  function onMessage(event: MessageEvent) {
    const { id, result, error, type, value } = event.data;

    // Streaming messages
    if (type === "next") {
      const callback = callbacks.get(id);
      let queue = streams.get(id);
      if (!queue) {
        queue = new AsyncQueue();
        queue.onReturn = () => {
          streams.delete(id);
          worker.postMessage({ id, type: "cancel" });
        };
        streams.set(id, queue);
        // Resolve the call's promise with the iterable on first 'next'
        if (callback) {
          if (callback.timer) clearTimeout(callback.timer);
          callbacks.delete(id);
          callback.resolve(queue);
        }
      }
      queue.push(value);
      return;
    }
    if (type === "done") {
      const queue = streams.get(id);
      if (queue) {
        queue.done();
        streams.delete(id);
      }
      return;
    }
    if (type === "error") {
      const queue = streams.get(id);
      if (queue) {
        queue.error(deserializeError(error));
        streams.delete(id);
      } else {
        // Stream errored before first 'next' — reject the call promise
        const callback = callbacks.get(id);
        if (callback) {
          if (callback.timer) clearTimeout(callback.timer);
          callbacks.delete(id);
          callback.reject(deserializeError(error));
        }
      }
      return;
    }

    // Regular single-value response
    const callback = callbacks.get(id);
    if (!callback) return;
    if (callback.timer) clearTimeout(callback.timer);
    callbacks.delete(id);

    if (error) {
      callback.reject(deserializeError(error));
    } else {
      callback.resolve(result);
    }
  }

  function onError(event: ErrorEvent) {
    rejectAll(event.message || "Worker error");
  }

  function onMessageError() {
    rejectAll("Worker message could not be deserialized");
  }

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onMessageError);

  return new Proxy({} as Promisified<T>, {
    get(_, prop: string | symbol) {
      // Prevent accidental `await proxy` — make the proxy non-thenable
      if (prop === "then") return undefined;

      if (prop === "dispose" || prop === Symbol.dispose) {
        return () => {
          if (disposed) return;
          disposed = true;
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.removeEventListener("messageerror", onMessageError);
          rejectAll("Worker proxy disposed");
        };
      }

      return (...args: any[]) => {
        if (disposed) {
          return Promise.reject(new Error("Worker proxy has been disposed"));
        }
        const method = prop as string;
        const id = nextId++;
        const { rawArgs, transferables } = extractTransferables(args);

        let entry: Callback;

        function abortCall(reason?: string) {
          const cb = callbacks.get(id);
          const queue = streams.get(id);
          if (!cb && !queue) return;
          if (cb) {
            if (cb.timer) clearTimeout(cb.timer);
            callbacks.delete(id);
          }
          const msg = reason ?? "Aborted";
          const err =
            typeof DOMException !== "undefined"
              ? new DOMException(msg, "AbortError")
              : Object.assign(new Error(msg), { name: "AbortError" });
          if (queue) {
            queue.error(err);
            streams.delete(id);
          } else if (cb) {
            cb.reject(err);
          }
          // Notify worker to stop the stream
          worker.postMessage({ id, type: "cancel" });
        }

        function setTimer(ms: number, methodName: string) {
          const cb = callbacks.get(id);
          if (!cb) return;
          if (cb.timer) clearTimeout(cb.timer);
          if (ms > 0) {
            cb.timer = setTimeout(() => {
              if (callbacks.delete(id)) {
                cb.reject(
                  new Error(
                    `Worker call "${methodName}" timed out after ${ms}ms`,
                  ),
                );
                worker.postMessage({ id, type: "cancel" });
              }
            }, ms);
          } else {
            cb.timer = undefined;
          }
        }

        const promise = new Promise((resolve, reject) => {
          entry = { resolve, reject };

          if (defaultTimeout > 0) {
            entry.timer = setTimeout(() => {
              if (callbacks.delete(id)) {
                reject(
                  new Error(
                    `Worker call "${method}" timed out after ${defaultTimeout}ms`,
                  ),
                );
                worker.postMessage({ id, type: "cancel" });
              }
            }, defaultTimeout);
          }

          callbacks.set(id, entry);
          worker.postMessage({ id, method, args: rawArgs }, transferables);
        }) as CancellablePromise<any>;

        promise.abort = abortCall;

        promise.timeout = (ms: number) => {
          setTimer(ms, method);
          return promise;
        };

        promise.signal = (sig: AbortSignal) => {
          if (sig.aborted) {
            abortCall(sig.reason?.toString());
            return promise;
          }
          const onAbort = () => abortCall(sig.reason?.toString());
          sig.addEventListener("abort", onAbort, { once: true });
          promise.then(
            () => sig.removeEventListener("abort", onAbort),
            () => sig.removeEventListener("abort", onAbort),
          );
          return promise;
        };

        return promise;
      };
    },
  });
}
