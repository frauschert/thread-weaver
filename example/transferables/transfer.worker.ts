import { expose } from "../../src/worker";
import { transfer } from "../../src/transfer";

const api = {
  /** Receive an ArrayBuffer, double every byte, and transfer it back (zero-copy both ways). */
  doubleBytes(buffer: ArrayBuffer): ReturnType<typeof transfer<ArrayBuffer>> {
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i++) {
      view[i] = (view[i] * 2) & 0xff;
    }
    // Transfer the buffer back — no copy on the return trip either
    return transfer(buffer, [buffer]);
  },

  /** Generate a large buffer in the worker and transfer it to the main thread. */
  generateBuffer(size: number): ReturnType<typeof transfer<ArrayBuffer>> {
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i++) {
      view[i] = i & 0xff;
    }
    return transfer(buffer, [buffer]);
  },
};

expose(api);

export type ImageWorkerApi = typeof api;
