# thread-weaver

[![CI](https://github.com/frauschert/thread-weaver/actions/workflows/ci.yml/badge.svg)](https://github.com/frauschert/thread-weaver/actions/workflows/ci.yml)

Type-safe Web Worker RPC — call worker methods as async functions.

- Zero dependencies
- Full TypeScript inference — `await worker.add(1, 2)` just works
- Structured error serialization (name, message, stack)
- Transferable support for zero-copy data (auto-detected)
- Worker pool with least-busy dispatch
- Per-call timeouts with `.timeout()` override
- Cancellation via `AbortSignal` and `.abort()`
- Streaming via async generators (`for await`)
- Service Worker support with broadcast
- Branded error types (`TimeoutError`, `AbortError`, `WorkerCrashedError`)
- Strict compile-time validation — non-function properties are rejected by `wrap<T>()` and `expose()`
- Proper cleanup via `dispose()`

## Install

```bash
npm install thread-weaver
```

## Quick Start

**Worker** — expose an API:

```ts
// math.worker.ts
import { expose } from "thread-weaver/worker";

const api = {
  add(a: number, b: number) {
    return a + b;
  },
  async fibonacci(n: number): Promise<number> {
    if (n <= 1) return n;
    return api.fibonacci(n - 1) + api.fibonacci(n - 2);
  },
};

expose(api);

export type MathApi = typeof api;
```

**Main thread** — call it:

```ts
// main.ts
import { wrap } from "thread-weaver";
import type { MathApi } from "./math.worker";

const worker = new Worker(new URL("./math.worker.ts", import.meta.url), {
  type: "module",
});
const api = wrap<MathApi>(worker);

const sum = await api.add(1, 2); // 3
```

## Transferables

Transferable objects (`ArrayBuffer`, `MessagePort`, `ReadableStream`, `OffscreenCanvas`, etc.) are **automatically detected** and transferred with zero-copy — just pass them directly:

```ts
import { wrap } from "thread-weaver";

const buffer = new ArrayBuffer(1024);
await api.process(buffer);
// buffer.byteLength === 0  (ownership transferred)
```

Workers can also return transferables without any wrapper:

```ts
import { expose } from "thread-weaver/worker";

expose({
  createBuffer() {
    const buf = new ArrayBuffer(1024);
    return buf; // auto-detected and transferred
  },
});
```

For explicit control, you can still use `transfer()`:

```ts
import { wrap, transfer } from "thread-weaver";

await api.process(transfer(buffer, [buffer]));
```

## Timeouts

Set a default timeout for all calls through a wrapped worker:

```ts
const api = wrap<MathApi>(worker, { timeout: 5000 });

// Rejects with "Worker call "fibonacci" timed out after 5000ms"
// if the worker doesn't respond within 5 seconds
await api.fibonacci(50);
```

When a timeout fires, the call is rejected on the main thread **and** a cancel signal is sent to the worker, aborting the `AbortSignal` passed to the method.

For streaming calls (async generators), the timeout also acts as an **idle timeout** — the timer resets on every yielded value. If no value arrives within the timeout window, the stream errors and the worker is cancelled:

```ts
const api = wrap<MathApi>(worker, { timeout: 5000 });

const stream = await api.fibonacci(Infinity);
for await (const value of stream) {
  // If the worker stalls for 5 seconds between yields, the stream errors
  console.log(value);
}
```

Override the default timeout on individual calls:

```ts
// This specific call gets 30 seconds instead of the default 5
await api.fibonacci(50).timeout(30_000);

// Disable timeout for a single call
await api.fibonacci(50).timeout(0);
```

## Cancellation

Cancel individual calls with an `AbortSignal`:

```ts
const ctrl = new AbortController();
const result = api.fibonacci(50).signal(ctrl.signal);

// Cancel after 1 second
setTimeout(() => ctrl.abort(), 1000);

try {
  await result;
} catch (err) {
  err.name; // "AbortError"
}
```

Or call `.abort()` directly:

```ts
const result = api.fibonacci(50);
result.abort("no longer needed");
```

When a call is aborted, the worker receives an `AbortSignal` that gets triggered. Worker methods can opt-in to cooperative cancellation by accepting the signal as the last argument:

```ts
// worker
expose({
  async heavyComputation(data: number[], signal: AbortSignal) {
    for (const item of data) {
      if (signal.aborted) throw new Error("Cancelled");
      await processItem(item);
    }
  },
});
```

The signal is always appended as the last argument — methods that don't need it can simply ignore it. The signal also works with async generator methods for cooperative stream cancellation.

Chain `.timeout()` and `.signal()`:

```ts
await api.fibonacci(50).timeout(30_000).signal(ctrl.signal);
```

## Error Handling

All errors thrown by thread-weaver are typed classes you can catch with `instanceof`:

```ts
import { TimeoutError, AbortError, WorkerCrashedError } from "thread-weaver";

try {
  await api.compute(data);
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(err.method, err.timeout); // "compute", 5000
  } else if (err instanceof AbortError) {
    console.log("Call was cancelled");
  } else if (err instanceof WorkerCrashedError) {
    console.log("Worker died:", err.message);
  }
}
```

| Class                | Thrown when                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| `TimeoutError`       | A call or stream exceeds its timeout. Has `.method` and `.timeout` properties. |
| `AbortError`         | A call is cancelled via `.abort()`, `AbortSignal`, or disposal.                |
| `WorkerCrashedError` | The worker crashes, terminates, or sends an undeserializable message.          |

## Streaming

Expose async generator methods to stream values from worker to main thread:

```ts
// worker
import { expose } from "thread-weaver/worker";

expose({
  async *fibonacci(limit: number) {
    let [a, b] = [0, 1];
    while (a <= limit) {
      yield a;
      [a, b] = [b, a + b];
    }
  },
});
```

Consume the stream on the main thread:

```ts
const stream = await api.fibonacci(100);

for await (const value of stream) {
  console.log(value); // 0, 1, 1, 2, 3, 5, 8, ...
}
```

Cancel a stream mid-iteration:

```ts
const result = api.fibonacci(Infinity);
const stream = await result;

for await (const value of stream) {
  if (value > 1000) {
    result.abort(); // stops the worker generator
    break;
  }
}
```

A `break` in `for await` also automatically sends a cancel signal to the worker, so the generator stops cleanly even without calling `.abort()`:

```ts
for await (const value of stream) {
  if (value > 1000) break; // worker generator is cancelled automatically
}
```

## Worker Pool

Spread work across multiple workers with automatic least-busy dispatch:

```ts
import { pool } from "thread-weaver";
import type { MathApi } from "./math.worker";

const workers = pool<MathApi>(
  () =>
    new Worker(new URL("./math.worker.ts", import.meta.url), {
      type: "module",
    }),
  { size: 4, timeout: 10_000 },
);

// Calls are distributed across 4 workers
const results = await Promise.all([
  workers.fibonacci(40),
  workers.fibonacci(41),
  workers.fibonacci(42),
  workers.fibonacci(43),
]);

workers.terminate(); // terminate all workers
```

### Automatic Respawn

Enable `respawn` to automatically replace workers that crash:

```ts
const workers = pool<MathApi>(
  () =>
    new Worker(new URL("./math.worker.ts", import.meta.url), {
      type: "module",
    }),
  { size: 4, respawn: true },
);

// If a worker encounters an uncaught error:
// 1. Pending calls on that worker are rejected
// 2. The worker is terminated and replaced with a fresh one
// 3. Future calls are routed to the replacement worker
```

## SharedWorker & MessagePort

`wrap()`, `expose()`, and `pool()` accept any object that implements the `MessageEndpoint` interface — not just dedicated `Worker` instances. This means you can use them with `MessagePort`, `SharedWorker`, `BroadcastChannel`, or any custom messaging object.

### SharedWorker

```ts
// shared-worker.ts
import { expose } from "thread-weaver/worker";

addEventListener("connect", (e: MessageEvent) => {
  const port = e.ports[0];
  expose(
    {
      add: (a: number, b: number) => a + b,
    },
    port, // expose on this port instead of global self
  );
});

// main.ts
import { wrap } from "thread-weaver";

const shared = new SharedWorker("./shared-worker.js");
const api = wrap<{ add(a: number, b: number): number }>(shared.port);

console.log(await api.add(1, 2)); // 3
```

### MessageChannel

```ts
import { wrap, expose } from "thread-weaver";

const { port1, port2 } = new MessageChannel();

// One side exposes an API on port1
expose({ greet: (name: string) => `Hello, ${name}!` }, port1);

// The other side wraps port2
const api = wrap<{ greet(name: string): string }>(port2);
console.log(await api.greet("world")); // "Hello, world!"
```

### Pool with SharedWorkers

```ts
const workers = pool<MathApi>(
  () => {
    const sw = new SharedWorker("./shared-worker.js");
    return sw.port;
  },
  { size: 4 },
);
```

> **Note:** `MessagePort` requires `.start()` to begin receiving messages. thread-weaver calls `start()` automatically when the endpoint has it.

## Service Workers

thread-weaver provides helpers for type-safe RPC with Service Workers. Each page gets a dedicated `MessagePort` via an automatic handshake, so you use the same `wrap()` / `expose()` model.

### Service Worker side

```ts
// sw.ts
import { exposeServiceWorker, broadcast } from "thread-weaver/service-worker";

exposeServiceWorker({
  async fetchData(url: string) {
    const res = await fetch(url);
    return res.json();
  },
});

// Push a message to all connected pages
await broadcast({ type: "cache-updated", url: "/data.json" });
```

### Page side

```ts
import { wrap } from "thread-weaver";
import {
  connectServiceWorker,
  onBroadcast,
} from "thread-weaver/service-worker";

const reg = await navigator.serviceWorker.register("./sw.ts", {
  type: "module",
});
const port = await connectServiceWorker(reg);
const api = wrap<{ fetchData(url: string): Promise<any> }>(port);

const data = await api.fetchData("/api/items");

// Listen for broadcasts from the SW
const unsub = onBroadcast((msg) => {
  console.log("SW broadcast:", msg);
});
```

> **Note:** `connectServiceWorker()` waits for the Service Worker to activate before establishing the connection. It includes a configurable handshake timeout (default 5 000 ms).

## Proxy Callbacks (Bidirectional Communication)

Function arguments are **automatically proxied** — just pass a regular function and the worker can call it. No wrapper needed.

### Progress reporting

```ts
// worker.ts
import { expose } from "thread-weaver/worker";

expose({
  async processData(data: ArrayBuffer, onProgress: (pct: number) => void) {
    for (let i = 0; i < 100; i++) {
      await doChunk(data, i);
      await onProgress(i + 1); // calls back to main thread
    }
    return "done";
  },
});

// main.ts
import { wrap } from "thread-weaver";

const api = wrap<WorkerApi>(worker);

const result = await api.processData(buffer, (pct) => {
  progressBar.style.width = `${pct}%`;
});
```

### Transform callbacks (with return values)

Proxy callbacks are fully awaitable — the worker can use the return value:

```ts
// worker.ts
expose({
  async compute(input: number, transform: (x: number) => Promise<number>) {
    const transformed = await transform(input); // round-trips to main thread
    return transformed * 2;
  },
});

// main.ts
const result = await api.compute(
  5,
  (x) => x * 10, // returns 50, worker doubles to 100
);
console.log(result); // 100
```

> **Note:** You can also use `proxy(fn)` explicitly if you prefer — both forms work identically.

Proxy callback functions are automatically cleaned up when the original call completes.

## Cleanup

Call `dispose()` to remove event listeners and reject pending calls:

```ts
const api = wrap<MathApi>(worker);

// ... use api ...

api.dispose(); // removes listeners, rejects pending calls
worker.terminate(); // stop the worker
```

For pools, `terminate()` handles both disposal and termination:

```ts
workers.terminate();
```

## Resource Management

thread-weaver supports the TC39 [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) proposal via `Symbol.dispose`. Use the `using` keyword to automatically clean up when leaving scope:

```ts
{
  using api = wrap<MathApi>(worker);
  const result = await api.add(1, 2);
  // api[Symbol.dispose]() is called automatically at end of block
}

{
  using workers = pool<MathApi>(() => new Worker("./worker.js"), { size: 4 });
  const result = await workers.add(1, 2);
  // all workers terminated automatically at end of block
}
```

## Error Handling

Errors thrown in the worker are serialized with their name, message, and stack trace:

```ts
// worker
expose({
  fail() {
    throw new TypeError("invalid input");
  },
});

// main thread
try {
  await api.fail();
} catch (err) {
  err.name; // "TypeError"
  err.message; // "invalid input"
  err.stack; // points to worker source
}
```

### What happens when a worker crashes?

If a worker encounters an uncaught error, all pending calls to that worker are rejected with the error message. The proxy remains functional for future calls — the worker itself is still alive after most error events.

For truly unresponsive workers (e.g. infinite loops, OOM), use timeouts to prevent calls from hanging indefinitely:

```ts
const api = wrap<MathApi>(worker, { timeout: 10_000 });
```

In a pool with `respawn: true`, crashed workers are automatically replaced.

### Timeout vs. AbortError

| Scenario                                    | Error name                        | How to handle                            |
| ------------------------------------------- | --------------------------------- | ---------------------------------------- |
| Worker doesn't respond                      | `Error` (`"timed out after ..."`) | Retry or alert user                      |
| `.abort()` or `AbortSignal` triggered       | `AbortError`                      | Intentional cancel — no action needed    |
| Worker throws                               | `Error` (or custom name)          | Bug in worker code — inspect `err.stack` |
| `postMessage` fails (e.g. uncloneable data) | `DOMException`                    | Fix the argument types                   |

## Troubleshooting

**"Worker call X timed out"** — The worker didn't respond within the timeout. Possible causes:

- The method is CPU-intensive and needs a longer timeout
- A typo in the method name (the worker returns an "Unknown method" error, but without a timeout the call hangs)
- The worker crashed and can't respond

**"Worker stream X timed out after Nms of inactivity"** — A streaming call didn't yield a value within the idle timeout. The stream was cancelled.

**"Worker proxy disposed" / "Worker pool has been terminated"** — A call was made after `dispose()` / `terminate()` was called. Ensure you don't reuse disposed proxies.

**"Failed to execute 'postMessage'"** — An argument couldn't be cloned for transfer. Common causes: passing functions, DOM nodes, or incorrect transferable objects.

## API Reference

### Main thread (`thread-weaver`)

#### `wrap<T, Overrides>(endpoint: MessageEndpoint, options?: WrapOptions): Promisified<T, Overrides>`

Wraps a `Worker`, `MessagePort`, or any `MessageEndpoint`, returning a proxy where every method returns a `CancellablePromise`. Function arguments are automatically proxied so the worker can call them back.

**Generic methods:** TypeScript erases generic type parameters through conditional mapped types. Constrained generics (e.g. `<T extends string>`) keep their constraint; unconstrained generics become `unknown`. Use the `Overrides` type parameter to restore generic signatures:

```ts
type Api = {
  identity<T>(x: T): T;
  add(a: number, b: number): number;
};

// Without overrides: identity(x: unknown) => CancellablePromise<unknown>
const basic = wrap<Api>(worker);

// With overrides: identity<T>(x: T) => CancellablePromise<T>
const typed = wrap<
  Api,
  {
    identity<T>(x: T): CancellablePromise<T>;
  }
>(worker);
```

**WrapOptions:**
| Option | Type | Default | Description |
|-----------|----------|---------|--------------------------------------|
| `timeout` | `number` | `0` | Per-call timeout in ms. 0 = no limit |

**`CancellablePromise<T>`** extends `Promise<T>` with:

- `.abort(reason?)` — reject with `AbortError`
- `.timeout(ms)` — override the default timeout for this call (returns `this`)
- `.signal(signal)` — wire an `AbortSignal` (returns `this`)

#### `pool<T>(factory: () => MessageEndpoint, options?: PoolOptions): Pool<T>`

Creates a worker pool with least-busy dispatch. The factory can return a `Worker`, `MessagePort`, or any `MessageEndpoint`.

**PoolOptions:**
| Option | Type | Default | Description |
|-----------|----------|--------------------------------|--------------------------------------|
| `size` | `number` | `navigator.hardwareConcurrency` | Number of workers to spawn |
| `timeout` | `number` | `0` | Per-call timeout in ms. 0 = no limit |
| `respawn` | `boolean` | `false` | Replace workers that crash |

**Pool** has the same method interface as `Promisified<T>` plus:

- `terminate()` — terminate all workers
- `dispose()` — alias for `terminate()`
- `size` — number of workers in the pool

#### `transfer<T>(value: T, transferables: Transferable[]): Transfer<T>`

Wraps a value with a list of transferable objects for zero-copy transfer.

#### `proxy<T>(fn: T): ProxyMarker<T>`

Explicitly wraps a main-thread function for passing to a worker. **Optional** — bare function arguments are auto-proxied. Use `proxy()` when you want to be explicit or to disambiguate from other object types. Proxy callbacks are cleaned up when the originating call completes.

### Worker (`thread-weaver/worker`)

#### `expose(api: Record<string, (...args: any[]) => any>, endpoint?: MessageEndpoint): void`

Exposes an object of functions to the main thread. When called without an endpoint, uses the global worker scope (`self`) and can only be called once. When called with an explicit endpoint (e.g. a `MessagePort`), it can be called multiple times with different endpoints.

Async generator methods are automatically streamed as `AsyncIterable` to the caller.

Every method receives an `AbortSignal` as the last argument for cooperative cancellation. Methods that don't need it can simply ignore the extra parameter.

#### `transfer<T>(value: T, transferables: Transferable[]): Transfer<T>`

Same as main-thread `transfer()` — use for returning transferables from workers.

### Service Worker (`thread-weaver/service-worker`)

#### `connectServiceWorker(registration, options?): Promise<MessageEndpoint>`

Establishes a `MessageChannel` with the Service Worker and returns a port that can be passed to `wrap()`. Waits for the SW to activate if it's still installing.

**ConnectOptions:**
| Option | Type | Default | Description |
|-----------|----------|---------|--------------------------------------|
| `timeout` | `number` | `5000` | Handshake timeout in ms. 0 = no limit |

#### `exposeServiceWorker(api): () => void`

Listens for incoming page connections and calls `expose(api, port)` on each. Returns a cleanup function.

#### `broadcast(data): Promise<void>`

Sends a message from the Service Worker to all connected window clients (including uncontrolled pages).

#### `onBroadcast(handler): () => void`

Listens for broadcast messages from the Service Worker on the page side. Returns an unsubscribe function.

### Error Classes (`thread-weaver`)

#### `TimeoutError`

Thrown when a call or stream exceeds its timeout.

| Property  | Type     | Description                       |
| --------- | -------- | --------------------------------- |
| `name`    | `string` | Always `"TimeoutError"`           |
| `method`  | `string` | Name of the method that timed out |
| `timeout` | `number` | Timeout value in ms               |

#### `AbortError`

Thrown when a call is cancelled via `.abort()`, an `AbortSignal`, or proxy disposal.

| Property | Type     | Description           |
| -------- | -------- | --------------------- |
| `name`   | `string` | Always `"AbortError"` |

#### `WorkerCrashedError`

Thrown when the worker terminates, fires an `error` event, or sends an undeserializable message.

| Property | Type     | Description                   |
| -------- | -------- | ----------------------------- |
| `name`   | `string` | Always `"WorkerCrashedError"` |

## License

MIT
