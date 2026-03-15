import { describe, it, expectTypeOf } from "vitest";
import type {
  Promisified,
  CancellablePromise,
  Transfer,
  FunctionsOnly,
  RemoteObject,
} from "../src/main";
import type { ProxyMarker } from "../src/transfer";
import type { wrap } from "../src/main";
import type { pool } from "../src/pool";
import type { expose } from "../src/worker";

/**
 * Compile-time type tests for Promisified<T>.
 * These verify that Transfer<> and ProxyMarker<> wrappers are
 * automatically unwrapped in both parameter and return types,
 * so callers never need `as any` casts.
 */

// --- Worker API types for testing ---

type RawApi = {
  add(a: number, b: number): number;
  getBuffer(size: number): ArrayBuffer;
  sumBuffer(buf: ArrayBuffer): number;
  process(data: string, onProgress: (pct: number) => void): string;
  count(n: number): AsyncGenerator<number>;
};

type WrappedApi = {
  add(a: number, b: number): number;
  getBuffer(size: number): Transfer<ArrayBuffer>;
  sumBuffer(buf: Transfer<ArrayBuffer>): number;
  process(data: string, onProgress: ProxyMarker<(pct: number) => void>): string;
  streamBuffers(n: number): AsyncGenerator<Transfer<ArrayBuffer>>;
};

describe("Promisified type unwrapping", () => {
  it("accepts raw values for non-function args", () => {
    type P = Promisified<RawApi>;
    expectTypeOf<P["add"]>().toBeCallableWith(1, 2);
    expectTypeOf<P["sumBuffer"]>().toBeCallableWith(new ArrayBuffer(8));
  });

  it("accepts Transfer-wrapped values for non-function args", () => {
    type P = Promisified<RawApi>;
    expectTypeOf<P["add"]>().toBeCallableWith({} as Transfer<number>, 2);
    expectTypeOf<P["sumBuffer"]>().toBeCallableWith(
      {} as Transfer<ArrayBuffer>,
    );
  });

  it("unwraps Transfer<T> in params so raw values work", () => {
    // When the worker API explicitly types a param as Transfer<ArrayBuffer>,
    // the caller should still be able to pass a raw ArrayBuffer.
    type P = Promisified<WrappedApi>;
    expectTypeOf<P["sumBuffer"]>().toBeCallableWith(new ArrayBuffer(8));
  });

  it("unwraps Transfer<T> in params and still accepts Transfer-wrapped", () => {
    type P = Promisified<WrappedApi>;
    expectTypeOf<P["sumBuffer"]>().toBeCallableWith(
      {} as Transfer<ArrayBuffer>,
    );
  });

  it("accepts bare functions for callback args", () => {
    type P = Promisified<RawApi>;
    expectTypeOf<P["process"]>().toBeCallableWith("data", (_pct: number) => {});
  });

  it("accepts proxy-wrapped functions for callback args", () => {
    type P = Promisified<RawApi>;
    expectTypeOf<P["process"]>().toBeCallableWith(
      "data",
      {} as ProxyMarker<(pct: number) => void>,
    );
  });

  it("unwraps ProxyMarker<T> in params so bare functions work", () => {
    // When the worker API explicitly types a param as ProxyMarker<fn>,
    // the caller should still be able to pass a bare function.
    type P = Promisified<WrappedApi>;
    expectTypeOf<P["process"]>().toBeCallableWith("data", (_pct: number) => {});
  });

  it("unwraps ProxyMarker<T> in params and still accepts proxy-wrapped", () => {
    type P = Promisified<WrappedApi>;
    expectTypeOf<P["process"]>().toBeCallableWith(
      "data",
      {} as ProxyMarker<(pct: number) => void>,
    );
  });

  it("unwraps Transfer<T> in return type", () => {
    type P = Promisified<WrappedApi>;
    expectTypeOf<P["getBuffer"]>().returns.toEqualTypeOf<
      CancellablePromise<ArrayBuffer>
    >();
  });

  it("unwraps Transfer<T> inside async generator yields", () => {
    type P = Promisified<WrappedApi>;
    expectTypeOf<P["streamBuffers"]>().returns.toEqualTypeOf<
      CancellablePromise<AsyncIterableIterator<ArrayBuffer>>
    >();
  });

  it("returns plain types when no wrappers used", () => {
    type P = Promisified<RawApi>;
    expectTypeOf<P["add"]>().returns.toEqualTypeOf<
      CancellablePromise<number>
    >();
    expectTypeOf<P["getBuffer"]>().returns.toEqualTypeOf<
      CancellablePromise<ArrayBuffer>
    >();
  });

  it("unwraps async generator yields to AsyncIterableIterator", () => {
    type P = Promisified<RawApi>;
    expectTypeOf<P["count"]>().returns.toEqualTypeOf<
      CancellablePromise<AsyncIterableIterator<number>>
    >();
  });

  it("includes dispose methods", () => {
    type P = Promisified<RawApi>;
    expectTypeOf<P["dispose"]>().toBeFunction();
  });
});

// --- Strict method validation tests ---

type ValidApi = {
  add(a: number, b: number): number;
  greet(name: string): string;
};

type InvalidApi = {
  add(a: number, b: number): number;
  name: string; // non-function property
};

type AllBadApi = {
  count: number;
  label: string;
};

describe("FunctionsOnly strict method validation", () => {
  it("FunctionsOnly preserves a valid API unchanged", () => {
    expectTypeOf<FunctionsOnly<ValidApi>>().toEqualTypeOf<ValidApi>();
  });

  it("FunctionsOnly maps non-function properties to never", () => {
    type Result = FunctionsOnly<InvalidApi>;
    expectTypeOf<Result["add"]>().toEqualTypeOf<
      (a: number, b: number) => number
    >();
    expectTypeOf<Result["name"]>().toBeNever();
  });

  it("wrap<T> accepts a valid all-function API", () => {
    // Valid: all properties are functions, so the constraint holds
    type Call = typeof wrap<ValidApi>;
    expectTypeOf<ReturnType<Call>>().toEqualTypeOf<Promisified<ValidApi>>();
  });

  it("wrap<T> rejects an API with non-function properties", () => {
    // InvalidApi has 'name: string' which violates FunctionsOnly<T>
    // @ts-expect-error — non-function property 'name'
    type _Rejected = typeof wrap<InvalidApi>; // eslint-disable-line @typescript-eslint/no-unused-vars
  });

  it("wrap<T> rejects an API with no function properties", () => {
    // @ts-expect-error — no function properties at all
    type _Rejected = typeof wrap<AllBadApi>; // eslint-disable-line @typescript-eslint/no-unused-vars
  });

  it("pool<T> accepts a valid all-function API", () => {
    type Call = typeof pool<ValidApi>;
    expectTypeOf<ReturnType<Call>>().not.toBeNever();
  });

  it("pool<T> rejects an API with non-function properties", () => {
    // @ts-expect-error — non-function property 'name'
    type _Rejected = typeof pool<InvalidApi>; // eslint-disable-line @typescript-eslint/no-unused-vars
  });

  it("expose() accepts a valid all-function object", () => {
    type Call = typeof expose<ValidApi>;
    expectTypeOf<Parameters<Call>[0]>().not.toBeNever();
  });

  it("expose() rejects an object with non-function properties", () => {
    // @ts-expect-error — non-function property 'name'
    type _Rejected = typeof expose<InvalidApi>; // eslint-disable-line @typescript-eslint/no-unused-vars
  });
});

// --- Generic method support tests ---

type GenericApi = {
  identity<T>(x: T): T;
  constrained<T extends string>(x: T): T;
  multi<T, U>(a: T, b: U): [T, U];
  add(a: number, b: number): number; // non-generic control
};

describe("Generic method support", () => {
  it("generic methods appear on the promisified type", () => {
    type P = Promisified<GenericApi>;
    expectTypeOf<P>().toHaveProperty("identity");
    expectTypeOf<P>().toHaveProperty("constrained");
    expectTypeOf<P>().toHaveProperty("multi");
    expectTypeOf<P>().toHaveProperty("add");
  });

  it("generic methods are callable", () => {
    type P = Promisified<GenericApi>;
    expectTypeOf<P["identity"]>().toBeFunction();
    expectTypeOf<P["constrained"]>().toBeFunction();
    expectTypeOf<P["multi"]>().toBeFunction();
  });

  it("unconstrained generics are erased to unknown (TS limitation)", () => {
    // TypeScript erases generic type parameters through conditional mapped types.
    // Unconstrained generics (<T>) become unknown.
    type P = Promisified<GenericApi>;
    expectTypeOf<P["identity"]>().returns.toEqualTypeOf<
      CancellablePromise<unknown>
    >();
  });

  it("constrained generics preserve the constraint", () => {
    // <T extends string> preserves 'string' as the inferred type
    type P = Promisified<GenericApi>;
    expectTypeOf<P["constrained"]>().returns.toEqualTypeOf<
      CancellablePromise<string>
    >();
  });

  it("non-generic methods are unaffected", () => {
    type P = Promisified<GenericApi>;
    expectTypeOf<P["add"]>().returns.toEqualTypeOf<
      CancellablePromise<number>
    >();
  });

  it("FunctionsOnly accepts generic methods", () => {
    // Generic methods ARE functions, so FunctionsOnly should not reject them
    type F = FunctionsOnly<GenericApi>;
    expectTypeOf<F>().toHaveProperty("identity");
    expectTypeOf<F>().toHaveProperty("constrained");
  });

  it("wrap<T> accepts an API with generic methods", () => {
    type Call = typeof wrap<GenericApi>;
    expectTypeOf<ReturnType<Call>>().toHaveProperty("identity");
    expectTypeOf<ReturnType<Call>>().toHaveProperty("add");
  });

  it("Overrides restore generic signatures on Promisified", () => {
    type P = Promisified<
      GenericApi,
      { identity<T>(x: T): CancellablePromise<T> }
    >;
    // The override replaces the erased signature
    expectTypeOf<P["identity"]>().toBeFunction();
    // Non-overridden methods are still present and correct
    expectTypeOf<P["add"]>().returns.toEqualTypeOf<
      CancellablePromise<number>
    >();
  });

  it("Overrides restore generic signatures on wrap()", () => {
    type Call = typeof wrap<
      GenericApi,
      { identity<T>(x: T): CancellablePromise<T> }
    >;
    type P = ReturnType<Call>;
    expectTypeOf<P["identity"]>().toBeFunction();
    expectTypeOf<P["add"]>().returns.toEqualTypeOf<
      CancellablePromise<number>
    >();
  });
});

// --- Proxy return type tests ---

type CounterApi = {
  get(): number;
  increment(): number;
  add(n: number): number;
};

type ApiWithProxyReturn = {
  createCounter(): ProxyMarker<CounterApi>;
};

describe("Proxy return types (RemoteObject)", () => {
  it("unwraps ProxyMarker return to RemoteObject", () => {
    type P = Promisified<ApiWithProxyReturn>;
    expectTypeOf<P["createCounter"]>().returns.toEqualTypeOf<
      CancellablePromise<RemoteObject<CounterApi>>
    >();
  });

  it("RemoteObject methods return CancellablePromise", () => {
    type R = RemoteObject<CounterApi>;
    expectTypeOf<R["get"]>().returns.toEqualTypeOf<
      CancellablePromise<number>
    >();
    expectTypeOf<R["increment"]>().returns.toEqualTypeOf<
      CancellablePromise<number>
    >();
    expectTypeOf<R["add"]>().toBeCallableWith(5);
  });

  it("RemoteObject has release and dispose", () => {
    type R = RemoteObject<CounterApi>;
    expectTypeOf<R["release"]>().toBeFunction();
    expectTypeOf<R[typeof Symbol.dispose]>().toBeFunction();
  });

  it("RemoteObject filters out non-function properties", () => {
    type ObjWithProps = {
      method(): string;
      value: number;
    };
    type R = RemoteObject<ObjWithProps>;
    expectTypeOf<R["method"]>().toBeFunction();
    expectTypeOf<R>().toHaveProperty("release");
    // 'value' should not appear since it's not a function
  });
});
