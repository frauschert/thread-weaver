export type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
} & { dispose(): void };

export function wrap<T>(worker: Worker): Promisified<T> {
  let nextId = 0;
  let disposed = false;
  const callbacks = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason?: any) => void }
  >();

  function rejectAll(reason: string) {
    for (const [id, cb] of callbacks) {
      cb.reject(new Error(reason));
    }
    callbacks.clear();
  }

  function onMessage(event: MessageEvent) {
    const { id, result, error } = event.data;
    const callback = callbacks.get(id);
    if (!callback) return;
    callbacks.delete(id);

    if (error) {
      callback.reject(new Error(error));
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
        return new Promise((resolve, reject) => {
          callbacks.set(id, { resolve, reject });
          worker.postMessage({ id, method: prop, args });
        });
      };
    },
  });
}
