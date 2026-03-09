const TRANSFER_BRAND = Symbol.for("thread-weaver.transfer");

export interface Transfer<T = unknown> {
  [TRANSFER_BRAND]: true;
  value: T;
  transferables: Transferable[];
}

/** Mark a value to be sent with zero-copy transferables. */
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
