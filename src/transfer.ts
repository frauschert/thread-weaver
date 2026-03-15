const TRANSFER_BRAND = Symbol.for("thread-weaver.transfer");

export interface Transfer<T = unknown> {
  [TRANSFER_BRAND]: true;
  value: T;
  transferables: Transferable[];
}

/**
 * Mark a value to be sent with zero-copy transferable objects.
 *
 * @param value The value to send.
 * @param transferables Array of Transferable objects (e.g. ArrayBuffer, MessagePort).
 * @returns A Transfer wrapper that `wrap()` and `expose()` handle automatically.
 */
export function transfer<T>(
  value: T,
  transferables: Transferable[],
): Transfer<T> {
  return { [TRANSFER_BRAND]: true, value, transferables };
}

export function isTransfer(v: unknown): v is Transfer {
  return (
    v !== null && typeof v === "object" && (v as any)[TRANSFER_BRAND] === true
  );
}

const PROXY_BRAND = Symbol.for("thread-weaver.proxy");

export interface ProxyMarker<T = unknown> {
  [PROXY_BRAND]: true;
  value: T;
}

/**
 * Mark a value for proxying across the worker boundary.
 *
 * **As an argument (main → worker):** wraps a callback function so the worker
 * can invoke it back on the main thread. **Optional** — bare function
 * arguments are auto-proxied.
 *
 * **As a return value (worker → main):** wraps an object so it stays in the
 * worker and the main thread receives a `RemoteObject` proxy whose methods
 * forward calls via `postMessage`. Call `release()` on the returned proxy
 * when done to let the worker garbage-collect the object. **Optional** —
 * objects with own function properties are auto-proxied. Use `proxy()` when
 * you want to be explicit or for correct TypeScript types via `ProxyMarker<T>`.
 *
 * @param value A function (for callback proxying) or an object (for return proxying).
 * @returns A ProxyMarker that `wrap()` and `expose()` handle automatically.
 */
export function proxy<T>(value: T): ProxyMarker<T> {
  return { [PROXY_BRAND]: true, value };
}

export function isProxy(v: unknown): v is ProxyMarker {
  return (
    v !== null && typeof v === "object" && (v as any)[PROXY_BRAND] === true
  );
}

/** Known transferable constructors that exist in the current environment. */
const TRANSFERABLE_TYPES: (new (...args: any[]) => Transferable)[] = (
  [
    typeof ArrayBuffer !== "undefined" && ArrayBuffer,
    typeof MessagePort !== "undefined" && MessagePort,
    typeof ReadableStream !== "undefined" && ReadableStream,
    typeof WritableStream !== "undefined" && WritableStream,
    typeof TransformStream !== "undefined" && TransformStream,
    typeof OffscreenCanvas !== "undefined" && OffscreenCanvas,
    typeof ImageBitmap !== "undefined" && ImageBitmap,
  ] as (false | (new (...args: any[]) => Transferable))[]
).filter(Boolean) as (new (...args: any[]) => Transferable)[];

function isTransferable(v: unknown): v is Transferable {
  return TRANSFERABLE_TYPES.some((t) => v instanceof t);
}

/**
 * Recursively scan a value and collect all transferable objects found within it.
 * Handles plain objects, arrays, and top-level transferables.
 */
export function collectTransferables(value: unknown): Transferable[] {
  const found: Transferable[] = [];
  const seen = new Set<unknown>();

  function walk(v: unknown) {
    if (v == null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);

    if (isTransferable(v)) {
      found.push(v as Transferable);
      return; // don't recurse into transferable internals
    }

    // Check ArrayBuffer views (Uint8Array, Float32Array, etc.)
    if (ArrayBuffer.isView(v)) {
      const buf = (v as ArrayBufferView).buffer as ArrayBuffer;
      if (!found.includes(buf)) found.push(buf);
      return;
    }

    if (Array.isArray(v)) {
      for (const item of v as unknown[]) walk(item);
    } else {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        walk((v as Record<string, unknown>)[key]);
      }
    }
  }

  walk(value);
  return found;
}

/** Unwrap Transfer<T> → T, pass everything else through. */
export type UnwrapTransfer<T> = T extends Transfer<infer U> ? U : T;

/** Strip Transfer/ProxyMarker wrappers from a single arg, then allow both raw and wrapped forms. */
type UnwrapArg<T> =
  T extends Transfer<infer U>
    ? U | Transfer<U>
    : T extends ProxyMarker<infer F>
      ? F | ProxyMarker<F>
      : T extends (...args: any[]) => any
        ? T | ProxyMarker<T>
        : T | Transfer<T>;

/** Unwrap Transfer / ProxyMarker wrappers in a tuple of args. */
export type UnwrapTransferArgs<T extends any[]> = {
  [K in keyof T]: UnwrapArg<T[K]>;
};

/**
 * A remote proxy to a long-lived worker-side object.
 * Every method call is forwarded via `postMessage` and returns a `CancellablePromise`.
 * Call `release()` (or use `Symbol.dispose`) when done so the worker can
 * garbage-collect the backing object.
 */
export type RemoteObject<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any
    ? K
    : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: UnwrapTransferArgs<A>) => CancellablePromise<UnwrapReturn<R>>
    : never;
} & {
  /** Release the worker-side object so it can be garbage-collected. */
  release(): void;
  /** Symbol.dispose support for `using` syntax. */
  [Symbol.dispose](): void;
};

// Forward-declare CancellablePromise shape for RemoteObject (avoids circular import from main.ts)
interface CancellablePromise<T> extends Promise<T> {
  abort(reason?: string): void;
  timeout(ms: number): CancellablePromise<T>;
  signal(signal: AbortSignal): CancellablePromise<T>;
}

/**
 * Map a return type: unwrap async generators to AsyncIterableIterator,
 * unwrap Transfer, and convert ProxyMarker returns to RemoteObject.
 */
export type UnwrapReturn<R> =
  R extends AsyncGenerator<infer Y, any, any>
    ? AsyncIterableIterator<UnwrapTransfer<Y>>
    : R extends AsyncIterable<infer Y>
      ? AsyncIterableIterator<UnwrapTransfer<Y>>
      : Awaited<R> extends ProxyMarker<infer O>
        ? RemoteObject<O>
        : Awaited<UnwrapTransfer<R>>;
