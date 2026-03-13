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
 * Mark a function so it can be called back from the worker.
 * When passed as an argument to a wrapped worker method, the worker
 * receives a callable stub that messages back to the main thread.
 *
 * @param fn The main-thread function to expose to the worker.
 * @returns A ProxyMarker that `wrap()` and `expose()` handle automatically.
 */
export function proxy<T extends (...args: any[]) => any>(
  fn: T,
): ProxyMarker<T> {
  return { [PROXY_BRAND]: true, value: fn };
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

/** Unwrap Transfer / ProxyMarker wrappers in a tuple of args. */
export type UnwrapTransferArgs<T extends any[]> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? T[K] | ProxyMarker<T[K]>
    : T[K] | Transfer<T[K]>;
};

/** Map a return type: unwrap async generators to AsyncIterableIterator, and unwrap Transfer. */
export type UnwrapReturn<R> =
  R extends AsyncGenerator<infer Y, any, any>
    ? AsyncIterableIterator<Y>
    : R extends AsyncIterable<infer Y>
      ? AsyncIterableIterator<Y>
      : Awaited<UnwrapTransfer<R>>;
