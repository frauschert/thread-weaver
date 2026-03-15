import {
  isTransfer,
  isProxy,
  collectTransferables,
  isEmitterHandle,
  getEmitterInternal,
  markAsEmitter,
} from "./transfer";
import type { FunctionsOnly, MessageEndpoint } from "./main";
import type { EmitterHandle, EmitterInternal } from "./transfer";
import {
  resolveCompression,
  compressMessage,
  isCompressed,
  decompressMessage,
} from "./compression";

export { transfer, proxy } from "./transfer";
export type { Transfer } from "./transfer";

export interface ExposeOptions {
  /** Enable gzip compression for large outgoing messages. */
  compression?: boolean | { threshold?: number };
}

function serializeError(error: unknown): {
  message: string;
  name?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error) };
}

/** Check if a value is a non-null, non-array object with at least one own function property. */
function hasOwnFunctions(
  v: unknown,
): v is Record<string, (...args: any[]) => any> {
  return (
    v != null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).some(
      (k) => typeof (v as Record<string, unknown>)[k] === "function",
    )
  );
}

let exposed = false;

/**
 * Create an event emitter for pushing events from a worker-side object
 * to the main thread.
 *
 * @returns `{ emit, handle }` — call `handle(obj)` to brand an object,
 * then `emit(event, data)` to push events once connected.
 *
 * @example
 * ```ts
 * const { emit, handle } = emitter<{ tick: number }>();
 * return handle({
 *   start() { setInterval(() => emit("tick", Date.now()), 100); },
 * });
 * ```
 */
export function emitter<E extends Record<string, any>>() {
  let send: ((event: string, data: any) => void) | null = null;
  const queued: Array<[string, any]> = [];

  const internal: EmitterInternal = {
    _connect(proxyId, postFn) {
      send = (event, data) => {
        const t = collectTransferables(data);
        postFn({ type: "proxy-event", proxyId, event, data }, t);
      };
      for (const [e, d] of queued) send(e, d);
      queued.length = 0;
    },
    _disconnect() {
      send = null;
    },
  };

  function emit<K extends keyof E & string>(event: K, data: E[K]): void {
    if (send) {
      send(event, data);
    } else {
      queued.push([event, data]);
    }
  }

  function handle<T extends Record<string, (...args: any[]) => any>>(
    obj: T,
  ): EmitterHandle<T, E> {
    markAsEmitter(obj, internal);
    return obj as EmitterHandle<T, E>;
  }

  return { emit, handle };
}

/**
 * Expose an API object to the main thread. Call once per worker.
 * Each method receives an `AbortSignal` as a trailing argument for cooperative cancellation.
 * Async generator methods are automatically streamed as `AsyncIterableIterator`.
 *
 * @param api Object mapping method names to functions.
 * @param endpoint Optional MessagePort or MessageEndpoint to listen on. Defaults to `self` (the global worker scope).
 */
export function expose<T extends FunctionsOnly<T>>(
  api: T & Record<string, (...args: any[]) => any>,
  endpoint?: MessageEndpoint,
  options?: ExposeOptions,
) {
  if (!endpoint && exposed) {
    throw new Error("expose() can only be called once per worker");
  }
  if (!endpoint) exposed = true;

  const ep: MessageEndpoint = endpoint ?? (self as any);
  const compression = resolveCompression(options?.compression);
  const activeStreams = new Map<number, { cancel(): void }>();
  const activeAborts = new Map<number, AbortController>();

  async function send(
    msg: any,
    transferables: Transferable[] = [],
  ): Promise<void> {
    if (compression && transferables.length === 0) {
      const { data, transfer } = await compressMessage(msg, compression);
      if (transfer) {
        ep.postMessage(data, transfer);
      } else {
        ep.postMessage(data);
      }
    } else if (transferables.length > 0) {
      ep.postMessage(msg, transferables);
    } else {
      ep.postMessage(msg);
    }
  }

  // For proxy callback support: awaiting callback results from the main thread
  const pendingCallbacks = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  let nextCbSeq = 0;

  // For return-proxy support: long-lived objects the main thread can call methods on
  const proxyRegistry = new Map<
    number,
    Record<string, (...args: any[]) => any>
  >();
  let nextProxyId = 0;

  ep.addEventListener("message", async (event: MessageEvent) => {
    const msg = isCompressed(event.data)
      ? await decompressMessage(event.data)
      : event.data;
    const { id, method, args, type } = msg;

    // Handle callback results from the main thread
    if (type === "callback-result") {
      const { cbSeq, result: cbResult, error: cbError } = msg;
      const pending = pendingCallbacks.get(cbSeq);
      if (pending) {
        pendingCallbacks.delete(cbSeq);
        if (cbError) {
          const err = new Error(cbError.message);
          if (cbError.name) err.name = cbError.name;
          if (cbError.stack) err.stack = cbError.stack;
          pending.reject(err);
        } else {
          pending.resolve(cbResult);
        }
      }
      return;
    }

    // Handle stream cancellation from main thread
    if (type === "cancel") {
      const stream = activeStreams.get(id);
      if (stream) {
        stream.cancel();
        activeStreams.delete(id);
      }
      const controller = activeAborts.get(id);
      if (controller) {
        controller.abort();
        activeAborts.delete(id);
      }
      return;
    }

    // Handle method calls on proxied return objects
    if (type === "proxy-call") {
      const { proxyId, method: proxyMethod, args: proxyArgs } = msg;
      const obj = proxyRegistry.get(proxyId);
      if (!obj || typeof obj[proxyMethod] !== "function") {
        await send({
          id,
          error: serializeError(
            new Error(
              obj
                ? `Unknown method "${proxyMethod}" on proxied object`
                : `Proxy ${proxyId} not found`,
            ),
          ),
        });
        return;
      }
      try {
        const raw = await obj[proxyMethod](...(proxyArgs ?? []));
        if (isTransfer(raw)) {
          await send({ id, result: raw.value }, raw.transferables);
        } else if (isProxy(raw)) {
          const nestedId = nextProxyId++;
          proxyRegistry.set(
            nestedId,
            raw.value as Record<string, (...args: any[]) => any>,
          );
          if (isEmitterHandle(raw.value))
            getEmitterInternal(raw.value)._connect(nestedId, (m, t) => {
              send(m, t);
            });
          await send({ id, result: { __twProxyReturn: nestedId } });
        } else if (hasOwnFunctions(raw)) {
          const nestedId = nextProxyId++;
          proxyRegistry.set(nestedId, raw);
          if (isEmitterHandle(raw))
            getEmitterInternal(raw)._connect(nestedId, (m, t) => {
              send(m, t);
            });
          await send({ id, result: { __twProxyReturn: nestedId } });
        } else {
          const t = collectTransferables(raw);
          await send({ id, result: raw }, t);
        }
      } catch (error) {
        await send({ id, error: serializeError(error) });
      }
      return;
    }

    // Handle proxy release from main thread
    if (type === "proxy-release") {
      const { proxyId } = msg;
      const obj = proxyRegistry.get(proxyId);
      if (obj && isEmitterHandle(obj)) {
        getEmitterInternal(obj)._disconnect();
      }
      proxyRegistry.delete(proxyId);
      return;
    }

    if (!Object.hasOwn(api, method) || typeof api[method] !== "function") {
      await send({
        id,
        error: serializeError(new Error(`Unknown method: ${String(method)}`)),
      });
      return;
    }

    try {
      const controller = new AbortController();
      activeAborts.set(id, controller);

      // Hydrate proxy markers in args into callable stubs
      const hydratedArgs = (args as any[]).map((a: any) => {
        if (a != null && typeof a === "object" && "__twProxy" in a) {
          const callbackId = a.__twProxy as number;
          return (...cbArgs: any[]) => {
            return new Promise<any>((resolve, reject) => {
              const cbSeq = nextCbSeq++;
              pendingCallbacks.set(cbSeq, { resolve, reject });
              send({
                type: "callback",
                callbackId,
                cbSeq,
                args: cbArgs,
              });
            });
          };
        }
        return a;
      });

      const raw = await api[method](...hydratedArgs, controller.signal);

      // Check for async iterable (async generators)
      if (
        raw != null &&
        typeof raw === "object" &&
        Symbol.asyncIterator in raw
      ) {
        let cancelled = false;
        activeStreams.set(id, {
          cancel() {
            cancelled = true;
          },
        });

        try {
          for await (const value of raw) {
            if (cancelled) break;
            if (isTransfer(value)) {
              await send(
                { id, type: "next", value: value.value },
                value.transferables,
              );
            } else {
              const t = collectTransferables(value);
              await send({ id, type: "next", value }, t);
            }
          }
          if (!cancelled) {
            await send({ id, type: "done" });
          }
        } catch (error) {
          if (!cancelled) {
            await send({
              id,
              type: "error",
              error: serializeError(error),
            });
          }
        } finally {
          activeStreams.delete(id);
          activeAborts.delete(id);
        }
        return;
      }

      if (isTransfer(raw)) {
        await send({ id, result: raw.value }, raw.transferables);
      } else if (isProxy(raw)) {
        const proxyId = nextProxyId++;
        proxyRegistry.set(
          proxyId,
          raw.value as Record<string, (...args: any[]) => any>,
        );
        if (isEmitterHandle(raw.value))
          getEmitterInternal(raw.value)._connect(proxyId, (m, t) => {
            send(m, t);
          });
        await send({ id, result: { __twProxyReturn: proxyId } });
      } else if (hasOwnFunctions(raw)) {
        const proxyId = nextProxyId++;
        proxyRegistry.set(proxyId, raw);
        if (isEmitterHandle(raw))
          getEmitterInternal(raw)._connect(proxyId, (m, t) => {
            send(m, t);
          });
        await send({ id, result: { __twProxyReturn: proxyId } });
      } else {
        const t = collectTransferables(raw);
        await send({ id, result: raw }, t);
      }
      activeAborts.delete(id);
    } catch (error) {
      activeAborts.delete(id);
      await send({ id, error: serializeError(error) });
    }
  });

  // MessagePort requires start() to begin receiving events
  ep.start?.();
}
