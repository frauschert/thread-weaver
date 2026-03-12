import { describe, it, expect, vi, beforeEach } from "vitest";
import { transfer } from "../src/transfer";

// We need to simulate the worker's `self` environment to test expose().
// expose() calls self.addEventListener and self.postMessage, so we mock those.

function createWorkerScope() {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  const scope = {
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

  return scope;
}

describe("expose", () => {
  let scope: ReturnType<typeof createWorkerScope>;

  beforeEach(() => {
    scope = createWorkerScope();
    // Set up `self` to point to our mock scope
    vi.stubGlobal("self", scope);
  });

  async function loadExpose() {
    // Re-import to pick up the stubbed `self`
    const mod = await import("../src/worker");
    return mod.expose;
  }

  it("registers a message event listener", async () => {
    const expose = await loadExpose();
    expose({ add: (a: number, b: number) => a + b });

    expect(scope.addEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });

  it("calls the correct method and posts back the result", async () => {
    const expose = await loadExpose();
    expose({ add: (a: number, b: number) => a + b });

    scope.emit("message", { data: { id: 1, method: "add", args: [2, 3] } });

    // Give the async handler time to resolve
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith({ id: 1, result: 5 });
    });
  });

  it("handles async methods", async () => {
    const expose = await loadExpose();
    expose({
      asyncAdd: async (a: number, b: number) => a + b,
    });

    scope.emit("message", {
      data: { id: 1, method: "asyncAdd", args: [10, 20] },
    });

    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith({ id: 1, result: 30 });
    });
  });

  it("posts back an error when a method throws", async () => {
    const expose = await loadExpose();
    expose({
      fail: () => {
        throw new Error("Boom");
      },
    });

    scope.emit("message", { data: { id: 1, method: "fail", args: [] } });

    await vi.waitFor(() => {
      const call = scope.postMessage.mock.calls.find(
        ([msg]: any) => msg.id === 1 && msg.error,
      );
      expect(call).toBeDefined();
      expect(call![0].error.message).toBe("Boom");
      expect(call![0].error.name).toBe("Error");
      expect(call![0].error.stack).toBeDefined();
    });
  });

  it("posts back an error for non-Error throws", async () => {
    const expose = await loadExpose();
    expose({
      fail: () => {
        throw "string error";
      },
    });

    scope.emit("message", { data: { id: 1, method: "fail", args: [] } });

    await vi.waitFor(() => {
      const call = scope.postMessage.mock.calls.find(
        ([msg]: any) => msg.id === 1 && msg.error,
      );
      expect(call).toBeDefined();
      expect(call![0].error.message).toBe("string error");
    });
  });

  it("posts back an error for unknown methods", async () => {
    const expose = await loadExpose();
    expose({ add: (a: number, b: number) => a + b });

    scope.emit("message", { data: { id: 1, method: "nonexistent", args: [] } });

    await vi.waitFor(() => {
      const call = scope.postMessage.mock.calls.find(
        ([msg]: any) => msg.id === 1 && msg.error,
      );
      expect(call).toBeDefined();
      expect(call![0].error.message).toBe("Unknown method: nonexistent");
    });
  });

  it("rejects calls to inherited properties like constructor", async () => {
    const expose = await loadExpose();
    expose({ add: (a: number, b: number) => a + b });

    scope.emit("message", { data: { id: 1, method: "constructor", args: [] } });

    await vi.waitFor(() => {
      const call = scope.postMessage.mock.calls.find(
        ([msg]: any) => msg.id === 1 && msg.error,
      );
      expect(call).toBeDefined();
      expect(call![0].error.message).toBe("Unknown method: constructor");
    });
  });

  it("handles Transfer return values with transferables", async () => {
    const expose = await loadExpose();
    const buf = new ArrayBuffer(8);
    expose({
      getBuffer: () => transfer(buf, [buf]),
    });

    scope.emit("message", { data: { id: 1, method: "getBuffer", args: [] } });

    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith({ id: 1, result: buf }, [
        buf,
      ]);
    });
  });

  it("posts regular results without transferables", async () => {
    const expose = await loadExpose();
    expose({ double: (n: number) => n * 2 });

    scope.emit("message", { data: { id: 1, method: "double", args: [5] } });

    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith({ id: 1, result: 10 });
    });
  });
});
