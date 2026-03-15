# thread-weaver — Roadmap

> Feature ideas and improvements for future releases.
> Items are grouped by category and roughly ordered by impact within each group.
> Check the box when an item is implemented.

---

## Type Safety & DX

- [x] **Unwrap transfer/proxy from public types** — Refine `Promisified<T>` so callers don't need `as any` casts when passing raw `ArrayBuffer` or callback arguments (both are now auto-detected, but the types still expect `Transfer<>` / `(…) => …` wrappers).
- [x] **Branded error types** — Expose typed error classes (`TimeoutError`, `AbortError`, `WorkerCrashedError`) instead of generic `Error` instances so callers can `catch` by type.
- [x] **Strict method validation at compile time** — Reject non-function properties in the type passed to `wrap<T>()` / `expose()` at the type level.
- [x] **Generic method support** — Ensure generic methods on the exposed API preserve their type parameters through `Promisified<T>` (constrained generics keep their constraint; unconstrained generics erase to `unknown` — a TypeScript limitation — but can be restored via the `Overrides` type parameter).

## Proxy & Transferable Enhancements

- [ ] **Nested / deep proxy objects** — Allow returning long-lived proxy objects from the worker that the main thread can call methods on (stateful worker-side objects, similar to Comlink's `proxy()` on return values).
- [ ] **Revocable proxies** — Add a `release()` mechanism for long-lived proxies so the worker can garbage-collect them.
- [ ] **Proxy event emitters** — Support `EventTarget` / `EventEmitter`-style patterns across the boundary (worker emits events, main thread listens).
- [ ] **Opt-out of auto-transfer** — Provide a way to mark a value as "do not transfer" for cases where cloning is preferred over transferring (e.g. keeping a local copy).

## Error Handling & Debugging

- [ ] **`error.cause` chaining** — Preserve `error.cause` across the worker boundary so full causal chains are available for debugging.
- [ ] **Structured clone validation (dev mode)** — Detect uncloneable arguments (DOM nodes, class instances with methods, symbols) before calling `postMessage` and throw a helpful error instead of a cryptic `DataCloneError`.
- [ ] **DevTools integration** — A debug utility that logs all RPC calls, response times, transfer sizes, and active streams — enabled via a `debug` option.
- [ ] **Call tracing / span IDs** — Assign trace IDs to calls for correlation in distributed tracing / observability pipelines.

## Performance

- [ ] **Call batching** — Combine multiple rapid-fire calls into a single `postMessage` to reduce overhead for high-frequency RPC (configurable flush interval or `requestAnimationFrame` batching).
- [ ] **`SharedArrayBuffer` support** — Allow passing `SharedArrayBuffer` without transferring (shared memory between threads).
- [ ] **Lazy worker initialization** — Don't create the actual worker until the first method call, so `wrap()` is free if never used.
- [ ] **Message compression** — Optional compression for large payloads using `CompressionStream` when available.

## Streaming & Async Patterns

- [ ] **Progress channel** — A first-class lightweight progress reporting mechanism (lighter than a full async generator), e.g. `api.process(data).onProgress(pct => …)`.
- [ ] **Observable / RxJS interop** — Return an `Observable`-compatible stream in addition to `AsyncIterableIterator`, for users of RxJS or similar libraries.
- [ ] **Backpressure** — Allow the consumer to signal the producer to slow down when it can't keep up with a stream.
- [ ] **Multiplexed streams** — Multiple concurrent streams over a single worker, each independently cancellable.

## Worker Pool Improvements

- [ ] **Dynamic pool sizing** — Auto-scale the pool based on load (add workers when busy, remove when idle).
- [ ] **Task prioritization** — Priority queue for pool dispatch so important calls jump ahead.
- [ ] **Worker affinity** — Route calls to a specific worker by key (e.g. for stateful workers that cache data).
- [ ] **Pool health checks** — Periodic heartbeat to detect stuck workers and replace them.
- [ ] **Graceful shutdown** — `pool.drain()` waits for in-flight calls to finish before terminating.
- [ ] **Pool statistics** — Expose metrics: active workers, pending calls, average response time.
- [ ] **Warm-up** — Pre-initialize workers with a setup function before they receive real calls.

## API Surface & Ergonomics

- [ ] **Expose nested namespaces** — Support dotted method paths like `api.math.add(1, 2)` for deeply nested API objects.
- [ ] **Middleware / interceptors** — Hook into the call lifecycle (before send, after receive, on error) for logging, metrics, retries, auth, etc.
- [ ] **Automatic retries** — Configurable retry policy for failed calls (with backoff), especially useful for transient worker crashes.
- [ ] **Call deduplication** — If the same call (same method + args) is already in flight, return the existing promise instead of duplicating.
- [ ] **`wrap` from URL** — `wrap(new URL("./worker.ts", import.meta.url))` shorthand that creates the Worker internally.
- [ ] **Module Worker detection** — Auto-detect `{ type: "module" }` support and fall back to classic workers.

## Platform & Runtime Support

- [x] **Service Worker support** — Extend `MessageEndpoint` to work with Service Workers.
- [ ] **Node.js `worker_threads` support** — Adapt the library to also work with Node.js worker threads (same API, different transport).
- [ ] **Deno Workers support** — Ensure compatibility with Deno's Web Worker implementation.
- [ ] **`BroadcastChannel` support** — One-to-many communication where one message reaches all workers.
- [ ] **Cross-origin iframe support** — Use `window.postMessage` to communicate with iframes.

## Testing & Quality

- [ ] **100% branch coverage** — Reach full coverage, especially edge cases in pool respawn and stream cancellation.
- [ ] **Stress / load tests** — Benchmark under high concurrency to find bottlenecks.
- [ ] **Memory leak tests** — Verify proxy callbacks and streams are fully cleaned up under repeated use.
- [ ] **Fuzz testing** — Random input generation for `collectTransferables` and serialization paths.

## Documentation & Ecosystem

- [ ] **Interactive playground** — A web-based demo where users can try thread-weaver in the browser.
- [ ] **Framework integration guides** — Examples for React, Vue, Svelte, Angular showing idiomatic usage.
- [ ] **Migration guide from Comlink** — Side-by-side comparison and migration path.
- [ ] **Cookbook / recipes** — Common patterns: image processing pipeline, WASM in a worker, database queries, etc.
- [ ] **JSDoc on all public APIs** — Ensure every export has thorough JSDoc with `@example` tags.
- [ ] **Contribution guide** — `CONTRIBUTING.md` with development setup, PR process, and coding standards.

## Build & Distribution

- [ ] **Tree-shaking validation** — Ensure unused exports (e.g. `pool` or `proxy`) are eliminated by bundlers.
- [ ] **CDN / UMD build** — A single-file build for script-tag usage without a bundler.
- [ ] **Size budget CI check** — Fail the build if the bundle exceeds a size threshold.
- [ ] **Provenance / SLSA attestation** — Publish with npm provenance for supply chain security.
