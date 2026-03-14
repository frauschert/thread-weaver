import { describe, it, expect, afterEach } from "vitest";
import { wrap } from "../src/main";
import { connectServiceWorker, onBroadcast } from "../src/service-worker";
import type { TestSWApi } from "./fixtures/test-sw.worker";

function swUrl() {
  return new URL("./fixtures/test-sw.worker.ts", import.meta.url).href;
}

async function registerAndConnect() {
  const reg = await navigator.serviceWorker.register(swUrl(), {
    type: "module",
  });
  const port = await connectServiceWorker(reg as any);
  return { reg, port };
}

describe("e2e: Service Worker", () => {
  let reg: ServiceWorkerRegistration | undefined;
  let api: ReturnType<typeof wrap<TestSWApi>> | undefined;

  afterEach(async () => {
    api?.dispose();
    api = undefined;
    if (reg) {
      await reg.unregister();
      reg = undefined;
    }
  });

  it("calls an RPC method through a Service Worker", async () => {
    const conn = await registerAndConnect();
    reg = conn.reg;
    api = wrap<TestSWApi>(conn.port);

    const result = await api.add(3, 4);
    expect(result).toBe(7);
  });

  it("supports async methods", async () => {
    const conn = await registerAndConnect();
    reg = conn.reg;
    api = wrap<TestSWApi>(conn.port);

    const result = await api.asyncMultiply(5, 6);
    expect(result).toBe(30);
  });

  it("auto-transfers ArrayBuffer in return value", async () => {
    const conn = await registerAndConnect();
    reg = conn.reg;
    api = wrap<TestSWApi>(conn.port);

    const buf = await api.getBuffer(4);
    const view = new Uint8Array(buf as ArrayBuffer);
    expect(view).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it("streams values from an async generator", async () => {
    const conn = await registerAndConnect();
    reg = conn.reg;
    api = wrap<TestSWApi>(conn.port);

    const stream = await api.count(3);
    const values: number[] = [];
    for await (const v of stream) {
      values.push(v as number);
    }
    expect(values).toEqual([0, 1, 2]);
  });

  it("receives broadcast from Service Worker", async () => {
    const conn = await registerAndConnect();
    reg = conn.reg;
    api = wrap<TestSWApi>(conn.port);

    const received: unknown[] = [];
    const unsub = onBroadcast((data) => received.push(data));

    // Tell the SW to broadcast
    await api.sendBroadcast({ hello: "world" });

    // Give the broadcast a moment to arrive
    await new Promise((r) => setTimeout(r, 100));

    unsub();

    expect(received).toContainEqual({ hello: "world" });
  });
});
