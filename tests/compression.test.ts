import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveCompression,
  compressMessage,
  isCompressed,
  decompressMessage,
} from "../src/compression";
import { wrap } from "../src/main";

describe("resolveCompression", () => {
  it("returns null for undefined", () => {
    expect(resolveCompression(undefined)).toBeNull();
  });

  it("returns null for false", () => {
    expect(resolveCompression(false)).toBeNull();
  });

  it("returns default threshold for true", () => {
    expect(resolveCompression(true)).toEqual({ threshold: 1024 });
  });

  it("uses custom threshold", () => {
    expect(resolveCompression({ threshold: 512 })).toEqual({ threshold: 512 });
  });

  it("defaults threshold to 1024 when not specified in object", () => {
    expect(resolveCompression({})).toEqual({ threshold: 1024 });
  });
});

describe("isCompressed", () => {
  it("returns true for compressed envelope", () => {
    expect(isCompressed({ __twCompressed: new ArrayBuffer(0) })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isCompressed(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isCompressed(undefined)).toBe(false);
  });

  it("returns false for plain objects", () => {
    expect(isCompressed({ id: 1, type: "call" })).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isCompressed(42)).toBe(false);
    expect(isCompressed("hello")).toBe(false);
  });
});

describe("compressMessage / decompressMessage", () => {
  const opts = { threshold: 10 };

  it("passes through messages below the threshold", async () => {
    const msg = { id: 1 };
    const { data, transfer } = await compressMessage(msg, opts);
    expect(data).toEqual(msg);
    expect(transfer).toBeUndefined();
  });

  it("compresses messages above the threshold", async () => {
    const msg = { id: 1, payload: "a".repeat(100) };
    const { data, transfer } = await compressMessage(msg, opts);
    expect(isCompressed(data)).toBe(true);
    expect(data.__twCompressed).toBeInstanceOf(ArrayBuffer);
    expect(transfer).toHaveLength(1);
    expect(transfer![0]).toBe(data.__twCompressed);
  });

  it("round-trips through compress and decompress", async () => {
    const msg = { id: 42, method: "add", args: [1, "a".repeat(200)] };
    const { data } = await compressMessage(msg, opts);
    expect(isCompressed(data)).toBe(true);

    const restored = await decompressMessage(data);
    expect(restored).toEqual(msg);
  });

  it("uses threshold boundary correctly", async () => {
    // JSON.stringify({ x: "aaa" }) is 11 chars — above threshold 10
    const above = { x: "aaa" };
    const { data: aboveData } = await compressMessage(above, opts);
    expect(isCompressed(aboveData)).toBe(true);

    // JSON.stringify({ x: 1 }) is 7 chars — below threshold 10
    const below = { x: 1 };
    const { data: belowData } = await compressMessage(below, opts);
    expect(isCompressed(belowData)).toBe(false);
    expect(belowData).toEqual(below);
  });
});

describe("wrap with compression", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("compresses outgoing messages when enabled and above threshold", async () => {
    const w = createMockWorker();
    const api = wrap<{ big(s: string): string }>(w as any, {
      compression: { threshold: 10 },
    });

    const callPromise = api.big("x".repeat(200));

    // wait for async send
    await vi.waitFor(() => {
      expect(w.postMessage).toHaveBeenCalled();
    });

    const [payload, transferables] = w.postMessage.mock.calls[0];
    expect(isCompressed(payload)).toBe(true);
    expect(payload.__twCompressed).toBeInstanceOf(ArrayBuffer);
    expect(transferables).toContain(payload.__twCompressed);

    // respond to avoid dangling promise
    const decompressed = await decompressMessage(payload);
    w.emit("message", { data: { id: decompressed.id, result: "ok" } });
    await callPromise;
  });

  it("does not compress when payload is below threshold", async () => {
    const w = createMockWorker();
    const api = wrap<{ small(a: number, b: number): number }>(w as any, {
      compression: { threshold: 10000 },
    });

    const callPromise = api.small(1, 2);

    await vi.waitFor(() => {
      expect(w.postMessage).toHaveBeenCalled();
    });

    const [payload] = w.postMessage.mock.calls[0];
    expect(isCompressed(payload)).toBe(false);
    expect(payload).toMatchObject({ id: 0, method: "small", args: [1, 2] });

    w.emit("message", { data: { id: 0, result: 3 } });
    await callPromise;
  });

  it("decompresses incoming compressed messages", async () => {
    const w = createMockWorker();
    const api = wrap<{ hello(): string }>(w as any, {
      compression: true,
    });

    const callPromise = api.hello();

    await vi.waitFor(() => {
      expect(w.postMessage).toHaveBeenCalled();
    });

    // Simulate a compressed response from the worker
    const response = { id: 0, result: "world" };
    const { data: compressed } = await compressMessage(response, {
      threshold: 0,
    });
    w.emit("message", { data: compressed });

    const result = await callPromise;
    expect(result).toBe("world");
  });

  it("does not compress when compression is not enabled", async () => {
    const w = createMockWorker();
    const api = wrap<{ big(s: string): string }>(w as any);

    const callPromise = api.big("x".repeat(200));

    await vi.waitFor(() => {
      expect(w.postMessage).toHaveBeenCalled();
    });

    const [payload] = w.postMessage.mock.calls[0];
    expect(isCompressed(payload)).toBe(false);
    expect(payload.method).toBe("big");

    w.emit("message", { data: { id: 0, result: "ok" } });
    await callPromise;
  });
});
