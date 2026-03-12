import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../src/queue";

describe("AsyncQueue", () => {
  it("delivers pushed values to consumers", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.done();

    const values: number[] = [];
    for await (const v of q) {
      values.push(v);
    }
    expect(values).toEqual([1, 2]);
  });

  it("waits for values when consumer is faster than producer", async () => {
    const q = new AsyncQueue<number>();

    const collected = (async () => {
      const values: number[] = [];
      for await (const v of q) {
        values.push(v);
      }
      return values;
    })();

    q.push(10);
    q.push(20);
    q.done();

    expect(await collected).toEqual([10, 20]);
  });

  it("rejects waiting consumers on throw()", async () => {
    const q = new AsyncQueue<number>();

    const collected = (async () => {
      const values: number[] = [];
      for await (const v of q) {
        values.push(v);
      }
      return values;
    })();

    q.push(1);
    q.error(new Error("stream failed"));

    await expect(collected).rejects.toThrow("stream failed");
  });

  it("rejects next() if already errored", async () => {
    const q = new AsyncQueue<number>();
    q.error(new Error("broken"));

    await expect(q.next()).rejects.toThrow("broken");
  });

  it("returns done after done() is called", async () => {
    const q = new AsyncQueue<number>();
    q.done();

    const result = await q.next();
    expect(result.done).toBe(true);
  });

  it("ignores pushes after done()", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.done();
    q.push(2); // should be ignored

    const values: number[] = [];
    for await (const v of q) {
      values.push(v);
    }
    expect(values).toEqual([1]);
  });
});
