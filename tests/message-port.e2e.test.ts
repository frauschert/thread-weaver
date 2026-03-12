import { describe, it, expect, afterEach } from "vitest";
import { wrap } from "../src/main";
import { expose } from "../src/worker";
import { pool } from "../src/pool";
import type { SharedWorkerApi } from "./fixtures/shared.worker";

// ────────────────────────────────────────────────────────
// MessageChannel (both sides in the same context)
// ────────────────────────────────────────────────────────

describe("e2e: MessageChannel", () => {
  let port1: MessagePort;
  let port2: MessagePort;

  afterEach(() => {
    port1?.close();
    port2?.close();
  });

  it("calls a method through a MessageChannel", async () => {
    ({ port1, port2 } = new MessageChannel());
    expose({ add: (a: number, b: number) => a + b }, port1);
    const api = wrap<{ add(a: number, b: number): number }>(port2);

    const result = await api.add(2, 3);
    expect(result).toBe(5);

    api.dispose();
  });

  it("handles multiple concurrent calls", async () => {
    ({ port1, port2 } = new MessageChannel());
    expose(
      {
        add: (a: number, b: number) => a + b,
        multiply: (a: number, b: number) => a * b,
      },
      port1,
    );
    const api = wrap<{
      add(a: number, b: number): number;
      multiply(a: number, b: number): number;
    }>(port2);

    const [sum, product] = await Promise.all([
      api.add(10, 20),
      api.multiply(3, 7),
    ]);

    expect(sum).toBe(30);
    expect(product).toBe(21);

    api.dispose();
  });

  it("propagates errors through a MessageChannel", async () => {
    ({ port1, port2 } = new MessageChannel());
    expose(
      {
        fail() {
          throw new TypeError("boom");
        },
      },
      port1,
    );
    const api = wrap<{ fail(): never }>(port2);

    try {
      await api.fail();
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("TypeError");
      expect(err.message).toBe("boom");
    }

    api.dispose();
  });

  it("streams values through a MessageChannel", async () => {
    ({ port1, port2 } = new MessageChannel());
    expose(
      {
        async *count(n: number) {
          for (let i = 0; i < n; i++) yield i;
        },
      },
      port1,
    );
    const api = wrap<{ count(n: number): AsyncIterable<number> }>(port2);

    const stream = await api.count(4);
    const values: number[] = [];
    for await (const v of stream) {
      values.push(v);
    }
    expect(values).toEqual([0, 1, 2, 3]);

    api.dispose();
  });

  it("supports dispose on the wrapped port", async () => {
    ({ port1, port2 } = new MessageChannel());
    expose({ add: (a: number, b: number) => a + b }, port1);
    const api = wrap<{ add(a: number, b: number): number }>(port2);

    const result = await api.add(1, 1);
    expect(result).toBe(2);

    api.dispose();
    await expect(api.add(1, 2)).rejects.toThrow("disposed");
  });
});

// ────────────────────────────────────────────────────────
// SharedWorker (real SharedWorker in the browser)
// ────────────────────────────────────────────────────────

function createSharedWorker() {
  return new SharedWorker(
    new URL("./fixtures/shared.worker.ts", import.meta.url),
    { type: "module" },
  );
}

describe("e2e: SharedWorker", () => {
  let sw: SharedWorker;

  afterEach(() => {
    sw?.port.close();
  });

  it("calls a sync method on a SharedWorker", async () => {
    sw = createSharedWorker();
    const api = wrap<SharedWorkerApi>(sw.port);

    const result = await api.add(10, 20);
    expect(result).toBe(30);

    api.dispose();
  });

  it("calls an async method on a SharedWorker", async () => {
    sw = createSharedWorker();
    const api = wrap<SharedWorkerApi>(sw.port);

    const result = await api.asyncMultiply(6, 7);
    expect(result).toBe(42);

    api.dispose();
  });

  it("handles concurrent calls on a SharedWorker", async () => {
    sw = createSharedWorker();
    const api = wrap<SharedWorkerApi>(sw.port);

    const [a, b, c] = await Promise.all([
      api.add(1, 2),
      api.add(10, 20),
      api.asyncMultiply(3, 7),
    ]);

    expect(a).toBe(3);
    expect(b).toBe(30);
    expect(c).toBe(21);

    api.dispose();
  });

  it("streams values from a SharedWorker", async () => {
    sw = createSharedWorker();
    const api = wrap<SharedWorkerApi>(sw.port);

    const stream = await api.count(5);
    const values: number[] = [];
    for await (const v of stream) {
      values.push(v);
    }
    expect(values).toEqual([0, 1, 2, 3, 4]);

    api.dispose();
  });

  it("allows multiple connections to the same SharedWorker", async () => {
    sw = createSharedWorker();
    const api1 = wrap<SharedWorkerApi>(sw.port);

    const sw2 = createSharedWorker();
    const api2 = wrap<SharedWorkerApi>(sw2.port);

    const [r1, r2] = await Promise.all([api1.add(1, 2), api2.add(3, 4)]);

    expect(r1).toBe(3);
    expect(r2).toBe(7);

    api1.dispose();
    api2.dispose();
    sw2.port.close();
  });
});

// ────────────────────────────────────────────────────────
// Pool with SharedWorker ports
// ────────────────────────────────────────────────────────

describe("e2e: pool with SharedWorker", () => {
  it("distributes calls across SharedWorker ports", async () => {
    const p = pool<SharedWorkerApi>(
      () => {
        const s = createSharedWorker();
        return s.port;
      },
      { size: 2 },
    );

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

  it("streams through a SharedWorker pool", async () => {
    const p = pool<SharedWorkerApi>(
      () => {
        const s = createSharedWorker();
        return s.port;
      },
      { size: 2 },
    );

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
});
