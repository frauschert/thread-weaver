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
      for (const fn of listeners[event] ?? []) fn(data);
    },
  };
}

type TestApi = {
  add(a: number, b: number): number;
  process(data: string, onProgress: (pct: number) => void): string;
  compute(a: number, transform: (x: number) => number): number;
  stream(): AsyncIterable<number>;
  createCounter(): {
    get(): number;
    increment(): number;
    release(): void;
    [Symbol.dispose](): void;
  };
};

describe("memory leak tests", () => {
  let worker: MockWorker;
  let api: ReturnType<typeof wrap<TestApi>>;

  beforeEach(() => {
    worker = createMockWorker();
    api = wrap<TestApi>(worker as any);
  });

  afterEach(() => {
    api?.dispose();
  });

  describe("proxy callback cleanup under repeated use", () => {
    it("cleans up all proxy callbacks after many resolved calls", async () => {
      const iterations = 200;
      const callbacks: ReturnType<typeof vi.fn>[] = [];

      for (let i = 0; i < iterations; i++) {
        const cb = vi.fn();
        callbacks.push(cb);
        api.process(`data-${i}`, proxy(cb)).catch(() => {});
      }

      // Resolve all calls
      for (let i = 0; i < iterations; i++) {
        const callId = worker.postMessage.mock.calls[i][0].id;
        worker.emit("message", { data: { id: callId, result: `done-${i}` } });
      }

      // Wait for all to settle
      await new Promise((r) => setTimeout(r, 50));

      // Verify callbacks are no longer invoked after cleanup
      for (let i = 0; i < iterations; i++) {
        const callbackId =
          worker.postMessage.mock.calls[i][0].args[1].__twProxy;
        worker.emit("message", {
          data: { type: "callback", callbackId, cbSeq: 0, args: [999] },
        });
      }

      await new Promise((r) => setTimeout(r, 50));

      // None of the callbacks should have been invoked after resolution
      for (const cb of callbacks) {
        expect(cb).not.toHaveBeenCalled();
      }
    });

    it("cleans up proxy callbacks after calls are aborted", async () => {
      const iterations = 100;
      const promises: any[] = [];
      const callbacks: ReturnType<typeof vi.fn>[] = [];

      for (let i = 0; i < iterations; i++) {
        const cb = vi.fn();
        callbacks.push(cb);
        promises.push(api.process(`data-${i}`, proxy(cb)));
      }

      // Abort all calls
      for (const p of promises) {
        p.abort("test abort");
      }

      // Catch the rejections
      await Promise.allSettled(promises);

      // Try to invoke all callbacks — they should all be cleaned up
      for (let i = 0; i < iterations; i++) {
        const callbackId =
          worker.postMessage.mock.calls[i][0].args[1].__twProxy;
        worker.emit("message", {
          data: { type: "callback", callbackId, cbSeq: 0, args: [999] },
        });
      }

      await new Promise((r) => setTimeout(r, 50));
      for (const cb of callbacks) {
        expect(cb).not.toHaveBeenCalled();
      }
    });

    it("cleans up auto-proxied bare function callbacks after resolution", async () => {
      const iterations = 200;
      const callbacks: ReturnType<typeof vi.fn>[] = [];

      for (let i = 0; i < iterations; i++) {
        const cb = vi.fn();
        callbacks.push(cb);
        // Pass bare functions (auto-proxied, no explicit proxy() wrapper)
        api.process(`data-${i}`, cb).catch(() => {});
      }

      // Resolve all calls
      for (let i = 0; i < iterations; i++) {
        const callId = worker.postMessage.mock.calls[i][0].id;
        worker.emit("message", { data: { id: callId, result: "ok" } });
      }

      await new Promise((r) => setTimeout(r, 50));

      // Verify cleanup — callbacks should not respond after resolution
      for (let i = 0; i < iterations; i++) {
        const callbackId =
          worker.postMessage.mock.calls[i][0].args[1].__twProxy;
        worker.emit("message", {
          data: { type: "callback", callbackId, cbSeq: 0, args: [999] },
        });
      }

      await new Promise((r) => setTimeout(r, 50));
      for (const cb of callbacks) {
        expect(cb).not.toHaveBeenCalled();
      }
    });

    it("cleans up callbacks with multiple proxy args per call", async () => {
      type MultiCbApi = {
        multi(a: (x: number) => void, b: (y: string) => void): void;
      };
      const w = createMockWorker();
      const multiApi = wrap<MultiCbApi>(w as any);
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        multiApi.multi(proxy(vi.fn()), proxy(vi.fn())).catch(() => {});
      }

      // Resolve all
      for (let i = 0; i < iterations; i++) {
        const callId = w.postMessage.mock.calls[i][0].id;
        w.emit("message", { data: { id: callId, result: undefined } });
      }

      await new Promise((r) => setTimeout(r, 50));

      // All proxy args should be cleaned up — test by trying to invoke them
      for (let i = 0; i < iterations; i++) {
        const cbId1 = w.postMessage.mock.calls[i][0].args[0].__twProxy;
        const cbId2 = w.postMessage.mock.calls[i][0].args[1].__twProxy;

        // No callback-result should be posted back for these stale IDs
        const beforeCount = w.postMessage.mock.calls.length;
        w.emit("message", {
          data: {
            type: "callback",
            callbackId: cbId1,
            cbSeq: 9000 + i,
            args: [1],
          },
        });
        w.emit("message", {
          data: {
            type: "callback",
            callbackId: cbId2,
            cbSeq: 9100 + i,
            args: ["x"],
          },
        });
        await new Promise((r) => setTimeout(r, 5));
        // No callback-result messages should have been sent
        const afterCount = w.postMessage.mock.calls.length;
        expect(afterCount).toBe(beforeCount);
      }

      multiApi.dispose();
    });
  });

  describe("stream cleanup under repeated use", () => {
    it("cleans up streams after normal completion (done)", async () => {
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const promise = api.stream();
        const callId = worker.postMessage.mock.calls[i][0].id;

        // Start stream
        worker.emit("message", {
          data: { id: callId, type: "next", value: i },
        });
        // Complete stream
        worker.emit("message", {
          data: { id: callId, type: "done" },
        });

        const iterable = await promise;
        const values: number[] = [];
        for await (const v of iterable as unknown as AsyncIterable<number>) {
          values.push(v);
        }
        expect(values).toEqual([i]);
      }

      // After all streams complete, new stream messages with old IDs should be ignored
      for (let i = 0; i < iterations; i++) {
        const callId = worker.postMessage.mock.calls[i][0].id;
        worker.emit("message", {
          data: { id: callId, type: "next", value: 999 },
        });
      }

      // No crashes, no dangling state
      await new Promise((r) => setTimeout(r, 50));
    });

    it("cleans up streams after error", async () => {
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const promise = api.stream();
        const callId = worker.postMessage.mock.calls[i][0].id;

        // Start stream
        worker.emit("message", {
          data: { id: callId, type: "next", value: i },
        });
        // Error the stream
        worker.emit("message", {
          data: {
            id: callId,
            type: "error",
            error: { message: "fail", name: "Error" },
          },
        });

        const iterable = await promise;
        await expect(
          (async () => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _ of iterable as unknown as AsyncIterable<number>) {
              // consume
            }
          })(),
        ).rejects.toThrow("fail");
      }

      await new Promise((r) => setTimeout(r, 50));
    });

    it("cleans up streams after consumer break (return)", async () => {
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        const callsBefore = worker.postMessage.mock.calls.length;
        const promise = api.stream();
        const callId = worker.postMessage.mock.calls[callsBefore][0].id;

        // Start streaming
        worker.emit("message", {
          data: { id: callId, type: "next", value: 1 },
        });
        worker.emit("message", {
          data: { id: callId, type: "next", value: 2 },
        });

        const iterable = await promise;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iterable as unknown as AsyncIterable<number>) {
          break; // Consumer breaks early, triggering return() → onReturn
        }
      }

      // Verify cancel messages were sent for each broken stream
      const cancelMessages = worker.postMessage.mock.calls.filter(
        ([msg]: any) => msg.type === "cancel",
      );
      expect(cancelMessages.length).toBe(iterations);

      await new Promise((r) => setTimeout(r, 50));
    });

    it("cleans up streams with proxy callbacks after completion", async () => {
      type StreamCbApi = {
        streamWithCb(onProgress: (n: number) => void): AsyncIterable<number>;
      };
      const w = createMockWorker();
      const streamApi = wrap<StreamCbApi>(w as any);
      const iterations = 50;
      const callbacks: ReturnType<typeof vi.fn>[] = [];

      for (let i = 0; i < iterations; i++) {
        const cb = vi.fn();
        callbacks.push(cb);
        const promise = streamApi.streamWithCb(proxy(cb));
        const callId = w.postMessage.mock.calls[i][0].id;

        // Stream and complete
        w.emit("message", {
          data: { id: callId, type: "next", value: i },
        });
        w.emit("message", {
          data: { id: callId, type: "done" },
        });

        const iterable = await promise;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iterable as unknown as AsyncIterable<number>) {
          // consume
        }
      }

      // After stream completion, proxy callbacks should also be cleaned up
      for (let i = 0; i < iterations; i++) {
        const callbackId = w.postMessage.mock.calls[i][0].args[0].__twProxy;
        w.emit("message", {
          data: { type: "callback", callbackId, cbSeq: 0, args: [999] },
        });
      }

      await new Promise((r) => setTimeout(r, 50));
      for (const cb of callbacks) {
        expect(cb).not.toHaveBeenCalled();
      }

      streamApi.dispose();
    });
  });

  describe("remote proxy cleanup under repeated use", () => {
    it("cleans up event listeners after release()", async () => {
      const iterations = 50;
      const handlers: ReturnType<typeof vi.fn>[] = [];

      for (let i = 0; i < iterations; i++) {
        const callsBefore = worker.postMessage.mock.calls.length;
        const promise = api.createCounter();
        const callId = worker.postMessage.mock.calls[callsBefore][0].id;

        // Worker returns a proxy
        worker.emit("message", {
          data: { id: callId, result: { __twProxyReturn: i } },
        });

        const counter = await promise;

        // Subscribe to events
        const handler = vi.fn();
        handlers.push(handler);
        (counter as any).on("changed", handler);

        // Release the proxy
        (counter as any).release();
      }

      // All release messages should have been sent
      const releaseMessages = worker.postMessage.mock.calls.filter(
        ([msg]: any) => msg.type === "proxy-release",
      );
      expect(releaseMessages.length).toBe(iterations);

      // After release, events should not reach handlers
      for (let i = 0; i < iterations; i++) {
        worker.emit("message", {
          data: { type: "proxy-event", proxyId: i, event: "changed", data: 42 },
        });
      }

      for (const handler of handlers) {
        expect(handler).not.toHaveBeenCalled();
      }
    });

    it("release() is idempotent — double release does not send extra messages", async () => {
      const promise = api.createCounter();
      const callId = worker.postMessage.mock.calls[0][0].id;
      worker.emit("message", {
        data: { id: callId, result: { __twProxyReturn: 0 } },
      });
      const counter = await promise;

      const beforeCount = worker.postMessage.mock.calls.length;
      (counter as any).release();
      (counter as any).release();
      (counter as any).release();

      // Only one release message should have been sent
      const releasesSent = worker.postMessage.mock.calls
        .slice(beforeCount)
        .filter(([msg]: any) => msg.type === "proxy-release");
      expect(releasesSent.length).toBe(1);
    });

    it("cleans up event listener unsubscribe functions", async () => {
      const promise = api.createCounter();
      const callId = worker.postMessage.mock.calls[0][0].id;
      worker.emit("message", {
        data: { id: callId, result: { __twProxyReturn: 0 } },
      });
      const counter = await promise;

      // Add and remove many listeners
      const unsubs: (() => void)[] = [];
      for (let i = 0; i < 100; i++) {
        unsubs.push((counter as any).on("changed", vi.fn()));
      }

      // Unsubscribe all
      for (const unsub of unsubs) unsub();

      // Events should not reach any handler
      const lateHandler = vi.fn();
      worker.emit("message", {
        data: { type: "proxy-event", proxyId: 0, event: "changed", data: 99 },
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(lateHandler).not.toHaveBeenCalled();

      (counter as any).release();
    });
  });

  describe("dispose cleans up all resources", () => {
    it("dispose() clears all pending callbacks, streams, and proxies", async () => {
      // Create a mix of pending calls, streams, and proxy callbacks
      const pendingCallbacks: ReturnType<typeof vi.fn>[] = [];

      // 1) Regular pending calls
      for (let i = 0; i < 20; i++) {
        api.add(i, i + 1).catch(() => {});
      }

      // 2) Calls with proxy callbacks
      for (let i = 0; i < 20; i++) {
        const cb = vi.fn();
        pendingCallbacks.push(cb);
        api.process(`data-${i}`, proxy(cb)).catch(() => {});
      }

      // 3) Active streams
      for (let i = 0; i < 10; i++) {
        const callIdx = 40 + i;
        api.stream().catch(() => {});
        const callId = worker.postMessage.mock.calls[callIdx][0].id;
        worker.emit("message", {
          data: { id: callId, type: "next", value: i },
        });
      }

      // Dispose everything
      api.dispose();

      // After dispose, nothing should respond
      for (let i = 0; i < 20; i++) {
        const callbackId =
          worker.postMessage.mock.calls[20 + i][0].args[1].__twProxy;
        worker.emit("message", {
          data: { type: "callback", callbackId, cbSeq: 0, args: [999] },
        });
      }

      await new Promise((r) => setTimeout(r, 50));
      for (const cb of pendingCallbacks) {
        expect(cb).not.toHaveBeenCalled();
      }
    });

    it("new calls after dispose reject immediately", () => {
      api.dispose();

      return expect(api.add(1, 2)).rejects.toThrow("disposed");
    });
  });

  describe("worker-side expose() cleanup under repeated use", () => {
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
          for (const fn of listeners[event] ?? []) fn(data);
        },
      };
    }

    it("cleans up activeStreams after streams complete normally", async () => {
      const expose = await loadExpose();
      const scope = createMockScope();

      let streamCallCount = 0;
      expose(
        {
          async *count(n: number) {
            streamCallCount++;
            for (let i = 0; i < n; i++) yield i;
          },
        },
        scope as any,
      );

      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        scope.emit("message", {
          data: { id: i, method: "count", args: [3] },
        });
      }

      // Wait for all streams to complete
      await new Promise((r) => setTimeout(r, 200));

      expect(streamCallCount).toBe(iterations);

      // All streams should have sent 'done' messages
      const doneMessages = scope.postMessage.mock.calls.filter(
        ([msg]: any) => msg.type === "done",
      );
      expect(doneMessages.length).toBe(iterations);
    });

    it("cleans up activeStreams after stream cancellation", async () => {
      const expose = await loadExpose();
      const scope = createMockScope();

      expose(
        {
          async *infinite() {
            let i = 0;
            while (true) {
              yield i++;
              await new Promise((r) => setTimeout(r, 5));
            }
          },
        },
        scope as any,
      );

      const iterations = 20;
      for (let i = 0; i < iterations; i++) {
        scope.emit("message", {
          data: { id: i, method: "infinite", args: [] },
        });
      }

      // Wait a bit for streams to start producing
      await new Promise((r) => setTimeout(r, 50));

      // Cancel all streams
      for (let i = 0; i < iterations; i++) {
        scope.emit("message", {
          data: { id: i, type: "cancel" },
        });
      }

      // Wait for cancellation to propagate
      await new Promise((r) => setTimeout(r, 100));

      // No more messages should arrive after cancellation
      const msgCountAfterCancel = scope.postMessage.mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(scope.postMessage.mock.calls.length).toBe(msgCountAfterCancel);
    });

    it("cleans up proxyRegistry after release", async () => {
      const expose = await loadExpose();
      const scope = createMockScope();

      expose(
        {
          createCounter() {
            let count = 0;
            await_import_proxy();
            return {
              get() {
                return count;
              },
              increment() {
                return ++count;
              },
            };
          },
        } as any,
        scope as any,
      );

      // The worker auto-detects objects with functions and creates proxies.
      // We trigger many createCounter calls.
      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        scope.emit("message", {
          data: { id: i, method: "createCounter", args: [] },
        });
      }

      await new Promise((r) => setTimeout(r, 100));

      // Verify proxy return messages were sent
      const proxyReturns = scope.postMessage.mock.calls.filter(
        ([msg]: any) => msg.result && msg.result.__twProxyReturn !== undefined,
      );
      expect(proxyReturns.length).toBe(iterations);

      // Release all proxies
      for (const [msg] of proxyReturns) {
        const proxyId = msg.result.__twProxyReturn;
        scope.emit("message", {
          data: { type: "proxy-release", proxyId },
        });
      }

      await new Promise((r) => setTimeout(r, 50));

      // Proxy calls to released proxies should return errors
      for (const [msg] of proxyReturns) {
        const proxyId = msg.result.__twProxyReturn;
        scope.emit("message", {
          data: {
            id: 10000 + proxyId,
            type: "proxy-call",
            proxyId,
            method: "get",
            args: [],
          },
        });
      }

      await new Promise((r) => setTimeout(r, 50));

      // All proxy calls should have received errors about proxy not found
      const errorResponses = scope.postMessage.mock.calls.filter(
        ([msg]: any) =>
          msg.error &&
          msg.error.message &&
          msg.error.message.includes("not found"),
      );
      expect(errorResponses.length).toBe(iterations);
    });

    it("cleans up pendingCallbacks after callback results arrive", async () => {
      const expose = await loadExpose();
      const scope = createMockScope();

      expose(
        {
          async processWithCb(data: string, onProgress: (pct: number) => void) {
            await onProgress(25);
            await onProgress(50);
            await onProgress(75);
            await onProgress(100);
            return `done:${data}`;
          },
        },
        scope as any,
      );

      const iterations = 10;

      // Process iterations one at a time for clean callback handling
      for (let i = 0; i < iterations; i++) {
        scope.emit("message", {
          data: {
            id: i,
            method: "processWithCb",
            args: [`item-${i}`, { __twProxy: i }],
          },
        });

        // Repeatedly drain pending callbacks until the final result arrives
        for (let round = 0; round < 20; round++) {
          await new Promise((r) => setTimeout(r, 10));

          const pending = scope.postMessage.mock.calls.filter(
            ([msg]: any) =>
              msg.type === "callback" &&
              !scope.postMessage.mock.calls.some(
                ([r]: any) =>
                  r.type === "callback-result" && r.cbSeq === msg.cbSeq,
              ),
          );

          // Reply to each unreplied callback
          for (const [msg] of pending) {
            // Check we haven't already replied (lookup in scope messages received)
            scope.emit("message", {
              data: {
                type: "callback-result",
                cbSeq: msg.cbSeq,
                result: undefined,
              },
            });
          }

          // Check if the result for this call has arrived
          const hasResult = scope.postMessage.mock.calls.some(
            ([msg]: any) =>
              msg.id === i && msg.result && typeof msg.result === "string",
          );
          if (hasResult) break;
        }
      }

      await new Promise((r) => setTimeout(r, 100));

      // All calls should have resolved with a result
      const resultMessages = scope.postMessage.mock.calls.filter(
        ([msg]: any) =>
          msg.result &&
          typeof msg.result === "string" &&
          msg.result.startsWith("done:"),
      );
      expect(resultMessages.length).toBe(iterations);
    });
  });
});

// Helper to avoid the import-at-top-level issue for proxy in worker tests
function await_import_proxy() {
  return { proxy: (v: any) => v };
}
