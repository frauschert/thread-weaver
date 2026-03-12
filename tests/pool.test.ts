import { describe, it, expect, vi, beforeEach } from "vitest";
import { pool } from "../src/pool";

type MockWorker = {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  listeners: Record<string, ((...args: any[]) => void)[]>;
  emit: (event: string, data: any) => void;
};

function createMockWorker(): MockWorker {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  return {
    listeners,
    addEventListener: vi.fn(
      (event: string, handler: (...args: any[]) => void) => {
        (listeners[event] ??= []).push(handler);
      },
    ),
    removeEventListener: vi.fn(
      (event: string, handler: (...args: any[]) => void) => {
        const arr = listeners[event];
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      },
    ),
    postMessage: vi.fn(),
    terminate: vi.fn(),
    emit(event: string, data: any) {
      for (const fn of listeners[event] ?? []) {
        fn(data);
      }
    },
  };
}

type TestApi = {
  add(a: number, b: number): number;
};

describe("pool", () => {
  let workers: MockWorker[];

  function createPool(size = 3) {
    workers = [];
    return pool<TestApi>(
      () => {
        const w = createMockWorker();
        workers.push(w);
        return w as any;
      },
      { size },
    );
  }

  it("spawns the requested number of workers", () => {
    createPool(4);
    expect(workers).toHaveLength(4);
  });

  it("exposes the pool size", () => {
    const p = createPool(3);
    expect(p.size).toBe(3);
  });

  it("dispatches calls to workers", () => {
    const p = createPool(2);
    p.add(1, 2);

    const called = workers.filter((w) => w.postMessage.mock.calls.length > 0);
    expect(called).toHaveLength(1);
  });

  it("resolves when the worker responds", async () => {
    const p = createPool(1);
    const promise = p.add(1, 2);

    // Respond from the single worker
    workers[0].emit("message", { data: { id: 0, result: 3 } });

    await expect(promise).resolves.toBe(3);
  });

  it("distributes calls across workers (least-busy)", async () => {
    const p = createPool(2);

    // First call goes to worker 0 (both have 0 pending)
    p.add(1, 2);
    // Second call should go to worker 1 (worker 0 has 1 pending)
    p.add(3, 4);

    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    expect(workers[1].postMessage).toHaveBeenCalledTimes(1);
  });

  it("rebalances after calls complete", async () => {
    const p = createPool(2);

    // Fill worker 0
    const p1 = p.add(1, 2);

    // Worker 1 gets next call
    p.add(3, 4);

    // Complete worker 0's call
    workers[0].emit("message", { data: { id: 0, result: 3 } });
    await p1;

    // Next call should go to worker 0 again (now has 0 pending vs worker 1's 1)
    p.add(5, 6);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
  });

  describe("terminate", () => {
    it("terminates all underlying workers", () => {
      const p = createPool(3);
      p.terminate();

      for (const w of workers) {
        expect(w.terminate).toHaveBeenCalledTimes(1);
      }
    });

    it("rejects new calls after terminate", async () => {
      const p = createPool(2);
      p.terminate();

      await expect(p.add(1, 2)).rejects.toThrow(
        "Worker pool has been terminated",
      );
    });

    it("is idempotent", () => {
      const p = createPool(2);
      p.terminate();
      p.terminate();

      for (const w of workers) {
        expect(w.terminate).toHaveBeenCalledTimes(1);
      }
    });
  });

  it("dispose also terminates the pool", () => {
    const p = createPool(2);
    p.dispose();

    for (const w of workers) {
      expect(w.terminate).toHaveBeenCalledTimes(1);
    }
  });

  it("does not treat the pool as thenable", () => {
    const p = createPool(1);
    expect((p as any).then).toBeUndefined();
  });

  describe("timeout", () => {
    it("passes timeout option through to wrapped workers", async () => {
      vi.useFakeTimers();
      workers = [];
      const p = pool<TestApi>(
        () => {
          const w = createMockWorker();
          workers.push(w);
          return w as any;
        },
        { size: 1, timeout: 100 },
      );

      const promise = p.add(1, 2);

      vi.advanceTimersByTime(100);

      await expect(promise).rejects.toThrow(
        'Worker call "add" timed out after 100ms',
      );
      vi.useRealTimers();
    });

    it("does not timeout when pool has no timeout option", async () => {
      const p = createPool(1);
      const promise = p.add(1, 2);

      // Respond normally
      workers[0].emit("message", { data: { id: 0, result: 3 } });

      await expect(promise).resolves.toBe(3);
    });
  });
});
