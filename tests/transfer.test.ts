import { describe, it, expect } from "vitest";
import { transfer, isTransfer, collectTransferables } from "../src/transfer";

describe("transfer", () => {
  it("creates a Transfer wrapper with the branded symbol", () => {
    const buf = new ArrayBuffer(8);
    const t = transfer(buf, [buf]);

    expect(t.value).toBe(buf);
    expect(t.transferables).toEqual([buf]);
    expect(isTransfer(t)).toBe(true);
  });

  it("preserves the value type", () => {
    const obj = { data: [1, 2, 3] };
    const buf = new ArrayBuffer(4);
    const t = transfer(obj, [buf]);

    expect(t.value).toBe(obj);
    expect(t.transferables).toEqual([buf]);
  });
});

describe("isTransfer", () => {
  it("returns true for Transfer objects", () => {
    const t = transfer("hello", []);
    expect(isTransfer(t)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isTransfer(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isTransfer(undefined)).toBe(false);
  });

  it("returns false for plain objects", () => {
    expect(isTransfer({})).toBe(false);
    expect(isTransfer({ value: 1, transferables: [] })).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isTransfer(42)).toBe(false);
    expect(isTransfer("string")).toBe(false);
    expect(isTransfer(true)).toBe(false);
  });
});

describe("collectTransferables", () => {
  it("finds a top-level ArrayBuffer", () => {
    const buf = new ArrayBuffer(8);
    expect(collectTransferables(buf)).toEqual([buf]);
  });

  it("finds an ArrayBuffer nested in a plain object", () => {
    const buf = new ArrayBuffer(4);
    expect(collectTransferables({ data: buf })).toEqual([buf]);
  });

  it("finds an ArrayBuffer nested in an array", () => {
    const buf = new ArrayBuffer(4);
    expect(collectTransferables([1, buf, "x"])).toEqual([buf]);
  });

  it("extracts the underlying buffer from typed arrays", () => {
    const u8 = new Uint8Array(4);
    const result = collectTransferables(u8);
    expect(result).toEqual([u8.buffer]);
  });

  it("deduplicates the same buffer referenced twice", () => {
    const buf = new ArrayBuffer(8);
    const result = collectTransferables({ a: buf, b: buf });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(buf);
  });

  it("handles circular references without infinite loop", () => {
    const obj: any = { buf: new ArrayBuffer(4) };
    obj.self = obj;
    const result = collectTransferables(obj);
    expect(result).toEqual([obj.buf]);
  });

  it("returns empty array for primitives and nulls", () => {
    expect(collectTransferables(null)).toEqual([]);
    expect(collectTransferables(undefined)).toEqual([]);
    expect(collectTransferables(42)).toEqual([]);
    expect(collectTransferables("hello")).toEqual([]);
    expect(collectTransferables(true)).toEqual([]);
  });

  it("returns empty array for objects without transferables", () => {
    expect(collectTransferables({ x: 1, y: "two" })).toEqual([]);
  });

  it("finds multiple transferables in deeply nested structure", () => {
    const buf1 = new ArrayBuffer(4);
    const buf2 = new ArrayBuffer(8);
    const result = collectTransferables({ a: { b: { c: buf1 } }, d: [buf2] });
    expect(result).toContain(buf1);
    expect(result).toContain(buf2);
    expect(result).toHaveLength(2);
  });
});
