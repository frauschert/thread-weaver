# thread-weaver

Type-safe Web Worker RPC — call worker methods as async functions.

## Install

```bash
npm install thread-weaver
```

## Usage

Define your API in a worker file:

```ts
// my-worker.ts
import { expose } from "thread-weaver/worker";

const api = {
  add(a: number, b: number) {
    return a + b;
  },
  greet(name: string) {
    return `Hello, ${name}!`;
  },
};

expose(api);

export type MyApi = typeof api;
```

Then call it from the main thread:

```ts
// main.ts
import { wrap } from "thread-weaver";
import type { MyApi } from "./my-worker";

const worker = new Worker(new URL("./my-worker.ts", import.meta.url), {
  type: "module",
});
const api = wrap<MyApi>(worker);

const sum = await api.add(1, 2); // 3
const msg = await api.greet("world"); // "Hello, world!"
```

## API

### `wrap<T>(worker: Worker): Promisified<T>`

Wraps a `Worker` instance, returning a proxy where every method call is forwarded to the worker and returns a `Promise`.

### `expose(api: Record<string, (...args: any[]) => any>): void`

Call inside a worker script to expose an object of functions to the main thread.

## License

MIT
