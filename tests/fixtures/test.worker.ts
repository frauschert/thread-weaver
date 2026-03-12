import { expose, transfer } from "../../src/worker";

const api = {
  add(a: number, b: number) {
    return a + b;
  },

  async asyncMultiply(a: number, b: number) {
    return a * b;
  },

  fail() {
    throw new TypeError("intentional error");
  },

  getBuffer(size: number) {
    const buf = new ArrayBuffer(size);
    const view = new Uint8Array(buf);
    for (let i = 0; i < size; i++) view[i] = i % 256;
    return transfer(buf, [buf]);
  },

  async *count(n: number) {
    for (let i = 0; i < n; i++) {
      yield i;
    }
  },

  async *slowStream(_n: number) {
    let i = 0;
    while (true) {
      yield i++;
      await new Promise((r) => setTimeout(r, 10));
    }
  },

  async slow(ms: number) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    return "done";
  },
};

expose(api);

// Export a "clean" type without the AbortSignal parameter —
// expose() injects it automatically as an extra trailing arg.
export type TestWorkerApi = typeof api;
