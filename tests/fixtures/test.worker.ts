import { expose, transfer } from "../../src/worker";
import { proxy } from "../../src/transfer";

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

  getBufferAuto(size: number) {
    const buf = new ArrayBuffer(size);
    const view = new Uint8Array(buf);
    for (let i = 0; i < size; i++) view[i] = i % 256;
    return buf; // no explicit transfer() — relies on auto-detection
  },

  sumBuffer(buf: ArrayBuffer) {
    const view = new Uint8Array(buf);
    let sum = 0;
    for (let i = 0; i < view.length; i++) sum += view[i];
    return sum;
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

  async processWithProgress(data: string, onProgress: (pct: number) => void) {
    for (let i = 1; i <= 4; i++) {
      await onProgress(i * 25);
    }
    return `processed:${data}`;
  },

  async transformValue(
    x: number,
    transform: (v: number) => number | Promise<number>,
  ) {
    const result = await transform(x);
    return result;
  },

  createCounter() {
    let count = 0;
    return proxy({
      get() {
        return count;
      },
      increment() {
        count++;
        return count;
      },
      add(n: number) {
        count += n;
        return count;
      },
    });
  },
};

expose(api);

// Export a "clean" type without the AbortSignal parameter —
// expose() injects it automatically as an extra trailing arg.
export type TestWorkerApi = typeof api;
