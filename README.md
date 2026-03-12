# thread-weaver

Type-safe Web Worker RPC — call worker methods as async functions.

- Zero dependencies
- Full TypeScript inference — `await worker.add(1, 2)` just works
- Structured error serialization (name, message, stack)
- Transferable support for zero-copy data
- Worker pool with least-busy dispatch
- Per-call timeouts
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

Use `transfer()` to move ownership of buffers instead of copying them:

```ts
import { wrap, transfer } from "thread-weaver";

const buffer = new ArrayBuffer(1024);
await api.process(transfer(buffer, [buffer]));
// buffer.byteLength === 0  (ownership transferred)
```

Workers can also return transferables:

```ts
import { expose, transfer } from "thread-weaver/worker";

expose({
  createBuffer() {
    const buf = new ArrayBuffer(1024);
    return transfer(buf, [buf]);
  },
});
```

## Timeouts

Set a default timeout for all calls through a wrapped worker:

```ts
const api = wrap<MathApi>(worker, { timeout: 5000 });

// Rejects with "Worker call "fibonacci" timed out after 5000ms"
// if the worker doesn't respond within 5 seconds
await api.fibonacci(50);
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

## API Reference

### Main thread (`thread-weaver`)

#### `wrap<T>(worker: Worker, options?: WrapOptions): Promisified<T>`

Wraps a `Worker`, returning a proxy where every method returns a `Promise`.

**WrapOptions:**
| Option | Type | Default | Description |
|-----------|----------|---------|--------------------------------------|
| `timeout` | `number` | `0` | Per-call timeout in ms. 0 = no limit |

#### `pool<T>(factory: () => Worker, options?: PoolOptions): Pool<T>`

Creates a worker pool with least-busy dispatch.

**PoolOptions:**
| Option | Type | Default | Description |
|-----------|----------|--------------------------------|--------------------------------------|
| `size` | `number` | `navigator.hardwareConcurrency` | Number of workers to spawn |
| `timeout` | `number` | `0` | Per-call timeout in ms. 0 = no limit |

**Pool** has the same method interface as `Promisified<T>` plus:

- `terminate()` — terminate all workers
- `dispose()` — alias for `terminate()`
- `size` — number of workers in the pool

#### `transfer<T>(value: T, transferables: Transferable[]): Transfer<T>`

Wraps a value with a list of transferable objects for zero-copy transfer.

### Worker (`thread-weaver/worker`)

#### `expose(api: Record<string, (...args: any[]) => any>): void`

Exposes an object of functions to the main thread. Call once per worker.

#### `transfer<T>(value: T, transferables: Transferable[]): Transfer<T>`

Same as main-thread `transfer()` — use for returning transferables from workers.

## License

MIT
