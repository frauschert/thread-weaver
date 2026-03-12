import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrap } from "../src/main";

type MockEndpoint = {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  listeners: Record<string, ((...args: any[]) => void)[]>;
  emit: (event: string, data: any) => void;
};

/** Creates a mock MessagePort-like endpoint (has start()). */
function createMockPort(): MockEndpoint {
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
    start: vi.fn(),
    emit(event: string, data: any) {
      for (const fn of listeners[event] ?? []) {
        fn(data);
      }
    },
  };
}

describe("MessagePort / MessageEndpoint support", () => {
  describe("wrap() with MessagePort-like endpoint", () => {
    let port: MockEndpoint;

    beforeEach(() => {
      port = createMockPort();
    });

    it("calls start() on the endpoint", () => {
      wrap(port as any);
      expect(port.start).toHaveBeenCalledOnce();
    });

    it("sends postMessage through the endpoint", () => {
      const api = wrap<{ add(a: number, b: number): number }>(port as any);
      api.add(1, 2);

      expect(port.postMessage).toHaveBeenCalledTimes(1);
      const [payload] = port.postMessage.mock.calls[0];
      expect(payload).toEqual({ id: 0, method: "add", args: [1, 2] });
    });

    it("receives responses through the endpoint", async () => {
      const api = wrap<{ add(a: number, b: number): number }>(port as any);
      const promise = api.add(2, 3);

      port.emit("message", { data: { id: 0, result: 5 } });

      await expect(promise).resolves.toBe(5);
    });

    it("cleans up listeners on dispose", () => {
      const api = wrap<{ add(a: number, b: number): number }>(port as any);
      api.dispose();

      expect(port.removeEventListener).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
    });
  });

  describe("expose() with explicit endpoint", () => {
    let port: MockEndpoint;

    beforeEach(() => {
      port = createMockPort();
      vi.resetModules();
    });

    async function loadExpose() {
      const mod = await import("../src/worker");
      return mod.expose;
    }

    it("calls start() on the endpoint", async () => {
      const expose = await loadExpose();
      expose({ add: (a: number, b: number) => a + b }, port as any);

      expect(port.start).toHaveBeenCalledOnce();
    });

    it("listens for messages on the endpoint instead of self", async () => {
      const expose = await loadExpose();
      expose({ add: (a: number, b: number) => a + b }, port as any);

      expect(port.addEventListener).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
    });

    it("responds through the endpoint", async () => {
      const expose = await loadExpose();
      expose({ add: (a: number, b: number) => a + b }, port as any);

      port.emit("message", {
        data: { id: 0, method: "add", args: [1, 2] },
      });

      // Wait for async processing
      await vi.waitFor(() => {
        expect(port.postMessage).toHaveBeenCalledWith({ id: 0, result: 3 });
      });
    });

    it("allows multiple expose() calls with different endpoints", async () => {
      const expose = await loadExpose();
      const port2 = createMockPort();

      expose({ add: (a: number, b: number) => a + b }, port as any);
      // Should NOT throw — different endpoint
      expect(() => {
        expose({ multiply: (a: number, b: number) => a * b }, port2 as any);
      }).not.toThrow();
    });
  });

  describe("pool() with MessageEndpoint factory", () => {
    it("uses destroyEndpoint for non-Worker endpoints", async () => {
      const { pool } = await import("../src/pool");

      const ports = Array.from({ length: 2 }, () => createMockPort());
      let idx = 0;
      const p = pool<{ add(a: number, b: number): number }>(
        () => ports[idx++] as any,
        { size: 2 },
      );

      // All ports should have start() called
      expect(ports[0].start).toHaveBeenCalledOnce();
      expect(ports[1].start).toHaveBeenCalledOnce();

      p.terminate();
    });
  });

  describe("wrap() without start() (plain Worker-like)", () => {
    it("works without start() method", () => {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const endpoint = {
        addEventListener: vi.fn(
          (event: string, handler: (...args: any[]) => void) => {
            (listeners[event] ??= []).push(handler);
          },
        ),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        // No start() method — like a regular Worker
      };

      // Should not throw even without start()
      const api = wrap<{ add(a: number, b: number): number }>(endpoint as any);
      api.add(1, 2);
      expect(endpoint.postMessage).toHaveBeenCalledTimes(1);
    });
  });
});
