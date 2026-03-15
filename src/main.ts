import {
  type RemoteObject,
  type UnwrapTransferArgs,
  type UnwrapReturn,
  isTransfer,
  isProxy,
  collectTransferables,
  transfer,
  proxy,
} from "./transfer";
import { AsyncQueue } from "./queue";
import { TimeoutError, AbortError, WorkerCrashedError } from "./errors";
import {
  resolveCompression,
  compressMessage,
  isCompressed,
  decompressMessage,
} from "./compression";

export { TimeoutError, AbortError, WorkerCrashedError } from "./errors";

export type {
  Transfer,
  ProxyMarker,
  RemoteObject,
  RemoteEmitter,
  UnwrapTransfer,
  UnwrapTransferArgs,
  UnwrapReturn,
} from "./transfer";
export { transfer, proxy };

/** Collect transferables from a list of args.
 *  - Explicit Transfer wrappers are unwrapped.
 *  - Other args are scanned for ArrayBuffer, MessagePort, etc.
 */
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
  // Auto-detect transferables in non-Transfer args
  for (const a of rawArgs) {
    for (const t of collectTransferables(a)) {
      if (!transferables.includes(t)) transferables.push(t);
    }
  }
  return { rawArgs, transferables };
}

/**
 * Minimal interface shared by Worker, MessagePort, and similar objects.
 * Anything with postMessage + addEventListener + removeEventListener works.
 */
export interface MessageEndpoint {
  postMessage(message: any, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  start?: () => void;
}

export interface WrapOptions {
  /** Default timeout in milliseconds for every call. 0 or undefined means no timeout. */
  timeout?: number;
  /** Enable gzip compression for large outgoing messages. */
  compression?: boolean | { threshold?: number };
}

export interface CancellablePromise<T> extends Promise<T> {
  /** Abort this call. Rejects with an AbortError. */
  abort(reason?: string): void;
  /** Override the default timeout for this call. 0 disables. Returns `this` for chaining. */
  timeout(ms: number): CancellablePromise<T>;
  /** Wire an AbortSignal to this call. Returns `this` for chaining. */
  signal(signal: AbortSignal): CancellablePromise<T>;
}

/**
 * Constraint that ensures every property of `T` is a function.
 * Used by `wrap<T>()`, `pool<T>()`, and `expose()` to reject
 * non-function properties at compile time.
 */
export type FunctionsOnly<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? T[K] : never;
};

/**
 * Mapped type that promisifies every method of `T`, returning
 * {@link CancellablePromise} for each call.
 *
 * **Generic methods:** TypeScript erases generic type parameters when they pass
 * through conditional mapped types (`infer`). Unconstrained generics become
 * `unknown`; constrained generics keep their constraint (e.g.
 * `<T extends string>` preserves `string`). To restore generic signatures, pass
 * manual overrides as the second type parameter:
 *
 * ```ts
 * type Api = { identity<T>(x: T): T; add(a: number, b: number): number };
 * type P = Promisified<Api, { identity<T>(x: T): CancellablePromise<T> }>;
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Promisified<T, Overrides = {}> = {
  [K in keyof T as T[K] extends (...args: any[]) => any
    ? K extends keyof Overrides
      ? never
      : K
    : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: UnwrapTransferArgs<A>) => CancellablePromise<UnwrapReturn<R>>
    : never;
} & Overrides & { dispose(): void; [Symbol.dispose](): void };

/**
 * Wrap a Worker or MessagePort, returning a typed proxy where every method call is
 * transparently sent via `postMessage` and returned as a `CancellablePromise`.
 *
 * Accepts a dedicated `Worker`, a `MessagePort` (e.g. from a `SharedWorker`),
 * or any object that implements the {@link MessageEndpoint} interface.
 *
 * @param endpoint The Worker, MessagePort, or MessageEndpoint to wrap.
 * @param options Configuration options (e.g. default timeout).
 * @returns A proxied object whose methods mirror `T` but return promises.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function wrap<T extends FunctionsOnly<T>, Overrides = {}>(
  endpoint: MessageEndpoint,
  options: WrapOptions = {},
): Promisified<T, Overrides> {
  const defaultTimeout = options.timeout ?? 0;
  const compression = resolveCompression(options.compression);
  let nextId = 0;
  let disposed = false;
  type Callback = {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer?: ReturnType<typeof setTimeout>;
    effectiveTimeout: number;
    method: string;
  };
  type StreamEntry = {
    queue: AsyncQueue<any>;
    idleTimer?: ReturnType<typeof setTimeout>;
    idleTimeout: number;
    method: string;
  };
  const callbacks = new Map<number, Callback>();
  const streams = new Map<number, StreamEntry>();

  // Proxy callback state for bidirectional communication
  let nextCallbackId = 0;
  const proxyCallbacks = new Map<number, (...args: any[]) => any>();
  const proxyEventListeners = new Map<
    number,
    Map<string, Set<(data: any) => void>>
  >();
  const callProxyIds = new Map<number, number[]>();

  function cleanupCallProxies(callId: number) {
    const ids = callProxyIds.get(callId);
    if (ids) {
      for (const cbId of ids) proxyCallbacks.delete(cbId);
      callProxyIds.delete(callId);
    }
  }

  async function send(
    msg: any,
    transferables: Transferable[] = [],
  ): Promise<void> {
    if (compression && transferables.length === 0) {
      const { data, transfer: t } = await compressMessage(msg, compression);
      endpoint.postMessage(data, t ?? []);
    } else {
      endpoint.postMessage(msg, transferables);
    }
  }

  function resetIdleTimer(id: number, entry: StreamEntry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.idleTimeout > 0) {
      entry.idleTimer = setTimeout(() => {
        if (!streams.has(id)) return;
        entry.queue.error(
          new TimeoutError(
            `Worker stream "${entry.method}" timed out after ${entry.idleTimeout}ms of inactivity`,
            entry.method,
            entry.idleTimeout,
          ),
        );
        streams.delete(id);
        send({ id, type: "cancel" });
      }, entry.idleTimeout);
    }
  }

  function rejectAll(reason: string) {
    const err = new WorkerCrashedError(reason);
    for (const [, cb] of callbacks) {
      if (cb.timer) clearTimeout(cb.timer);
      cb.reject(err);
    }
    callbacks.clear();
    for (const [id, s] of streams) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.queue.error(err);
      send({ id, type: "cancel" });
    }
    streams.clear();
    proxyCallbacks.clear();
    callProxyIds.clear();
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

  function isProxyReturn(v: unknown): v is { __twProxyReturn: number } {
    return (
      v !== null &&
      typeof v === "object" &&
      "__twProxyReturn" in (v as Record<string, unknown>)
    );
  }

  function createRemoteProxy(proxyId: number): RemoteObject<any> {
    let released = false;
    return new Proxy({} as RemoteObject<any>, {
      get(_, prop: string | symbol) {
        if (prop === "then") return undefined;

        if (prop === "release" || prop === Symbol.dispose) {
          return () => {
            if (released) return;
            released = true;
            proxyEventListeners.delete(proxyId);
            send({ type: "proxy-release", proxyId });
          };
        }

        if (prop === "on") {
          return (event: string, handler: (data: any) => void) => {
            let eventMap = proxyEventListeners.get(proxyId);
            if (!eventMap) {
              eventMap = new Map();
              proxyEventListeners.set(proxyId, eventMap);
            }
            let handlers = eventMap.get(event);
            if (!handlers) {
              handlers = new Set();
              eventMap.set(event, handlers);
            }
            handlers.add(handler);
            return () => {
              handlers!.delete(handler);
              if (handlers!.size === 0) eventMap!.delete(event);
              if (eventMap!.size === 0) proxyEventListeners.delete(proxyId);
            };
          };
        }

        return (...args: any[]) => {
          if (released) {
            return Promise.reject(
              new AbortError("Remote proxy has been released"),
            );
          }
          const callId = nextId++;
          const { rawArgs, transferables } = extractTransferables(args);

          let entry: Callback;
          const promise = new Promise((resolve, reject) => {
            entry = {
              resolve,
              reject,
              effectiveTimeout: defaultTimeout,
              method: prop as string,
            };

            if (defaultTimeout > 0) {
              entry.timer = setTimeout(() => {
                if (callbacks.delete(callId)) {
                  reject(
                    new TimeoutError(
                      `Proxy call "${prop as string}" timed out after ${defaultTimeout}ms`,
                      prop as string,
                      defaultTimeout,
                    ),
                  );
                }
              }, defaultTimeout);
            }

            callbacks.set(callId, entry);
            send(
              {
                id: callId,
                type: "proxy-call",
                proxyId,
                method: prop as string,
                args: rawArgs,
              },
              transferables,
            );
          }) as CancellablePromise<any>;

          promise.abort = (reason?: string) => {
            const cb = callbacks.get(callId);
            if (!cb) return;
            if (cb.timer) clearTimeout(cb.timer);
            callbacks.delete(callId);
            cb.reject(new AbortError(reason ?? "Aborted"));
          };

          promise.timeout = (ms: number) => {
            const cb = callbacks.get(callId);
            if (cb) {
              cb.effectiveTimeout = ms;
              if (cb.timer) clearTimeout(cb.timer);
              if (ms > 0) {
                cb.timer = setTimeout(() => {
                  if (callbacks.delete(callId)) {
                    cb.reject(
                      new TimeoutError(
                        `Proxy call "${prop as string}" timed out after ${ms}ms`,
                        prop as string,
                        ms,
                      ),
                    );
                  }
                }, ms);
              } else {
                cb.timer = undefined;
              }
            }
            return promise;
          };

          promise.signal = (sig: AbortSignal) => {
            if (sig.aborted) {
              promise.abort(sig.reason?.toString());
              return promise;
            }
            const onAbort = () => promise.abort(sig.reason?.toString());
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

  /** Resolve a result, creating a remote proxy if the value is a proxy-return marker. */
  function resolveResult(value: unknown): unknown {
    return isProxyReturn(value)
      ? createRemoteProxy(value.__twProxyReturn)
      : value;
  }

  async function onMessage(event: MessageEvent) {
    const msg = isCompressed(event.data)
      ? await decompressMessage(event.data)
      : event.data;
    const { id, result, error, type, value } = msg;

    // Handle proxy callback invocations from the worker
    if (type === "callback") {
      const { callbackId, cbSeq, args: cbArgs } = msg;
      const fn = proxyCallbacks.get(callbackId);
      if (fn) {
        Promise.resolve()
          .then(() => fn(...(cbArgs ?? [])))
          .then((cbResult) => {
            send({
              type: "callback-result",
              callbackId,
              cbSeq,
              result: cbResult,
            });
          })
          .catch((err: unknown) => {
            const cbError =
              err instanceof Error
                ? { message: err.message, name: err.name, stack: err.stack }
                : { message: String(err) };
            send({
              type: "callback-result",
              callbackId,
              cbSeq,
              error: cbError,
            });
          });
      }
      return;
    }

    // Handle proxy events from worker-side emitters
    if (type === "proxy-event") {
      const { proxyId, event: eventName, data: eventData } = msg;
      const listeners = proxyEventListeners.get(proxyId)?.get(eventName);
      if (listeners) {
        for (const handler of listeners) handler(eventData);
      }
      return;
    }

    // Streaming messages
    if (type === "next") {
      const callback = callbacks.get(id);
      let s = streams.get(id);
      if (!s) {
        const queue = new AsyncQueue();
        const idleTimeout = callback?.effectiveTimeout ?? defaultTimeout;
        const methodName = callback?.method ?? "";
        s = { queue, idleTimeout, method: methodName };
        queue.onReturn = () => {
          if (s!.idleTimer) clearTimeout(s!.idleTimer);
          streams.delete(id);
          cleanupCallProxies(id);
          send({ id, type: "cancel" });
        };
        streams.set(id, s);
        if (callback) {
          if (callback.timer) clearTimeout(callback.timer);
          callbacks.delete(id);
          callback.resolve(queue);
        }
      }
      s.queue.push(value);
      resetIdleTimer(id, s);
      return;
    }
    if (type === "done") {
      const s = streams.get(id);
      if (s) {
        if (s.idleTimer) clearTimeout(s.idleTimer);
        s.queue.done();
        streams.delete(id);
        cleanupCallProxies(id);
      } else {
        // 'done' arrived before any 'next' — empty stream
        const callback = callbacks.get(id);
        if (callback) {
          if (callback.timer) clearTimeout(callback.timer);
          callbacks.delete(id);
          cleanupCallProxies(id);
          const queue = new AsyncQueue();
          queue.done();
          callback.resolve(queue);
        }
      }
      return;
    }
    if (type === "error") {
      const s = streams.get(id);
      if (s) {
        if (s.idleTimer) clearTimeout(s.idleTimer);
        s.queue.error(deserializeError(error));
        streams.delete(id);
        cleanupCallProxies(id);
      } else {
        // Stream errored before first 'next' — reject the call promise
        const callback = callbacks.get(id);
        if (callback) {
          if (callback.timer) clearTimeout(callback.timer);
          callbacks.delete(id);
          cleanupCallProxies(id);
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
    cleanupCallProxies(id);

    if (error) {
      callback.reject(deserializeError(error));
    } else {
      callback.resolve(resolveResult(result));
    }
  }

  function onError(event: ErrorEvent) {
    rejectAll(event.message || "Worker error");
  }

  function onMessageError() {
    rejectAll("Worker message could not be deserialized");
  }

  endpoint.addEventListener("message", onMessage);
  endpoint.addEventListener("error", onError);
  endpoint.addEventListener("messageerror", onMessageError);

  // MessagePort requires start() to begin receiving events
  endpoint.start?.();

  return new Proxy({} as Promisified<T, Overrides>, {
    get(_, prop: string | symbol) {
      // Prevent accidental `await proxy` — make the proxy non-thenable
      if (prop === "then") return undefined;

      if (prop === "dispose" || prop === Symbol.dispose) {
        return () => {
          if (disposed) return;
          disposed = true;
          endpoint.removeEventListener("message", onMessage);
          endpoint.removeEventListener("error", onError);
          endpoint.removeEventListener("messageerror", onMessageError);
          rejectAll("Worker proxy disposed");
        };
      }

      return (...args: any[]) => {
        if (disposed) {
          return Promise.reject(
            new AbortError("Worker proxy has been disposed"),
          );
        }
        const method = prop as string;
        const id = nextId++;

        // Extract proxy callbacks from args (replace with serializable markers).
        // Both explicit proxy(fn) wrappers and bare function args are auto-proxied.
        const proxyIds: number[] = [];
        const processedArgs = args.map((a) => {
          if (isProxy(a)) {
            const cbId = nextCallbackId++;
            proxyCallbacks.set(cbId, a.value as (...args: any[]) => any);
            proxyIds.push(cbId);
            return { __twProxy: cbId };
          }
          if (typeof a === "function") {
            const cbId = nextCallbackId++;
            proxyCallbacks.set(cbId, a);
            proxyIds.push(cbId);
            return { __twProxy: cbId };
          }
          return a;
        });
        if (proxyIds.length > 0) {
          callProxyIds.set(id, proxyIds);
        }

        const { rawArgs, transferables } = extractTransferables(processedArgs);

        let entry: Callback;

        function abortCall(reason?: string) {
          const cb = callbacks.get(id);
          const s = streams.get(id);
          if (!cb && !s) return;
          if (cb) {
            if (cb.timer) clearTimeout(cb.timer);
            callbacks.delete(id);
          }
          const msg = reason ?? "Aborted";
          const err = new AbortError(msg);
          if (s) {
            if (s.idleTimer) clearTimeout(s.idleTimer);
            s.queue.error(err);
            streams.delete(id);
          } else if (cb) {
            cb.reject(err);
          }
          // Notify worker to stop the stream
          send({ id, type: "cancel" });
          cleanupCallProxies(id);
        }

        function setTimer(ms: number, methodName: string) {
          const cb = callbacks.get(id);
          if (!cb) return;
          if (cb.timer) clearTimeout(cb.timer);
          if (ms > 0) {
            cb.timer = setTimeout(() => {
              if (callbacks.delete(id)) {
                cb.reject(
                  new TimeoutError(
                    `Worker call "${methodName}" timed out after ${ms}ms`,
                    methodName,
                    ms,
                  ),
                );
                send({ id, type: "cancel" });
                cleanupCallProxies(id);
              }
            }, ms);
          } else {
            cb.timer = undefined;
          }
        }

        const promise = new Promise((resolve, reject) => {
          entry = { resolve, reject, effectiveTimeout: defaultTimeout, method };

          if (defaultTimeout > 0) {
            entry.timer = setTimeout(() => {
              if (callbacks.delete(id)) {
                reject(
                  new TimeoutError(
                    `Worker call "${method}" timed out after ${defaultTimeout}ms`,
                    method,
                    defaultTimeout,
                  ),
                );
                send({ id, type: "cancel" });
                cleanupCallProxies(id);
              }
            }, defaultTimeout);
          }

          callbacks.set(id, entry);
          send({ id, method, args: rawArgs }, transferables).catch((err) => {
            if (entry.timer) clearTimeout(entry.timer);
            callbacks.delete(id);
            reject(err);
          });
        }) as CancellablePromise<any>;

        promise.abort = abortCall;

        promise.timeout = (ms: number) => {
          const cb = callbacks.get(id);
          if (cb) cb.effectiveTimeout = ms;
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
