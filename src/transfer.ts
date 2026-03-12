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

/** Unwrap Transfer<T> → T, pass everything else through. */
export type UnwrapTransfer<T> = T extends Transfer<infer U> ? U : T;

/** Unwrap Transfer wrappers in a tuple of args. */
export type UnwrapTransferArgs<T extends any[]> = {
  [K in keyof T]: T[K] | Transfer<T[K]>;
};

/** Map a return type: unwrap async generators to AsyncIterableIterator, and unwrap Transfer. */
export type UnwrapReturn<R> =
  R extends AsyncGenerator<infer Y, any, any>
    ? AsyncIterableIterator<Y>
    : R extends AsyncIterable<infer Y>
      ? AsyncIterableIterator<Y>
      : Awaited<UnwrapTransfer<R>>;
