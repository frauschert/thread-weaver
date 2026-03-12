import { expose } from "../../src/worker";

const api = {
  add(a: number, b: number) {
    return a + b;
  },

  async asyncMultiply(a: number, b: number) {
    return a * b;
  },

  async *count(n: number) {
    for (let i = 0; i < n; i++) {
      yield i;
    }
  },
};

addEventListener("connect", (e: Event) => {
  const port = (e as MessageEvent).ports[0];
  expose(api, port);
});

export type SharedWorkerApi = typeof api;
