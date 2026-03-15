/**
 * Branded error classes for thread-weaver.
 *
 * These allow callers to distinguish error types with `instanceof`:
 * ```ts
 * try { await api.compute(42); }
 * catch (e) {
 *   if (e instanceof TimeoutError) { … }
 *   if (e instanceof AbortError) { … }
 *   if (e instanceof WorkerCrashedError) { … }
 * }
 * ```
 */

/** Thrown when a worker call or stream exceeds its timeout. */
export class TimeoutError extends Error {
  override readonly name = "TimeoutError";

  constructor(
    message: string,
    /** The method name that timed out. */
    readonly method: string,
    /** The timeout duration in milliseconds. */
    readonly timeout: number,
  ) {
    super(message);
  }
}

/** Thrown when a call is cancelled via `.abort()`, `AbortSignal`, or disposal. */
export class AbortError extends Error {
  override readonly name = "AbortError";

  constructor(message = "Aborted") {
    super(message);
  }
}

/** Thrown when the worker crashes, terminates, or sends an undeserializable message. */
export class WorkerCrashedError extends Error {
  override readonly name = "WorkerCrashedError";

  constructor(message = "Worker error") {
    super(message);
  }
}
