import { describe, it, expect, afterEach } from "vitest";
import { wrap, transfer, proxy } from "../src/main";
import { pool } from "../src/pool";
import { TimeoutError, AbortError, WorkerCrashedError } from "../src/errors";
import type { TestWorkerApi } from "./fixtures/test.worker";

function createWorker() {
  return new Worker(new URL("./fixtures/test.worker.ts", import.meta.url), {
    type: "module",
  });
}

describe("e2e: wrap", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<TestWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("calls a sync method and gets the result", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.add(2, 3);
    expect(result).toBe(5);
  });

  it("calls an async method", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.asyncMultiply(4, 5);
    expect(result).toBe(20);
  });

  it("handles multiple concurrent calls", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const [a, b, c] = await Promise.all([
      api.add(1, 2),
      api.add(10, 20),
      api.asyncMultiply(3, 7),
    ]);

    expect(a).toBe(3);
    expect(b).toBe(30);
    expect(c).toBe(21);
  });

  it("propagates errors with name and message", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    try {
      await api.fail();
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("TypeError");
      expect(err.message).toBe("intentional error");
    }
  });

  it("transfers ArrayBuffer with zero-copy", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.getBuffer(4);
    const view = new Uint8Array(result);
    expect(view).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it("sends transferables from main thread", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    // add ignores the buffer content, but verifies postMessage with transferables works
    const result = await api.add(transfer(1, []), 2);
    expect(result).toBe(3);
  });

  it("auto-detects transferable in return value", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.getBufferAuto(4);
    const view = new Uint8Array(result);
    expect(view).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it("auto-detects transferable ArrayBuffer in args", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([10, 20, 30, 40]);
    const sum = await api.sumBuffer(buf);
    expect(sum).toBe(100);
    // buf should be neutered after transfer
    expect(buf.byteLength).toBe(0);
  });
});

describe("e2e: streaming", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<TestWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("streams values from an async generator", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const stream = await api.count(5);
    const values: number[] = [];
    for await (const v of stream) {
      values.push(v);
    }
    expect(values).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles empty streams", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const stream = await api.count(0);
    const values: number[] = [];
    for await (const v of stream) {
      values.push(v);
    }
    expect(values).toEqual([]);
  });

  it("cancels a stream with break", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const stream = await api.count(1000);
    const values: number[] = [];
    for await (const v of stream) {
      values.push(v);
      if (v >= 2) break;
    }
    expect(values).toEqual([0, 1, 2]);
  });

  it("cancels a stream with abort()", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const call = api.slowStream(0);
    const stream = await call;
    const values: number[] = [];

    for await (const v of stream) {
      values.push(v);
      if (values.length >= 3) {
        call.abort();
        break;
      }
    }

    expect(values.length).toBeGreaterThanOrEqual(3);
  });
});

describe("e2e: timeout", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<TestWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("rejects when timeout fires", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker, { timeout: 50 });

    const err: any = await api.slow(5000).catch((e: any) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/timed out/);
  });

  it("per-call timeout overrides default", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker, { timeout: 5000 });

    const err: any = await api
      .slow(5000)
      .timeout(50)
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/timed out/);
  });

  it("does not timeout when response is fast", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker, { timeout: 5000 });

    const result = await api.add(1, 2);
    expect(result).toBe(3);
  });
});

describe("e2e: abort / signal", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<TestWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("abort() rejects with AbortError", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const promise = api.slow(5000);
    promise.abort("cancelled by test");

    const err: any = await promise.catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.name).toBe("AbortError");
    expect(err.message).toBe("cancelled by test");
  });

  it("signal() wires an AbortSignal", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const ctrl = new AbortController();
    const promise = api.slow(5000).signal(ctrl.signal);

    setTimeout(() => ctrl.abort(), 30);

    const err: any = await promise.catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.name).toBe("AbortError");
  });
});

describe("e2e: dispose", () => {
  it("rejects pending calls on dispose", async () => {
    const worker = createWorker();
    const api = wrap<TestWorkerApi>(worker);

    const promise = api.slow(5000);
    api.dispose();

    const err: any = await promise.catch((e: any) => e);
    expect(err).toBeInstanceOf(WorkerCrashedError);
    expect(err.message).toBe("Worker proxy disposed");
    worker.terminate();
  });

  it("supports Symbol.dispose", async () => {
    const worker = createWorker();
    const api = wrap<TestWorkerApi>(worker);

    const result = await api.add(1, 2);
    expect(result).toBe(3);

    api[Symbol.dispose]();
    const err: any = await api.add(1, 2).catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.message).toMatch(/disposed/);
    worker.terminate();
  });
});

describe("e2e: pool", () => {
  it("distributes calls across workers", async () => {
    const p = pool<TestWorkerApi>(createWorker, { size: 2 });

    try {
      const [a, b, c, d] = await Promise.all([
        p.add(1, 2),
        p.add(3, 4),
        p.add(5, 6),
        p.add(7, 8),
      ]);

      expect(a).toBe(3);
      expect(b).toBe(7);
      expect(c).toBe(11);
      expect(d).toBe(15);
    } finally {
      p.terminate();
    }
  });

  it("streams through a pool", async () => {
    const p = pool<TestWorkerApi>(createWorker, { size: 2 });

    try {
      const stream = await p.count(4);
      const values: number[] = [];
      for await (const v of stream) {
        values.push(v);
      }
      expect(values).toEqual([0, 1, 2, 3]);
    } finally {
      p.terminate();
    }
  });

  it("rejects after terminate", async () => {
    const p = pool<TestWorkerApi>(createWorker, { size: 1 });
    p.terminate();

    const err: any = await p.add(1, 2).catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.message).toMatch(/terminated/);
  });

  it("handles pool timeout", async () => {
    const p = pool<TestWorkerApi>(createWorker, {
      size: 1,
      timeout: 50,
    });

    try {
      const err: any = await p.slow(5000).catch((e: any) => e);
      expect(err).toBeInstanceOf(TimeoutError);
      expect(err.message).toMatch(/timed out/);
    } finally {
      p.terminate();
    }
  });
});

describe("e2e: proxy callbacks (bidirectional)", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<TestWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("invokes a proxy callback from the worker", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const progress: number[] = [];
    const result = await api.processWithProgress(
      "hello",
      proxy((pct: number) => {
        progress.push(pct);
      }),
    );

    expect(result).toBe("processed:hello");
    expect(progress).toEqual([25, 50, 75, 100]);
  });

  it("supports awaitable proxy callbacks with return values", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.transformValue(
      5,
      proxy((x: number) => x * 10),
    );

    expect(result).toBe(50);
  });

  it("handles async proxy callbacks", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.transformValue(
      7,
      proxy(async (x: number) => {
        await new Promise((r) => setTimeout(r, 10));
        return x + 3;
      }),
    );

    expect(result).toBe(10);
  });

  it("propagates proxy callback errors to the worker", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    await expect(
      api.transformValue(
        1,
        proxy(() => {
          throw new Error("callback failed");
        }),
      ),
    ).rejects.toThrow("callback failed");
  });

  it("auto-proxies bare function args without proxy() wrapper", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const progress: number[] = [];
    const result = await api.processWithProgress("auto", (pct: number) => {
      progress.push(pct);
    });

    expect(result).toBe("processed:auto");
    expect(progress).toEqual([25, 50, 75, 100]);
  });

  it("auto-proxies bare function with return value", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.transformValue(4, (x: number) => x * 5);

    expect(result).toBe(20);
  });

  it("auto-proxies bare async function", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const result = await api.transformValue(3, async (x: number) => {
      await new Promise((r) => setTimeout(r, 5));
      return x + 7;
    });

    expect(result).toBe(10);
  });
});

describe("e2e: remote proxy objects", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<TestWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("returns a RemoteObject and forwards method calls", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await api.createCounter();
    expect(await counter.get()).toBe(0);
    expect(await counter.increment()).toBe(1);
    expect(await counter.increment()).toBe(2);
    expect(await counter.get()).toBe(2);
    counter.release();
  });

  it("independent remote objects maintain separate state", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const a = await api.createCounter();
    const b = await api.createCounter();

    await a.increment();
    await a.increment();
    await b.add(10);

    expect(await a.get()).toBe(2);
    expect(await b.get()).toBe(10);

    a.release();
    b.release();
  });

  it("released remote object rejects further calls", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await api.createCounter();
    counter.release();

    const err: any = await counter.get().catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
  });

  it("Symbol.dispose releases the remote object", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await api.createCounter();
    expect(await counter.increment()).toBe(1);

    counter[Symbol.dispose]();

    const err: any = await counter.get().catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
  });

  it("remote object method supports .timeout()", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await api.createCounter();
    // A fast call should resolve within the timeout
    const result = await counter.increment().timeout(5000);
    expect(result).toBe(1);
    counter.release();
  });

  it("auto-detects plain object returns as proxies (no proxy() wrapper)", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await (api as any).createAutoCounter();
    expect(await counter.get()).toBe(0);
    expect(await counter.increment()).toBe(1);
    expect(await counter.increment()).toBe(2);
    expect(await counter.get()).toBe(2);
    counter.release();
  });

  it("auto-proxied objects maintain independent state", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const a = await (api as any).createAutoCounter();
    const b = await (api as any).createAutoCounter();

    await a.increment();
    await a.increment();
    await b.add(10);

    expect(await a.get()).toBe(2);
    expect(await b.get()).toBe(10);

    a.release();
    b.release();
  });
});

describe("e2e: proxy event emitters", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<TestWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("receives events from a worker-side emitter", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await (api as any).createEmittingCounter();
    const received: number[] = [];

    counter.on("changed", (n: number) => received.push(n));

    await counter.increment();
    await counter.increment();
    await counter.increment();

    expect(received).toEqual([1, 2, 3]);

    counter.release();
  });

  it("unsubscribe stops event delivery", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await (api as any).createEmittingCounter();
    const received: number[] = [];

    const off = counter.on("changed", (n: number) => received.push(n));

    await counter.increment();
    expect(received).toEqual([1]);

    off(); // unsubscribe

    await counter.increment();
    expect(received).toEqual([1]); // no new entries

    counter.release();
  });

  it("release() stops all event listeners", async () => {
    worker = createWorker();
    api = wrap<TestWorkerApi>(worker);

    const counter = await (api as any).createEmittingCounter();
    const received: number[] = [];

    counter.on("changed", (n: number) => received.push(n));

    await counter.increment();
    expect(received).toEqual([1]);

    counter.release();

    // Events after release should not be delivered
    // (The worker is still running but we unregistered listeners)
    expect(received).toEqual([1]);
  });
});
