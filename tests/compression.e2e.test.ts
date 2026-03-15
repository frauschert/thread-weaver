import { describe, it, expect, afterEach } from "vitest";
import { wrap } from "../src/main";
import type { CompressedWorkerApi } from "./fixtures/compressed.worker";

function createWorker() {
  return new Worker(
    new URL("./fixtures/compressed.worker.ts", import.meta.url),
    { type: "module" },
  );
}

describe("e2e: compression", () => {
  let worker: Worker;
  let api: ReturnType<typeof wrap<CompressedWorkerApi>>;

  afterEach(() => {
    api?.dispose();
    worker?.terminate();
  });

  it("calls a method with compression enabled on both sides", async () => {
    worker = createWorker();
    api = wrap<CompressedWorkerApi>(worker, {
      compression: { threshold: 10 },
    });

    const result = await api.add(2, 3);
    expect(result).toBe(5);
  });

  it("handles large payloads that trigger compression", async () => {
    worker = createWorker();
    api = wrap<CompressedWorkerApi>(worker, {
      compression: { threshold: 10 },
    });

    const bigString = "x".repeat(10_000);
    const result = await api.echo(bigString);
    expect(result).toBe(bigString);
  });

  it("handles small payloads below threshold without compression", async () => {
    worker = createWorker();
    api = wrap<CompressedWorkerApi>(worker, {
      compression: { threshold: 10 },
    });

    const result = await api.echo("hi");
    expect(result).toBe("hi");
  });

  it("streams work with compression enabled", async () => {
    worker = createWorker();
    api = wrap<CompressedWorkerApi>(worker, {
      compression: { threshold: 10 },
    });

    const values: number[] = [];
    for await (const v of (await api.count(
      5,
    )) as unknown as AsyncIterable<number>) {
      values.push(v);
    }
    expect(values).toEqual([0, 1, 2, 3, 4]);
  });

  it("works with compression only on wrap side (worker has no compression)", async () => {
    // Use the standard test worker without compression
    const w = new Worker(
      new URL("./fixtures/test.worker.ts", import.meta.url),
      { type: "module" },
    );
    const { add } = wrap<{ add(a: number, b: number): number }>(w, {
      compression: { threshold: 10 },
    });

    // Small payloads won't be compressed, so this still works
    const result = await add(1, 2);
    expect(result).toBe(3);

    w.terminate();
  });
});
