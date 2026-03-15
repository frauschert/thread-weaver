import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrap } from "../src/main";
import { transfer } from "../src/transfer";
import { TimeoutError, AbortError, WorkerCrashedError } from "../src/errors";

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

  afterEach(() => {
    vi.useRealTimers();
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

    worker.emit("message", {
      data: { id: 0, error: { message: "Something failed", name: "Error" } },
    });

    await expect(promise).rejects.toThrow("Something failed");
  });

  it("reconstructs error name and stack from structured error", async () => {
    const promise = api.greet("test");

    worker.emit("message", {
      data: {
        id: 0,
        error: {
          message: "Not found",
          name: "TypeError",
          stack: "TypeError: Not found\n    at Worker.ts:10",
        },
      },
    });

    try {
      await promise;
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("Not found");
      expect(err.name).toBe("TypeError");
      expect(err.stack).toContain("Worker.ts:10");
    }
  });

  it("handles plain string errors for backward compatibility", async () => {
    const promise = api.greet("test");

    worker.emit("message", {
      data: { id: 0, error: "legacy string error" },
    });

    await expect(promise).rejects.toThrow("legacy string error");
  });

  it("does not treat the proxy as thenable (then returns undefined)", () => {
    expect((api as any).then).toBeUndefined();
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

    it("auto-detects a bare ArrayBuffer arg", () => {
      const buf = new ArrayBuffer(8);
      api.add(buf as any, 2);

      const [payload, transferables] = worker.postMessage.mock.calls[0];
      expect(payload.args).toEqual([buf, 2]);
      expect(transferables).toEqual([buf]);
    });

    it("auto-detects ArrayBuffer inside a nested object arg", () => {
      const buf = new ArrayBuffer(4);
      api.add({ data: buf } as any, 1);

      const [payload, transferables] = worker.postMessage.mock.calls[0];
      expect(payload.args).toEqual([{ data: buf }, 1]);
      expect(transferables).toEqual([buf]);
    });

    it("auto-detects typed array buffer", () => {
      const u8 = new Uint8Array(4);
      api.add(u8 as any, 1);

      const [payload, transferables] = worker.postMessage.mock.calls[0];
      expect(payload.args).toEqual([u8, 1]);
      expect(transferables).toEqual([u8.buffer]);
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

      const err: any = await promise.catch((e: any) => e);
      expect(err).toBeInstanceOf(WorkerCrashedError);
      expect(err.message).toBe("Worker proxy disposed");
    });

    it("rejects new calls after dispose", async () => {
      api.dispose();

      const err: any = await api.add(1, 2).catch((e: any) => e);
      expect(err).toBeInstanceOf(AbortError);
      expect(err.message).toBe("Worker proxy has been disposed");
    });

    it("is idempotent", () => {
      api.dispose();
      api.dispose();

      // removeEventListener only called 3 times (once per event), not 6
      expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
    });

    it("supports Symbol.dispose", () => {
      api[Symbol.dispose]();

      expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
    });

    it("Symbol.dispose is idempotent with dispose()", () => {
      api.dispose();
      api[Symbol.dispose]();

      expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
    });
  });

  describe("error handling", () => {
    it("rejects all pending calls on worker error event", async () => {
      const p1 = api.add(1, 2);
      const p2 = api.greet("hi");

      worker.emit("error", { message: "Worker crashed" });

      const err1: any = await p1.catch((e: any) => e);
      const err2: any = await p2.catch((e: any) => e);
      expect(err1).toBeInstanceOf(WorkerCrashedError);
      expect(err2).toBeInstanceOf(WorkerCrashedError);
      expect(err1.message).toBe("Worker crashed");
      expect(err2.message).toBe("Worker crashed");
    });

    it("rejects all pending calls on messageerror event", async () => {
      const promise = api.add(1, 2);

      worker.emit("messageerror", {});

      const err: any = await promise.catch((e: any) => e);
      expect(err).toBeInstanceOf(WorkerCrashedError);
      expect(err.message).toBe("Worker message could not be deserialized");
    });

    it("uses fallback message when error event has no message", async () => {
      const promise = api.add(1, 2);

      worker.emit("error", { message: "" });

      const err: any = await promise.catch((e: any) => e);
      expect(err).toBeInstanceOf(WorkerCrashedError);
      expect(err.message).toBe("Worker error");
    });
  });

  describe("timeout", () => {
    it("rejects the call after the timeout elapses", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2);

      const assertion = promise.catch((e: any) => e);
      vi.advanceTimersByTime(100);
      const err = await assertion;
      expect(err).toBeInstanceOf(TimeoutError);
      expect(err.method).toBe("add");
      expect(err.timeout).toBe(100);
      expect(err.message).toBe('Worker call "add" timed out after 100ms');
      vi.useRealTimers();
    });

    it("does not reject if the worker responds before the timeout", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 500 });

      const promise = timedApi.add(1, 2);

      // Respond before timeout
      w.emit("message", { data: { id: 0, result: 3 } });

      vi.advanceTimersByTime(500);

      await expect(promise).resolves.toBe(3);
      vi.useRealTimers();
    });

    it("does not set a timer when timeout is 0", () => {
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 0 });

      timedApi.add(1, 2);

      // No timer was set — nothing to assert directly,
      // just ensure the call is pending without rejection
      expect(w.postMessage).toHaveBeenCalledTimes(1);
    });

    it("does not set a timer when timeout is undefined", () => {
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any);

      timedApi.add(1, 2);

      expect(w.postMessage).toHaveBeenCalledTimes(1);
    });

    it("clears timers on dispose", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2);

      // Attach handler before synchronous rejection
      const assertion = expect(promise).rejects.toThrow(
        "Worker proxy disposed",
      );
      timedApi.dispose();

      // Advance past timeout — should not cause unhandled rejection
      vi.advanceTimersByTime(200);

      await assertion;
      vi.useRealTimers();
    });

    it("includes the method name in the timeout error", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 50 });

      const promise = timedApi.greet("hi");

      const assertion = expect(promise).rejects.toThrow(
        'Worker call "greet" timed out after 50ms',
      );
      vi.advanceTimersByTime(50);
      await assertion;
      vi.useRealTimers();
    });

    it("sends cancel to the worker when timeout fires", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2);

      const assertion = expect(promise).rejects.toThrow(
        'Worker call "add" timed out after 100ms',
      );
      vi.advanceTimersByTime(100);
      await assertion;

      const cancelMsg = w.postMessage.mock.calls.find(
        ([p]: any) => p.type === "cancel",
      );
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg![0].id).toBe(0);
      vi.useRealTimers();
    });

    it("per-call .timeout() sends cancel to the worker when it fires", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any);

      const promise = timedApi.add(1, 2).timeout(50);

      const assertion = expect(promise).rejects.toThrow(
        'Worker call "add" timed out after 50ms',
      );
      vi.advanceTimersByTime(50);
      await assertion;

      const cancelMsg = w.postMessage.mock.calls.find(
        ([p]: any) => p.type === "cancel",
      );
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg![0].id).toBe(0);
      vi.useRealTimers();
    });
  });

  describe("abort", () => {
    it("rejects with AbortError when abort() is called", async () => {
      const promise = api.add(1, 2);

      const catchPromise = promise.catch((e: any) => e);
      promise.abort();

      const err: any = await catchPromise;
      expect(err).toBeInstanceOf(AbortError);
      expect(err.name).toBe("AbortError");
      expect(err.message).toBe("Aborted");
    });

    it("accepts a custom abort reason", async () => {
      const promise = api.add(1, 2);

      const catchPromise = promise.catch((e: any) => e);
      promise.abort("user cancelled");

      const err: any = await catchPromise;
      expect(err.name).toBe("AbortError");
      expect(err.message).toBe("user cancelled");
    });

    it("clears the timeout timer on abort", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2);
      const catchPromise = promise.catch((e: any) => e);
      promise.abort();

      // Advance past timeout — should not cause unhandled rejection
      vi.advanceTimersByTime(200);

      const err: any = await catchPromise;
      expect(err.name).toBe("AbortError");
      vi.useRealTimers();
    });

    it("is a no-op after the call has already resolved", async () => {
      const promise = api.add(1, 2);
      worker.emit("message", { data: { id: 0, result: 3 } });

      await expect(promise).resolves.toBe(3);
      // Should not throw
      promise.abort();
    });
  });

  describe("per-call timeout override", () => {
    it(".timeout(ms) overrides the default timeout", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 1000 });

      const promise = timedApi.add(1, 2).timeout(50);

      const assertion = expect(promise).rejects.toThrow(
        'Worker call "add" timed out after 50ms',
      );
      vi.advanceTimersByTime(50);
      await assertion;
      vi.useRealTimers();
    });

    it(".timeout(0) disables the timeout for that call", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2).timeout(0);

      vi.advanceTimersByTime(200);

      // Should still be pending, not rejected
      let settled = false;
      promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      vi.useRealTimers();
    });

    it(".timeout() returns the same promise for chaining", () => {
      const promise = api.add(1, 2);
      const result = promise.timeout(100);
      expect(result).toBe(promise);

      // Prevent unhandled rejection when the 100ms timer fires
      promise.catch(() => {});
    });
  });

  describe("signal", () => {
    it("wires an AbortSignal to the call", async () => {
      const ctrl = new AbortController();
      const promise = api.add(1, 2).signal(ctrl.signal);

      ctrl.abort();

      const err: any = await promise.catch((e: any) => e);
      expect(err.name).toBe("AbortError");
    });

    it("rejects immediately if signal is already aborted", async () => {
      const ctrl = new AbortController();
      ctrl.abort();

      const promise = api.add(1, 2).signal(ctrl.signal);

      const err: any = await promise.catch((e: any) => e);
      expect(err.name).toBe("AbortError");
    });

    it("returns the same promise for chaining", () => {
      const ctrl = new AbortController();
      const promise = api.add(1, 2);
      const result = promise.signal(ctrl.signal);
      expect(result).toBe(promise);
    });

    it("supports chaining .timeout() and .signal()", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any);
      const ctrl = new AbortController();

      const promise = timedApi.add(1, 2).timeout(200).signal(ctrl.signal);

      ctrl.abort();

      const err: any = await promise.catch((e: any) => e);
      expect(err.name).toBe("AbortError");
      vi.useRealTimers();
    });
  });

  describe("streaming", () => {
    it("resolves with an async iterable on first 'next' message", async () => {
      const promise = api.add(1, 2);

      // Worker sends streaming messages
      worker.emit("message", { data: { id: 0, type: "next", value: 1 } });
      worker.emit("message", { data: { id: 0, type: "next", value: 2 } });
      worker.emit("message", { data: { id: 0, type: "next", value: 3 } });
      worker.emit("message", { data: { id: 0, type: "done" } });

      const iterable = await promise;
      const values: number[] = [];
      for await (const v of iterable as unknown as AsyncIterable<number>) {
        values.push(v);
      }
      expect(values).toEqual([1, 2, 3]);
    });

    it("rejects the iterator on stream error", async () => {
      const promise = api.add(1, 2);

      worker.emit("message", { data: { id: 0, type: "next", value: 1 } });
      worker.emit("message", {
        data: {
          id: 0,
          type: "error",
          error: { message: "stream broke", name: "Error" },
        },
      });

      const iterable = await promise;
      const values: number[] = [];

      await expect(
        (async () => {
          for await (const v of iterable as unknown as AsyncIterable<number>) {
            values.push(v);
          }
        })(),
      ).rejects.toThrow("stream broke");
      expect(values).toEqual([1]);
    });

    it("rejects the call promise if error comes before first next", async () => {
      const promise = api.add(1, 2);

      worker.emit("message", {
        data: {
          id: 0,
          type: "error",
          error: { message: "init failed", name: "Error" },
        },
      });

      await expect(promise).rejects.toThrow("init failed");
    });

    it("handles empty streams (done before any next)", async () => {
      const promise = api.add(1, 2);

      // Worker sends 'done' without any 'next' messages
      worker.emit("message", { data: { id: 0, type: "done" } });

      const iterable = await promise;
      const values: number[] = [];
      for await (const v of iterable as unknown as AsyncIterable<number>) {
        values.push(v);
      }
      expect(values).toEqual([]);
    });

    it("handles interleaved streams and regular calls", async () => {
      // Stream call
      const streamPromise = api.add(1, 2);
      // Regular call
      const regularPromise = api.greet("hi");

      worker.emit("message", { data: { id: 0, type: "next", value: 10 } });
      worker.emit("message", {
        data: { id: 1, result: "Hello, hi!" },
      });
      worker.emit("message", { data: { id: 0, type: "done" } });

      const iterable = await streamPromise;
      const values: number[] = [];
      for await (const v of iterable as unknown as AsyncIterable<number>) {
        values.push(v);
      }
      expect(values).toEqual([10]);
      await expect(regularPromise).resolves.toBe("Hello, hi!");
    });

    it("abort() closes an active stream", async () => {
      const promise = api.add(1, 2);

      worker.emit("message", { data: { id: 0, type: "next", value: 1 } });

      const iterable = await promise;

      // Abort the stream mid-iteration
      promise.abort();

      const values: number[] = [];
      await expect(
        (async () => {
          for await (const v of iterable as unknown as AsyncIterable<number>) {
            values.push(v);
          }
        })(),
      ).rejects.toThrow();
      expect(values).toEqual([1]);
      // Should have sent a cancel message to the worker
      const cancelMsg = worker.postMessage.mock.calls.find(
        ([p]: any) => p.type === "cancel",
      );
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg![0].id).toBe(0);
    });

    it("dispose() closes all active streams", async () => {
      const promise = api.add(1, 2);

      worker.emit("message", { data: { id: 0, type: "next", value: 1 } });

      const iterable = await promise;

      api.dispose();

      const values: number[] = [];
      const streamErr: any = await (async () => {
        try {
          for await (const v of iterable as unknown as AsyncIterable<number>) {
            values.push(v);
          }
        } catch (e) {
          return e;
        }
      })();
      expect(streamErr).toBeInstanceOf(WorkerCrashedError);
      expect(streamErr.message).toBe("Worker proxy disposed");
    });

    it("dispose() sends cancel to the worker for active streams", async () => {
      api.add(1, 2);
      worker.emit("message", { data: { id: 0, type: "next", value: 1 } });

      // Stream is now active
      api.dispose();

      const cancelMsg = worker.postMessage.mock.calls.find(
        ([p]: any) => p.type === "cancel",
      );
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg![0].id).toBe(0);
    });

    it("abort() before first stream message rejects the call promise", async () => {
      const promise = api.add(1, 2);

      // Abort before any 'next' message — stream not yet established
      promise.abort();

      const err: any = await promise.catch((e: any) => e);
      expect(err.name).toBe("AbortError");

      // Should have sent cancel to the worker
      const cancelMsg = worker.postMessage.mock.calls.find(
        ([p]: any) => p.type === "cancel",
      );
      expect(cancelMsg).toBeDefined();
    });

    it("break in for-await sends cancel to the worker", async () => {
      const promise = api.add(1, 2);

      worker.emit("message", { data: { id: 0, type: "next", value: 1 } });
      worker.emit("message", { data: { id: 0, type: "next", value: 2 } });
      worker.emit("message", { data: { id: 0, type: "next", value: 3 } });

      const iterable = await promise;
      const values: number[] = [];
      for await (const v of iterable as unknown as AsyncIterable<number>) {
        values.push(v);
        if (v === 2) break;
      }
      expect(values).toEqual([1, 2]);

      // Should have sent a cancel message to the worker
      const cancelMsg = worker.postMessage.mock.calls.find(
        ([p]: any) => p.type === "cancel",
      );
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg![0].id).toBe(0);
    });
  });

  describe("postMessage failure", () => {
    it("rejects and cleans up if postMessage throws", async () => {
      const w = createMockWorker();
      w.postMessage.mockImplementation(() => {
        throw new DOMException(
          "Failed to execute 'postMessage'",
          "DataCloneError",
        );
      });
      const failApi = wrap<TestApi>(w as any);

      await expect(failApi.add(1, 2)).rejects.toThrow(
        "Failed to execute 'postMessage'",
      );

      // A subsequent response for that id should be ignored (callback cleaned up)
      w.emit("message", { data: { id: 0, result: 3 } });
    });

    it("clears the timeout timer on postMessage failure", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      w.postMessage.mockImplementation(() => {
        throw new Error("clone error");
      });
      const failApi = wrap<TestApi>(w as any, { timeout: 100 });

      await expect(failApi.add(1, 2)).rejects.toThrow("clone error");

      // Advance past timeout — should not cause unhandled rejection
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
    });
  });

  describe("stream idle timeout", () => {
    it("errors the stream after idle timeout elapses", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2);

      // First next message — resolves the promise with the queue
      w.emit("message", { data: { id: 0, type: "next", value: 1 } });
      const iterable = await promise;

      // Advance past idle timeout with no more messages
      vi.advanceTimersByTime(100);

      const values: number[] = [];
      let streamErr: any;
      try {
        for await (const v of iterable as unknown as AsyncIterable<number>) {
          values.push(v);
        }
      } catch (e) {
        streamErr = e;
      }
      expect(streamErr).toBeInstanceOf(TimeoutError);
      expect(streamErr.message).toMatch(/timed out.*inactivity/);
      expect(values).toEqual([1]);

      // Should have sent cancel
      const cancelMsg = w.postMessage.mock.calls.find(
        ([p]: any) => p.type === "cancel",
      );
      expect(cancelMsg).toBeDefined();
      vi.useRealTimers();
    });

    it("resets the idle timer on each next message", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2);

      w.emit("message", { data: { id: 0, type: "next", value: 1 } });
      await promise;

      // Advance 80ms (below timeout)
      vi.advanceTimersByTime(80);

      // Another message resets the timer
      w.emit("message", { data: { id: 0, type: "next", value: 2 } });

      // Advance another 80ms — total 160ms but timer was reset at 80ms
      vi.advanceTimersByTime(80);

      // Stream should still be alive — send done
      w.emit("message", { data: { id: 0, type: "done" } });

      const iterable = await promise;
      const values: number[] = [];
      for await (const v of iterable as unknown as AsyncIterable<number>) {
        values.push(v);
      }
      expect(values).toEqual([1, 2]);
      vi.useRealTimers();
    });

    it("per-call .timeout() overrides stream idle timeout", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 1000 });

      const promise = timedApi.add(1, 2).timeout(50);

      w.emit("message", { data: { id: 0, type: "next", value: 1 } });
      await promise;

      // Advance 50ms — per-call override should fire
      vi.advanceTimersByTime(50);

      const iterable = await promise;
      const values: number[] = [];
      await expect(
        (async () => {
          for await (const v of iterable as unknown as AsyncIterable<number>) {
            values.push(v);
          }
        })(),
      ).rejects.toThrow(/timed out.*inactivity/);
      expect(values).toEqual([1]);
      vi.useRealTimers();
    });

    it("no idle timeout when timeout is 0", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const noTimeoutApi = wrap<TestApi>(w as any);

      const promise = noTimeoutApi.add(1, 2);

      w.emit("message", { data: { id: 0, type: "next", value: 1 } });
      await promise;

      // Advance a long time — should not error
      vi.advanceTimersByTime(999999);

      w.emit("message", { data: { id: 0, type: "done" } });

      const iterable = await promise;
      const values: number[] = [];
      for await (const v of iterable as unknown as AsyncIterable<number>) {
        values.push(v);
      }
      expect(values).toEqual([1]);
      vi.useRealTimers();
    });

    it("clears idle timer on stream done", async () => {
      vi.useFakeTimers();
      const w = createMockWorker();
      const timedApi = wrap<TestApi>(w as any, { timeout: 100 });

      const promise = timedApi.add(1, 2);

      w.emit("message", { data: { id: 0, type: "next", value: 1 } });
      w.emit("message", { data: { id: 0, type: "done" } });

      await promise;

      // Advance past timeout — should not cause errors
      vi.advanceTimersByTime(200);

      const iterable = await promise;
      const values: number[] = [];
      for await (const v of iterable as unknown as AsyncIterable<number>) {
        values.push(v);
      }
      expect(values).toEqual([1]);
      vi.useRealTimers();
    });
  });
});

describe("remote proxy objects", () => {
  let worker: MockWorker;

  beforeEach(() => {
    worker = createMockWorker();
  });

  it("creates a RemoteObject when response contains __twProxyReturn", async () => {
    type Api = { createCounter(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.createCounter();
    const callMsg = worker.postMessage.mock.calls[0][0];
    expect(callMsg.method).toBe("createCounter");

    // Worker responds with a proxy marker
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 42 } },
    });

    const remote = await promise;
    expect(remote).toBeDefined();
    expect(typeof remote.release).toBe("function");
  });

  it("forwards method calls on RemoteObject via proxy-call messages", async () => {
    type Api = { createCounter(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.createCounter();
    const callMsg = worker.postMessage.mock.calls[0][0];

    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 0 } },
    });
    const remote = await promise;

    // Call a method on the remote object
    const incPromise = remote.increment(5);
    const proxyCallMsg = worker.postMessage.mock.calls[1][0];

    expect(proxyCallMsg.type).toBe("proxy-call");
    expect(proxyCallMsg.proxyId).toBe(0);
    expect(proxyCallMsg.method).toBe("increment");
    expect(proxyCallMsg.args).toEqual([5]);

    // Worker responds
    worker.emit("message", { data: { id: proxyCallMsg.id, result: 6 } });
    const result = await incPromise;
    expect(result).toBe(6);
  });

  it("release() sends a proxy-release message", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 7 } },
    });
    const remote = await promise;

    remote.release();

    const releaseMsg = worker.postMessage.mock.calls[1][0];
    expect(releaseMsg.type).toBe("proxy-release");
    expect(releaseMsg.proxyId).toBe(7);
  });

  it("released RemoteObject rejects further calls with AbortError", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 3 } },
    });
    const remote = await promise;

    remote.release();

    const err = await remote.doSomething().catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.message).toBe("Remote proxy has been released");
  });

  it("release() is idempotent — only sends one message", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 1 } },
    });
    const remote = await promise;

    const beforeCount = worker.postMessage.mock.calls.length;
    remote.release();
    remote.release();
    remote.release();

    expect(worker.postMessage.mock.calls.length).toBe(beforeCount + 1);
  });

  it("Symbol.dispose works on RemoteObject", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 5 } },
    });
    const remote = await promise;

    remote[Symbol.dispose]();

    const releaseMsg = worker.postMessage.mock.calls[1][0];
    expect(releaseMsg.type).toBe("proxy-release");
    expect(releaseMsg.proxyId).toBe(5);
  });

  it("RemoteObject method supports .timeout()", async () => {
    vi.useFakeTimers();

    type Api = { create(): any };
    const api = wrap<Api>(worker as any, { timeout: 0 });

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 0 } },
    });
    const remote = await promise;

    const p = remote.slow().timeout(100);

    vi.advanceTimersByTime(101);

    const err = await p.catch((e: any) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.method).toBe("slow");
    expect(err.timeout).toBe(100);

    vi.useRealTimers();
  });

  it("RemoteObject method supports .abort()", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any, { timeout: 0 });

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 0 } },
    });
    const remote = await promise;

    const p = remote.doWork();
    p.abort("cancelled");

    const err = await p.catch((e: any) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.message).toBe("cancelled");
  });

  it("handles nested proxy returns from proxy-call", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any, { timeout: 0 });

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 0 } },
    });
    const remote = await promise;

    // Call a method that returns another proxy
    const nestedPromise = remote.getChild();
    const proxyCallMsg = worker.postMessage.mock.calls[1][0];

    // Worker responds with a nested proxy marker
    worker.emit("message", {
      data: { id: proxyCallMsg.id, result: { __twProxyReturn: 1 } },
    });
    const nested = await nestedPromise;

    expect(nested).toBeDefined();
    expect(typeof nested.release).toBe("function");

    // Nested proxy method call
    const valuePromise = nested.getValue();
    const nestedCallMsg = worker.postMessage.mock.calls[2][0];
    expect(nestedCallMsg.type).toBe("proxy-call");
    expect(nestedCallMsg.proxyId).toBe(1);

    worker.emit("message", { data: { id: nestedCallMsg.id, result: 99 } });
    expect(await valuePromise).toBe(99);
  });

  it("auto-detects plain objects with function properties as proxies", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];

    // Worker responds with a proxy marker (auto-detected by worker)
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 10 } },
    });

    const remote = await promise;
    expect(remote).toBeDefined();
    expect(typeof remote.release).toBe("function");

    // Method calls work the same as explicit proxy
    const incPromise = remote.doWork();
    const proxyCallMsg = worker.postMessage.mock.calls[1][0];
    expect(proxyCallMsg.type).toBe("proxy-call");
    expect(proxyCallMsg.proxyId).toBe(10);

    worker.emit("message", { data: { id: proxyCallMsg.id, result: 42 } });
    expect(await incPromise).toBe(42);
  });
});

describe("proxy event emitters", () => {
  let worker: MockWorker;

  beforeEach(() => {
    worker = createMockWorker();
  });

  it("dispatches proxy-event messages to .on() listeners", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 10 } },
    });
    const remote = await promise;

    const received: any[] = [];
    remote.on("tick", (data: any) => received.push(data));

    // Simulate worker sending proxy-event
    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 10, event: "tick", data: 1 },
    });
    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 10, event: "tick", data: 2 },
    });

    expect(received).toEqual([1, 2]);
  });

  it(".on() returns an unsubscribe function", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 20 } },
    });
    const remote = await promise;

    const received: any[] = [];
    const off = remote.on("change", (data: any) => received.push(data));

    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 20, event: "change", data: "a" },
    });
    expect(received).toEqual(["a"]);

    off(); // unsubscribe

    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 20, event: "change", data: "b" },
    });
    expect(received).toEqual(["a"]); // no new entries
  });

  it("supports multiple listeners for the same event", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 30 } },
    });
    const remote = await promise;

    const received1: any[] = [];
    const received2: any[] = [];
    remote.on("data", (d: any) => received1.push(d));
    remote.on("data", (d: any) => received2.push(d));

    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 30, event: "data", data: 42 },
    });

    expect(received1).toEqual([42]);
    expect(received2).toEqual([42]);
  });

  it("supports multiple event types on the same proxy", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 40 } },
    });
    const remote = await promise;

    const ticks: any[] = [];
    const dones: any[] = [];
    remote.on("tick", (d: any) => ticks.push(d));
    remote.on("done", (d: any) => dones.push(d));

    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 40, event: "tick", data: 1 },
    });
    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 40, event: "done", data: true },
    });
    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 40, event: "tick", data: 2 },
    });

    expect(ticks).toEqual([1, 2]);
    expect(dones).toEqual([true]);
  });

  it("release() cleans up event listeners", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 50 } },
    });
    const remote = await promise;

    const received: any[] = [];
    remote.on("tick", (d: any) => received.push(d));

    remote.release();

    // Events after release should not be dispatched
    worker.emit("message", {
      data: { type: "proxy-event", proxyId: 50, event: "tick", data: 99 },
    });
    expect(received).toEqual([]);
  });

  it("ignores proxy-event for unknown proxyId", () => {
    type Api = { add(a: number, b: number): number };
    wrap<Api>(worker as any);

    // Should not throw when receiving events for unknown proxy
    expect(() => {
      worker.emit("message", {
        data: {
          type: "proxy-event",
          proxyId: 999,
          event: "tick",
          data: 1,
        },
      });
    }).not.toThrow();
  });

  it("ignores proxy-event for unsubscribed event names", async () => {
    type Api = { create(): any };
    const api = wrap<Api>(worker as any);

    const promise = api.create();
    const callMsg = worker.postMessage.mock.calls[0][0];
    worker.emit("message", {
      data: { id: callMsg.id, result: { __twProxyReturn: 60 } },
    });
    const remote = await promise;

    const received: any[] = [];
    remote.on("known", (d: any) => received.push(d));

    // Event for a different name — should be silently ignored
    worker.emit("message", {
      data: {
        type: "proxy-event",
        proxyId: 60,
        event: "unknown",
        data: "nope",
      },
    });
    expect(received).toEqual([]);
  });
});
