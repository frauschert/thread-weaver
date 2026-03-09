export type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export function wrap<T>(worker: Worker): Promisified<T> {
  const callbacks = new Map<
    string,
    { resolve: (value: any) => void; reject: (reason?: any) => void }
  >();
  worker.addEventListener("message", (event) => {
    const { id, result, error } = event.data;
    const callback = callbacks.get(id);
    if (!callback) return;

    if (error) {
      callback.reject(new Error(error));
    } else {
      callback.resolve(result);
    }
    callbacks.delete(id);
  });

  return new Proxy({} as Promisified<T>, {
    get(_, method: string) {
      return (...args: any[]) => {
        const id = Math.random().toString(36).substr(2);
        return new Promise((resolve, reject) => {
          callbacks.set(id, { resolve, reject });
          worker.postMessage({ id, method, args });
        });
      };
    },
  });
}
