import { expose } from "../../src/worker";

const api = {
  add(a: number, b: number) {
    return a + b;
  },

  echo(s: string) {
    return s;
  },

  async *count(n: number) {
    for (let i = 0; i < n; i++) {
      yield i;
    }
  },
};

expose(api, undefined, { compression: { threshold: 10 } });

export type CompressedWorkerApi = typeof api;
