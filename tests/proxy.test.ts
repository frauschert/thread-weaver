import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrap, proxy } from "../src/main";

type MockWorker = {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
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
    emit(event: string, data: any) {
      for (const fn of listeners[event] ?? []) {
        fn(data);
      }
    },
  };
}

type TestApi = {
  process(data: string, onProgress: (pct: number) => void): string;
  compute(a: number, b: number, transform: (x: number) => number): number;
};

describe("proxy() — bidirectional communication", () => {
  let worker: MockWorker;
  let api: ReturnType<typeof wrap<TestApi>>;

  beforeEach(() => {
    worker = createMockWorker();
    api = wrap<TestApi>(worker as any);
  });

  afterEach(() => {
    api?.dispose();
  });

  it("replaces proxy(fn) args with serializable markers in postMessage", () => {
    const cb = vi.fn();
    api.process("data", proxy(cb)).catch(() => {});

    const [payload] = worker.postMessage.mock.calls[0];
    expect(payload.method).toBe("process");
    expect(payload.args[0]).toBe("data");
    expect(payload.args[1]).toEqual({ __twProxy: expect.any(Number) });
  });

  it("auto-proxies bare function args without proxy() wrapper", () => {
    const cb = vi.fn();
    api.process("data", cb as any).catch(() => {});

    const [payload] = worker.postMessage.mock.calls[0];
    expect(payload.args[0]).toBe("data");
    expect(payload.args[1]).toEqual({ __twProxy: expect.any(Number) });
  });

  it("auto-proxied bare function is callable from worker", async () => {
    const cb = vi.fn().mockReturnValue("ok");
    api.process("data", cb as any).catch(() => {});

    const callbackId = worker.postMessage.mock.calls[0][0].args[1].__twProxy;

    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 0, args: [42] },
    });

    await vi.waitFor(() => {
      expect(cb).toHaveBeenCalledWith(42);
    });
  });

  it("invokes the proxied callback when worker sends a callback message", async () => {
    const cb = vi.fn();
    api.process("data", proxy(cb)).catch(() => {});

    const callbackId = worker.postMessage.mock.calls[0][0].args[1].__twProxy;

    // Worker invokes the callback
    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 0, args: [50] },
    });

    // Wait for the async callback handling
    await vi.waitFor(() => {
      expect(cb).toHaveBeenCalledWith(50);
    });
  });

  it("sends callback-result back to the worker after callback completes", async () => {
    const cb = vi.fn().mockReturnValue("ok");
    api.process("data", proxy(cb)).catch(() => {});

    const callbackId = worker.postMessage.mock.calls[0][0].args[1].__twProxy;

    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 0, args: [75] },
    });

    await vi.waitFor(() => {
      const resultMsg = worker.postMessage.mock.calls.find(
        ([msg]: any) => msg.type === "callback-result" && msg.cbSeq === 0,
      );
      expect(resultMsg).toBeDefined();
      expect(resultMsg![0].result).toBe("ok");
    });
  });

  it("sends callback error back to the worker when callback throws", async () => {
    const cb = vi.fn().mockImplementation(() => {
      throw new TypeError("callback failed");
    });
    api.process("data", proxy(cb)).catch(() => {});

    const callbackId = worker.postMessage.mock.calls[0][0].args[1].__twProxy;

    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 0, args: [100] },
    });

    await vi.waitFor(() => {
      const resultMsg = worker.postMessage.mock.calls.find(
        ([msg]: any) => msg.type === "callback-result" && msg.cbSeq === 0,
      );
      expect(resultMsg).toBeDefined();
      expect(resultMsg![0].error).toEqual({
        message: "callback failed",
        name: "TypeError",
        stack: expect.any(String),
      });
    });
  });

  it("supports multiple callback invocations", async () => {
    const cb = vi.fn();
    api.process("data", proxy(cb)).catch(() => {});

    const callbackId = worker.postMessage.mock.calls[0][0].args[1].__twProxy;

    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 0, args: [25] },
    });
    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 1, args: [50] },
    });
    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 2, args: [100] },
    });

    await vi.waitFor(() => {
      expect(cb).toHaveBeenCalledTimes(3);
      expect(cb).toHaveBeenNthCalledWith(1, 25);
      expect(cb).toHaveBeenNthCalledWith(2, 50);
      expect(cb).toHaveBeenNthCalledWith(3, 100);
    });
  });

  it("assigns unique callback IDs across calls", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    api.process("data1", proxy(cb1)).catch(() => {});
    api.process("data2", proxy(cb2)).catch(() => {});

    const id1 = worker.postMessage.mock.calls[0][0].args[1].__twProxy;
    const id2 = worker.postMessage.mock.calls[1][0].args[1].__twProxy;

    expect(id1).not.toBe(id2);
  });

  it("cleans up proxy callbacks when the call resolves", async () => {
    const cb = vi.fn();
    const promise = api.process("data", proxy(cb));

    const callbackId = worker.postMessage.mock.calls[0][0].args[1].__twProxy;
    const callId = worker.postMessage.mock.calls[0][0].id;

    // Resolve the call
    worker.emit("message", {
      data: { id: callId, result: "done" },
    });

    await promise;

    // After resolution, callback invocations should be ignored (function cleaned up)
    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 99, args: [100] },
    });

    // Give async handling a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("cleans up proxy callbacks on dispose", () => {
    const cb = vi.fn();
    api.process("data", proxy(cb)).catch(() => {});
    api.dispose();

    const callbackId = worker.postMessage.mock.calls[0][0].args[1].__twProxy;

    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 0, args: [50] },
    });

    // cb should not be called since the proxy was disposed
    expect(cb).not.toHaveBeenCalled();
  });

  it("works with async proxied callbacks", async () => {
    const cb = vi.fn().mockResolvedValue(42);
    api.compute(1, 2, proxy(cb) as any).catch(() => {});

    const callbackId = worker.postMessage.mock.calls[0][0].args[2].__twProxy;

    worker.emit("message", {
      data: { type: "callback", callbackId, cbSeq: 0, args: [10] },
    });

    await vi.waitFor(() => {
      const resultMsg = worker.postMessage.mock.calls.find(
        ([msg]: any) => msg.type === "callback-result" && msg.cbSeq === 0,
      );
      expect(resultMsg).toBeDefined();
      expect(resultMsg![0].result).toBe(42);
    });
  });
});

describe("proxy() — expose() side (worker)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadExpose() {
    const mod = await import("../src/worker");
    return mod.expose;
  }

  function createMockScope() {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    return {
      listeners,
      addEventListener: vi.fn(
        (event: string, handler: (...args: any[]) => void) => {
          (listeners[event] ??= []).push(handler);
        },
      ),
      postMessage: vi.fn(),
      emit(event: string, data: any) {
        for (const fn of listeners[event] ?? []) {
          fn(data);
        }
      },
    };
  }

  it("hydrates proxy markers into callable functions", async () => {
    const expose = await loadExpose();
    const scope = createMockScope();

    const receivedArgs: any[] = [];
    expose(
      {
        process(...args: any[]) {
          receivedArgs.push(...args);
          return "ok";
        },
      },
      scope as any,
    );

    scope.emit("message", {
      data: { id: 0, method: "process", args: ["data", { __twProxy: 42 }] },
    });

    await vi.waitFor(() => {
      expect(receivedArgs.length).toBeGreaterThanOrEqual(2);
    });

    // The second arg (before AbortSignal) should be a function
    expect(typeof receivedArgs[1]).toBe("function");
  });

  it("calls proxy stubs which send callback messages", async () => {
    const expose = await loadExpose();
    const scope = createMockScope();

    expose(
      {
        async process(
          _data: string,
          onProgress: (pct: number) => Promise<void>,
        ) {
          await onProgress(50);
          return "done";
        },
      },
      scope as any,
    );

    scope.emit("message", {
      data: { id: 0, method: "process", args: ["data", { __twProxy: 7 }] },
    });

    // The worker should send a callback message
    await vi.waitFor(() => {
      const callbackMsg = scope.postMessage.mock.calls.find(
        ([msg]: any) => msg.type === "callback",
      );
      expect(callbackMsg).toBeDefined();
      expect(callbackMsg![0]).toEqual({
        type: "callback",
        callbackId: 7,
        cbSeq: expect.any(Number),
        args: [50],
      });
    });
  });

  it("resolves proxy stub when callback-result arrives", async () => {
    const expose = await loadExpose();
    const scope = createMockScope();

    let callbackResult: any;
    expose(
      {
        async process(
          _data: string,
          transform: (x: number) => Promise<number>,
        ) {
          callbackResult = await transform(10);
          return "done";
        },
      },
      scope as any,
    );

    scope.emit("message", {
      data: { id: 0, method: "process", args: ["data", { __twProxy: 3 }] },
    });

    // Wait for the callback message
    await vi.waitFor(() => {
      const callbackMsg = scope.postMessage.mock.calls.find(
        ([msg]: any) => msg.type === "callback",
      );
      expect(callbackMsg).toBeDefined();
    });

    const callbackMsg = scope.postMessage.mock.calls.find(
      ([msg]: any) => msg.type === "callback",
    );
    const cbSeq = callbackMsg![0].cbSeq;

    // Send callback result back
    scope.emit("message", {
      data: { type: "callback-result", cbSeq, result: 100 },
    });

    await vi.waitFor(() => {
      expect(callbackResult).toBe(100);
    });
  });

  it("rejects proxy stub when callback-result has an error", async () => {
    const expose = await loadExpose();
    const scope = createMockScope();

    let callbackError: any;
    expose(
      {
        async process(
          _data: string,
          transform: (x: number) => Promise<number>,
        ) {
          try {
            await transform(10);
          } catch (err) {
            callbackError = err;
          }
          return "done";
        },
      },
      scope as any,
    );

    scope.emit("message", {
      data: { id: 0, method: "process", args: ["data", { __twProxy: 5 }] },
    });

    await vi.waitFor(() => {
      const callbackMsg = scope.postMessage.mock.calls.find(
        ([msg]: any) => msg.type === "callback",
      );
      expect(callbackMsg).toBeDefined();
    });

    const callbackMsg = scope.postMessage.mock.calls.find(
      ([msg]: any) => msg.type === "callback",
    );
    const cbSeq = callbackMsg![0].cbSeq;

    // Send callback error back
    scope.emit("message", {
      data: {
        type: "callback-result",
        cbSeq,
        error: { message: "nope", name: "Error" },
      },
    });

    await vi.waitFor(() => {
      expect(callbackError).toBeInstanceOf(Error);
      expect(callbackError.message).toBe("nope");
    });
  });
});
