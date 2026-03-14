import { describe, it, expect, vi, beforeEach } from "vitest";

// ── connectServiceWorker tests ────────────────────────────────────────

describe("connectServiceWorker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function createMockRegistration(
    state: "activated" | "installing" = "activated",
  ) {
    const sw = {
      state: state as string,
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    return {
      registration: {
        active: state === "activated" ? sw : null,
        installing: state === "installing" ? sw : null,
        waiting: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      sw,
    };
  }

  it("creates a MessageChannel and sends handshake to active SW", async () => {
    const { registration, sw } = createMockRegistration();

    // Intercept MessageChannel to capture ports
    let capturedPort1: any;
    const OrigChannel = globalThis.MessageChannel;
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1: any;
        port2: any;
        constructor() {
          const channel = new OrigChannel();
          this.port1 = channel.port1;
          this.port2 = channel.port2;
          capturedPort1 = this.port1;
        }
      },
    );

    const { connectServiceWorker } = await import("../src/service-worker");

    const promise = connectServiceWorker(registration as any);

    // Wait for the async getActiveSW to resolve
    await vi.waitFor(() => {
      expect(sw.postMessage).toHaveBeenCalledWith(
        { type: "__tw_connect" },
        expect.any(Array),
      );
    });

    // Simulate ack from SW on port1
    capturedPort1!.dispatchEvent(
      new MessageEvent("message", { data: { type: "__tw_connect_ack" } }),
    );

    const port = await promise;
    expect(port).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("rejects after timeout if SW never acks", async () => {
    vi.useFakeTimers();
    const { registration } = createMockRegistration();

    const { connectServiceWorker } = await import("../src/service-worker");

    const promise = connectServiceWorker(registration as any, { timeout: 100 });

    // Attach the rejection handler BEFORE advancing timers
    const result = promise.then(
      () => {
        throw new Error("should have rejected");
      },
      (err: Error) => err,
    );

    // Flush the microtask from getActiveSW before advancing timers
    await vi.advanceTimersByTimeAsync(100);

    const err = await result;
    expect(err.message).toMatch(/timed out/);

    vi.useRealTimers();
  });

  it("waits for installing SW to activate", async () => {
    const { registration, sw } = createMockRegistration("installing");

    const { connectServiceWorker } = await import("../src/service-worker");

    // Intercept the port
    let capturedPort1: any;
    const OrigChannel = globalThis.MessageChannel;
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1: any;
        port2: any;
        constructor() {
          const channel = new OrigChannel();
          this.port1 = channel.port1;
          this.port2 = channel.port2;
          capturedPort1 = this.port1;
        }
      },
    );

    const promise = connectServiceWorker(registration as any);

    // Let the getActiveSW promise chain start
    await Promise.resolve();

    // SW transitions to activated — fire the statechange callback
    expect(sw.addEventListener).toHaveBeenCalledWith(
      "statechange",
      expect.any(Function),
    );
    const stateChangeCb = sw.addEventListener.mock.calls.find(
      ([type]: any) => type === "statechange",
    )![1];
    sw.state = "activated";
    stateChangeCb();

    // Wait for the handshake to be sent (async)
    await vi.waitFor(() => {
      expect(sw.postMessage).toHaveBeenCalledWith(
        { type: "__tw_connect" },
        expect.any(Array),
      );
    });

    // Ack
    capturedPort1!.dispatchEvent(
      new MessageEvent("message", { data: { type: "__tw_connect_ack" } }),
    );

    const port = await promise;
    expect(port).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("rejects if SW becomes redundant", async () => {
    const { registration, sw } = createMockRegistration("installing");

    const { connectServiceWorker } = await import("../src/service-worker");

    const promise = connectServiceWorker(registration as any);

    const stateChangeCb = sw.addEventListener.mock.calls.find(
      ([type]: any) => type === "statechange",
    )![1];
    sw.state = "redundant";
    stateChangeCb();

    await expect(promise).rejects.toThrow("redundant");
  });

  it("rejects if no SW found in registration", async () => {
    const registration = {
      active: null,
      installing: null,
      waiting: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const { connectServiceWorker } = await import("../src/service-worker");

    await expect(connectServiceWorker(registration as any)).rejects.toThrow(
      "No Service Worker found",
    );
  });
});

// ── exposeServiceWorker tests ─────────────────────────────────────────

describe("exposeServiceWorker", () => {
  let scope: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    emit: (event: string, data: any) => void;
  };

  beforeEach(() => {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    scope = {
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
            if (idx >= 0) arr.splice(idx, 1);
          }
        },
      ),
      emit(event: string, data: any) {
        for (const fn of listeners[event] ?? []) fn(data);
      },
    };
    vi.stubGlobal("self", scope);
    vi.resetModules();
  });

  it("listens for handshake messages", async () => {
    const { exposeServiceWorker } = await import("../src/service-worker");
    exposeServiceWorker({ add: (a: number, b: number) => a + b });

    expect(scope.addEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });

  it("calls expose on the port when handshake arrives", async () => {
    const { exposeServiceWorker } = await import("../src/service-worker");
    const api = { add: (a: number, b: number) => a + b };
    exposeServiceWorker(api);

    // Create a real MessageChannel and send port
    const { port1, port2 } = new MessageChannel();
    const postMessageSpy = vi.spyOn(port2, "postMessage");

    scope.emit("message", {
      data: { type: "__tw_connect" },
      ports: [port2],
    });

    // Should have sent ack on the port
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: "__tw_connect_ack",
    });

    port1.close();
    port2.close();
  });

  it("ignores non-handshake messages", async () => {
    const { exposeServiceWorker } = await import("../src/service-worker");
    exposeServiceWorker({ noop: () => {} });

    // Should not throw
    scope.emit("message", { data: { type: "something_else" }, ports: [] });
    scope.emit("message", { data: "plain string", ports: [] });
  });

  it("cleanup function removes the listener", async () => {
    const { exposeServiceWorker } = await import("../src/service-worker");
    const cleanup = exposeServiceWorker({ noop: () => {} });

    cleanup();

    expect(scope.removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });
});

// ── broadcast tests ───────────────────────────────────────────────────

describe("broadcast", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("posts message to all window clients", async () => {
    const client1 = { postMessage: vi.fn() };
    const client2 = { postMessage: vi.fn() };

    vi.stubGlobal("self", {
      clients: {
        matchAll: vi.fn().mockResolvedValue([client1, client2]),
      },
    });

    const { broadcast } = await import("../src/service-worker");

    await broadcast({ update: true });

    expect(client1.postMessage).toHaveBeenCalledWith({
      __tw_broadcast: true,
      data: { update: true },
    });
    expect(client2.postMessage).toHaveBeenCalledWith({
      __tw_broadcast: true,
      data: { update: true },
    });
  });

  it("handles zero clients gracefully", async () => {
    vi.stubGlobal("self", {
      clients: {
        matchAll: vi.fn().mockResolvedValue([]),
      },
    });

    const { broadcast } = await import("../src/service-worker");

    // Should not throw
    await broadcast("hello");
  });
});

// ── onBroadcast tests ─────────────────────────────────────────────────

describe("onBroadcast", () => {
  let swContainer: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    emit: (event: string, data: any) => void;
  };

  beforeEach(() => {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    swContainer = {
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
            if (idx >= 0) arr.splice(idx, 1);
          }
        },
      ),
      emit(event: string, data: any) {
        for (const fn of listeners[event] ?? []) fn(data);
      },
    };
    vi.stubGlobal("navigator", { serviceWorker: swContainer });
    vi.resetModules();
  });

  it("calls handler for broadcast messages", async () => {
    const { onBroadcast } = await import("../src/service-worker");
    const handler = vi.fn();

    onBroadcast(handler);

    swContainer.emit("message", {
      data: { __tw_broadcast: true, data: { version: 2 } },
    });

    expect(handler).toHaveBeenCalledWith({ version: 2 });
  });

  it("ignores non-broadcast messages", async () => {
    const { onBroadcast } = await import("../src/service-worker");
    const handler = vi.fn();

    onBroadcast(handler);

    swContainer.emit("message", { data: { type: "something" } });
    swContainer.emit("message", { data: "plain" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribe stops calling the handler", async () => {
    const { onBroadcast } = await import("../src/service-worker");
    const handler = vi.fn();

    const unsub = onBroadcast(handler);
    unsub();

    swContainer.emit("message", {
      data: { __tw_broadcast: true, data: "after" },
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
