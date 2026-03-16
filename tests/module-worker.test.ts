import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  supportsModuleWorker,
  createWorker,
  _resetModuleWorkerCache,
} from "../src/module-worker";

/* ---------- helpers ---------- */

function makeFakeWorker() {
  const handlers: Record<string, ((e: any) => void)[]> = {};
  const worker = {
    addEventListener: vi.fn((type: string, fn: (e: any) => void) => {
      (handlers[type] ??= []).push(fn);
    }),
    terminate: vi.fn(),
    /** Fire a stored handler */
    _fire(type: string, data?: any) {
      for (const fn of handlers[type] ?? []) fn(data ?? {});
    },
  };
  return worker;
}

/* ---------- tests ---------- */

describe("supportsModuleWorker", () => {
  const origWorker = globalThis.Worker;
  const origBlob = globalThis.Blob;
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    _resetModuleWorkerCache();
  });

  afterEach(() => {
    globalThis.Worker = origWorker;
    globalThis.Blob = origBlob;
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  });

  it("returns false when Worker is not defined", async () => {
    // @ts-expect-error — intentionally removing Worker
    delete globalThis.Worker;
    await expect(supportsModuleWorker()).resolves.toBe(false);
  });

  it("returns true when module worker probe succeeds", async () => {
    const fake = makeFakeWorker();
    // Must use function expression (not arrow) so `new Worker(...)` works
    globalThis.Worker = vi.fn(function () {
      return fake;
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    const promise = supportsModuleWorker();
    fake._fire("message", { data: 0 });

    await expect(promise).resolves.toBe(true);
    expect(fake.terminate).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("returns false when module worker probe fires error", async () => {
    const fake = makeFakeWorker();
    globalThis.Worker = vi.fn(function () {
      return fake;
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    const promise = supportsModuleWorker();
    fake._fire("error");

    await expect(promise).resolves.toBe(false);
    expect(fake.terminate).toHaveBeenCalled();
  });

  it("returns false when Worker constructor throws", async () => {
    globalThis.Worker = vi.fn(function () {
      throw new Error("Not supported");
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    await expect(supportsModuleWorker()).resolves.toBe(false);
  });

  it("caches the result across calls", async () => {
    const fake = makeFakeWorker();
    globalThis.Worker = vi.fn(function () {
      return fake;
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    const p1 = supportsModuleWorker();
    const p2 = supportsModuleWorker();
    expect(p1).toBe(p2); // same pending promise

    fake._fire("message");
    await expect(p1).resolves.toBe(true);

    // Subsequent calls hit the cache — no new Worker created
    const callsBefore = (globalThis.Worker as any).mock.calls.length;
    const p3 = supportsModuleWorker();
    await expect(p3).resolves.toBe(true);
    expect((globalThis.Worker as any).mock.calls.length).toBe(callsBefore);
  });
});

describe("createWorker", () => {
  const origWorker = globalThis.Worker;
  const origBlob = globalThis.Blob;
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    _resetModuleWorkerCache();
  });

  afterEach(() => {
    globalThis.Worker = origWorker;
    globalThis.Blob = origBlob;
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  });

  it("creates a module worker when supported", async () => {
    const probe = makeFakeWorker();
    const real = { terminate: vi.fn() };
    let callCount = 0;

    globalThis.Worker = vi.fn(function () {
      callCount++;
      return callCount === 1 ? probe : real;
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    const promise = createWorker("./worker.js");
    probe._fire("message");

    const w = await promise;
    expect(w).toBe(real);

    const [url, opts] = (globalThis.Worker as any).mock.calls[1];
    expect(url).toBe("./worker.js");
    expect(opts).toEqual({ type: "module" });
  });

  it("creates a classic worker with fallbackUrl when unsupported", async () => {
    const probe = makeFakeWorker();
    const real = { terminate: vi.fn() };
    let callCount = 0;

    globalThis.Worker = vi.fn(function () {
      callCount++;
      return callCount === 1 ? probe : real;
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    const promise = createWorker("./worker.mjs", {
      fallbackUrl: "./worker.iife.js",
    });
    probe._fire("error");

    const w = await promise;
    expect(w).toBe(real);

    const [url, opts] = (globalThis.Worker as any).mock.calls[1];
    expect(url).toBe("./worker.iife.js");
    expect(opts).toEqual({ type: "classic" });
  });

  it("uses primary url as classic fallback when no fallbackUrl given", async () => {
    const probe = makeFakeWorker();
    const real = { terminate: vi.fn() };
    let callCount = 0;

    globalThis.Worker = vi.fn(function () {
      callCount++;
      return callCount === 1 ? probe : real;
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    const promise = createWorker("./worker.js");
    probe._fire("error");

    const w = await promise;
    expect(w).toBe(real);

    const [url, opts] = (globalThis.Worker as any).mock.calls[1];
    expect(url).toBe("./worker.js");
    expect(opts).toEqual({ type: "classic" });
  });

  it("passes through extra worker options", async () => {
    const probe = makeFakeWorker();
    const real = { terminate: vi.fn() };
    let callCount = 0;

    globalThis.Worker = vi.fn(function () {
      callCount++;
      return callCount === 1 ? probe : real;
    }) as any;
    globalThis.Blob = vi.fn(function () {
      return {};
    }) as any;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    const promise = createWorker("./worker.js", {
      name: "my-worker",
      credentials: "same-origin",
    });
    probe._fire("message");

    await promise;

    const [, opts] = (globalThis.Worker as any).mock.calls[1];
    expect(opts).toEqual({
      name: "my-worker",
      credentials: "same-origin",
      type: "module",
    });
  });
});
