import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrap } from "../src/main";
import { transfer } from "../src/transfer";

type MockWorker = {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  listeners: Record<string, ((...args: any[]) => void)[]>;
  emit: (event: string, data: any) => void;
};

function createMockWorker(): MockWorker {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  const mock: MockWorker = {
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
    emit(event: string, data: any) {
      for (const fn of listeners[event] ?? []) {
        fn(data);
      }
    },
  };

  return mock;
}

type TestApi = {
  add(a: number, b: number): number;
  greet(name: string): string;
};

describe("wrap", () => {
  let worker: MockWorker;
  let api: ReturnType<typeof wrap<TestApi>>;

  beforeEach(() => {
    worker = createMockWorker();
    api = wrap<TestApi>(worker as any);
  });

  it("sends a postMessage with id, method, and args", () => {
    api.add(1, 2);

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const [payload, transferables] = worker.postMessage.mock.calls[0];
    expect(payload).toEqual({ id: 0, method: "add", args: [1, 2] });
    expect(transferables).toEqual([]);
  });

  it("resolves the promise when worker responds with result", async () => {
    const promise = api.add(2, 3);

    worker.emit("message", { data: { id: 0, result: 5 } });

    await expect(promise).resolves.toBe(5);
  });

  it("rejects the promise when worker responds with error", async () => {
    const promise = api.greet("test");

    worker.emit("message", { data: { id: 0, error: "Something failed" } });

    await expect(promise).rejects.toThrow("Something failed");
  });

  it("uses incrementing IDs for each call", () => {
    api.add(1, 2);
    api.add(3, 4);
    api.greet("hello");

    const ids = worker.postMessage.mock.calls.map(([p]: any) => p.id);
    expect(ids).toEqual([0, 1, 2]);
  });

  it("matches responses to the correct call by id", async () => {
    const p1 = api.add(1, 2);
    const p2 = api.add(3, 4);

    // Respond out of order
    worker.emit("message", { data: { id: 1, result: 7 } });
    worker.emit("message", { data: { id: 0, result: 3 } });

    await expect(p1).resolves.toBe(3);
    await expect(p2).resolves.toBe(7);
  });

  it("ignores messages with unknown ids", () => {
    worker.emit("message", { data: { id: 999, result: "nope" } });
    // No error thrown
  });

  describe("transferables", () => {
    it("extracts transferables from Transfer-wrapped args", () => {
      const buf = new ArrayBuffer(8);
      api.add(transfer(buf, [buf]) as any, 2);

      const [payload, transferables] = worker.postMessage.mock.calls[0];
      expect(payload.args).toEqual([buf, 2]);
      expect(transferables).toEqual([buf]);
    });

    it("handles multiple Transfer-wrapped args", () => {
      const buf1 = new ArrayBuffer(4);
      const buf2 = new ArrayBuffer(8);
      api.add(transfer(buf1, [buf1]) as any, transfer(buf2, [buf2]) as any);

      const [payload, transferables] = worker.postMessage.mock.calls[0];
      expect(payload.args).toEqual([buf1, buf2]);
      expect(transferables).toEqual([buf1, buf2]);
    });

    it("passes non-Transfer args through unchanged", () => {
      api.add(1, 2);

      const [payload, transferables] = worker.postMessage.mock.calls[0];
      expect(payload.args).toEqual([1, 2]);
      expect(transferables).toEqual([]);
    });
  });

  describe("dispose", () => {
    it("removes all event listeners from the worker", () => {
      api.dispose();

      expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
      expect(worker.removeEventListener).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
      expect(worker.removeEventListener).toHaveBeenCalledWith(
        "error",
        expect.any(Function),
      );
      expect(worker.removeEventListener).toHaveBeenCalledWith(
        "messageerror",
        expect.any(Function),
      );
    });

    it("rejects pending calls when disposed", async () => {
      const promise = api.add(1, 2);
      api.dispose();

      await expect(promise).rejects.toThrow("Worker proxy disposed");
    });

    it("rejects new calls after dispose", async () => {
      api.dispose();

      await expect(api.add(1, 2)).rejects.toThrow(
        "Worker proxy has been disposed",
      );
    });

    it("is idempotent", () => {
      api.dispose();
      api.dispose();

      // removeEventListener only called 3 times (once per event), not 6
      expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
    });
  });

  describe("error handling", () => {
    it("rejects all pending calls on worker error event", async () => {
      const p1 = api.add(1, 2);
      const p2 = api.greet("hi");

      worker.emit("error", { message: "Worker crashed" });

      await expect(p1).rejects.toThrow("Worker crashed");
      await expect(p2).rejects.toThrow("Worker crashed");
    });

    it("rejects all pending calls on messageerror event", async () => {
      const promise = api.add(1, 2);

      worker.emit("messageerror", {});

      await expect(promise).rejects.toThrow(
        "Worker message could not be deserialized",
      );
    });

    it("uses fallback message when error event has no message", async () => {
      const promise = api.add(1, 2);

      worker.emit("error", { message: "" });

      await expect(promise).rejects.toThrow("Worker error");
    });
  });
});
