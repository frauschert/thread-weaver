import { exposeServiceWorker, broadcast } from "../../src/service-worker";

const api = {
  add(a: number, b: number) {
    return a + b;
  },

  async asyncMultiply(a: number, b: number) {
    return a * b;
  },

  getBuffer(size: number) {
    const buf = new ArrayBuffer(size);
    const view = new Uint8Array(buf);
    for (let i = 0; i < size; i++) view[i] = i % 256;
    return buf;
  },

  async *count(n: number) {
    for (let i = 0; i < n; i++) {
      yield i;
    }
  },

  async sendBroadcast(data: unknown) {
    await broadcast(data);
    return "sent";
  },
};

exposeServiceWorker(api);

export type TestSWApi = typeof api;
