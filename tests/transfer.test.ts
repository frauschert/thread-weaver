import { describe, it, expect } from "vitest";
import { transfer, isTransfer } from "../src/transfer";

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
