import { type Transfer, isTransfer, transfer } from "./transfer";

export type { Transfer } from "./transfer";
export { transfer };

/** Unwrap Transfer<T> → T, pass everything else through. */
type UnwrapTransfer<T> = T extends Transfer<infer U> ? U : T;

/** Unwrap Transfer wrappers in a tuple of args. */
type UnwrapTransferArgs<T extends any[]> = {
  [K in keyof T]: T[K] | Transfer<T[K]>;
};

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

export type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: UnwrapTransferArgs<A>) => Promise<Awaited<UnwrapTransfer<R>>>
    : never;
} & { dispose(): void };

export function wrap<T>(
  worker: Worker,
  options: WrapOptions = {},
): Promisified<T> {
  const defaultTimeout = options.timeout ?? 0;
  let nextId = 0;
  let disposed = false;
  const callbacks = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  function rejectAll(reason: string) {
    for (const [id, cb] of callbacks) {
      if (cb.timer) clearTimeout(cb.timer);
      cb.reject(new Error(reason));
    }
    callbacks.clear();
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
    const { id, result, error } = event.data;
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
    get(_, prop: string) {
      // Prevent accidental `await proxy` — make the proxy non-thenable
      if (prop === "then") return undefined;

      if (prop === "dispose") {
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
        const id = nextId++;
        const { rawArgs, transferables } = extractTransferables(args);
        return new Promise((resolve, reject) => {
          const entry: {
            resolve: typeof resolve;
            reject: typeof reject;
            timer?: ReturnType<typeof setTimeout>;
          } = { resolve, reject };

          if (defaultTimeout > 0) {
            entry.timer = setTimeout(() => {
              if (callbacks.delete(id)) {
                reject(
                  new Error(
                    `Worker call "${prop}" timed out after ${defaultTimeout}ms`,
                  ),
                );
              }
            }, defaultTimeout);
          }

          callbacks.set(id, entry);
          worker.postMessage(
            { id, method: prop, args: rawArgs },
            transferables,
          );
        });
      };
    },
  });
}
