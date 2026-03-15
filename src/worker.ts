import { isTransfer, isProxy, collectTransferables } from "./transfer";
import type { FunctionsOnly, MessageEndpoint } from "./main";

export { transfer } from "./transfer";
export type { Transfer } from "./transfer";

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
) {
  if (!endpoint && exposed) {
    throw new Error("expose() can only be called once per worker");
  }
  if (!endpoint) exposed = true;

  const ep: MessageEndpoint = endpoint ?? (self as any);
  const activeStreams = new Map<number, { cancel(): void }>();
  const activeAborts = new Map<number, AbortController>();

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
    const { id, method, args, type } = event.data;

    // Handle callback results from the main thread
    if (type === "callback-result") {
      const { cbSeq, result: cbResult, error: cbError } = event.data;
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
      const { proxyId, method: proxyMethod, args: proxyArgs } = event.data;
      const obj = proxyRegistry.get(proxyId);
      if (!obj || typeof obj[proxyMethod] !== "function") {
        ep.postMessage({
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
          ep.postMessage({ id, result: raw.value }, raw.transferables);
        } else if (isProxy(raw)) {
          const nestedId = nextProxyId++;
          proxyRegistry.set(
            nestedId,
            raw.value as Record<string, (...args: any[]) => any>,
          );
          ep.postMessage({ id, result: { __twProxyReturn: nestedId } });
        } else if (hasOwnFunctions(raw)) {
          const nestedId = nextProxyId++;
          proxyRegistry.set(nestedId, raw);
          ep.postMessage({ id, result: { __twProxyReturn: nestedId } });
        } else {
          const t = collectTransferables(raw);
          if (t.length > 0) {
            ep.postMessage({ id, result: raw }, t);
          } else {
            ep.postMessage({ id, result: raw });
          }
        }
      } catch (error) {
        ep.postMessage({ id, error: serializeError(error) });
      }
      return;
    }

    // Handle proxy release from main thread
    if (type === "proxy-release") {
      const { proxyId } = event.data;
      proxyRegistry.delete(proxyId);
      return;
    }

    if (!Object.hasOwn(api, method) || typeof api[method] !== "function") {
      ep.postMessage({
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
              ep.postMessage({
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
              ep.postMessage(
                { id, type: "next", value: value.value },
                value.transferables,
              );
            } else {
              const t = collectTransferables(value);
              if (t.length > 0) {
                ep.postMessage({ id, type: "next", value }, t);
              } else {
                ep.postMessage({ id, type: "next", value });
              }
            }
          }
          if (!cancelled) {
            ep.postMessage({ id, type: "done" });
          }
        } catch (error) {
          if (!cancelled) {
            ep.postMessage({
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
        ep.postMessage({ id, result: raw.value }, raw.transferables);
      } else if (isProxy(raw)) {
        const proxyId = nextProxyId++;
        proxyRegistry.set(
          proxyId,
          raw.value as Record<string, (...args: any[]) => any>,
        );
        ep.postMessage({ id, result: { __twProxyReturn: proxyId } });
      } else if (hasOwnFunctions(raw)) {
        const proxyId = nextProxyId++;
        proxyRegistry.set(proxyId, raw);
        ep.postMessage({ id, result: { __twProxyReturn: proxyId } });
      } else {
        const t = collectTransferables(raw);
        if (t.length > 0) {
          ep.postMessage({ id, result: raw }, t);
        } else {
          ep.postMessage({ id, result: raw });
        }
      }
      activeAborts.delete(id);
    } catch (error) {
      activeAborts.delete(id);
      ep.postMessage({ id, error: serializeError(error) });
    }
  });

  // MessagePort requires start() to begin receiving events
  ep.start?.();
}
