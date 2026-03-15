# Svelte Integration Guide

Idiomatic patterns for using **thread-weaver** in Svelte 5 applications (runes). Svelte 4 `$:` reactive patterns are noted where they differ.

---

## Setup

```bash
npm install thread-weaver
```

### Worker file

```ts
// src/workers/math.worker.ts
import { expose } from "thread-weaver/worker";

const api = {
  add(a: number, b: number) {
    return a + b;
  },

  async fibonacci(n: number) {
    let a = 0,
      b = 1;
    for (let i = 0; i < n; i++) [a, b] = [b, a + b];
    return a;
  },

  async *generatePrimes(limit: number) {
    for (let n = 2; n <= limit; n++) {
      let isPrime = true;
      for (let d = 2; d * d <= n; d++) {
        if (n % d === 0) {
          isPrime = false;
          break;
        }
      }
      if (isPrime) yield n;
    }
  },
};

expose(api);

export type MathApi = typeof api;
```

---

## Basic Usage with `onMount` / `onDestroy`

Create the worker when the component mounts and clean up on destroy:

```svelte
<!-- src/lib/Fibonacci.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { wrap, type Promisified } from "thread-weaver";
  import type { MathApi } from "../workers/math.worker";

  let api: Promisified<MathApi>;
  let worker: Worker;
  let result: number | null = $state(null);

  onMount(() => {
    worker = new Worker(
      new URL("../workers/math.worker.ts", import.meta.url),
      { type: "module" },
    );
    api = wrap<MathApi>(worker);
  });

  onDestroy(() => {
    api?.dispose();
    worker?.terminate();
  });

  async function calculate() {
    result = await api.fibonacci(40);
  }
</script>

<button onclick={calculate}>Calculate fib(40)</button>
{#if result !== null}
  <p>Result: {result}</p>
{/if}
```

---

## Module-Level Worker (Shared Across Components)

For a worker shared across an entire app, create it in a module and export the API:

```ts
// src/lib/math-worker.ts
import { wrap, type Promisified } from "thread-weaver";
import type { MathApi } from "../workers/math.worker";

let api: Promisified<MathApi> | null = null;
let worker: Worker | null = null;

export function getMathApi(): Promisified<MathApi> {
  if (!api) {
    worker = new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
      type: "module",
    });
    api = wrap<MathApi>(worker);
  }
  return api;
}

export function disposeMathApi() {
  api?.dispose();
  worker?.terminate();
  api = null;
  worker = null;
}
```

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import { getMathApi, disposeMathApi } from "$lib/math-worker";

  const math = getMathApi();
  let result: number | null = $state(null);

  async function calculate() {
    result = await math.fibonacci(40);
  }

  // Dispose when no longer needed (e.g. in a top-level layout)
  // onDestroy(disposeMathApi);
</script>
```

---

## Reactive Worker Calls with `$effect`

Automatically re-run computations when reactive state changes, with cancellation:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { wrap, type Promisified } from "thread-weaver";
  import type { MathApi } from "../workers/math.worker";

  let api: Promisified<MathApi>;
  let worker: Worker;
  let n = $state(10);
  let result: number | null = $state(null);

  onMount(() => {
    worker = new Worker(
      new URL("../workers/math.worker.ts", import.meta.url),
      { type: "module" },
    );
    api = wrap<MathApi>(worker);
  });

  onDestroy(() => {
    api?.dispose();
    worker?.terminate();
  });

  $effect(() => {
    if (!api) return;
    const controller = new AbortController();

    api.fibonacci(n)
      .signal(controller.signal)
      .then((v) => { result = v; })
      .catch(() => {});

    return () => controller.abort();
  });
</script>

<input type="number" bind:value={n} min="0" max="50" />
<p>fib({n}) = {result ?? "…"}</p>
```

---

## Streaming into Reactive State

Consume async generator streams:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { wrap, type Promisified } from "thread-weaver";
  import type { MathApi } from "../workers/math.worker";

  let api: Promisified<MathApi>;
  let worker: Worker;
  let primes: number[] = $state([]);
  let done = $state(false);
  let limit = $state(100);

  onMount(() => {
    worker = new Worker(
      new URL("../workers/math.worker.ts", import.meta.url),
      { type: "module" },
    );
    api = wrap<MathApi>(worker);
  });

  onDestroy(() => {
    api?.dispose();
    worker?.terminate();
  });

  async function streamPrimes() {
    primes = [];
    done = false;
    const stream = await api.generatePrimes(limit);
    for await (const prime of stream) {
      primes = [...primes, prime];
    }
    done = true;
  }
</script>

<input type="number" bind:value={limit} min="2" />
<button onclick={streamPrimes}>Find primes</button>
<p>{primes.join(", ")}</p>
{#if done}<p>Done!</p>{/if}
```

---

## Worker Pool

For parallel computation with a pool of workers:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { pool, type Pool } from "thread-weaver";
  import type { MathApi } from "../workers/math.worker";

  let workers: Pool<MathApi>;
  let results: number[] = $state([]);

  onMount(() => {
    workers = pool<MathApi>(
      () => new Worker(
        new URL("../workers/math.worker.ts", import.meta.url),
        { type: "module" },
      ),
      { size: 4, timeout: 10_000 },
    );
  });

  onDestroy(() => {
    workers?.terminate();
  });

  async function computeAll() {
    results = await Promise.all(
      [35, 36, 37, 38].map((n) => workers.fibonacci(n)),
    );
  }
</script>

<button onclick={computeAll}>Compute in parallel</button>
<pre>{JSON.stringify(results)}</pre>
```

---

## Proxy Objects and Events

Use remote proxy objects with event subscriptions:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { wrap, type RemoteObject } from "thread-weaver";

  let worker: Worker;
  let api: ReturnType<typeof wrap<any>>;
  let counter: RemoteObject<{ get(): number; increment(): number }> | null = null;
  let count = $state(0);
  let unsubscribe: (() => void) | null = null;

  onMount(async () => {
    worker = new Worker(
      new URL("../workers/math.worker.ts", import.meta.url),
      { type: "module" },
    );
    api = wrap(worker);
    counter = await api.createEmittingCounter();
    count = await counter.get();

    // Subscribe to worker-side events
    unsubscribe = counter.on("changed", (value: number) => {
      count = value;
    });
  });

  onDestroy(() => {
    unsubscribe?.();
    counter?.release();
    api?.dispose();
    worker?.terminate();
  });

  async function increment() {
    await counter?.increment();
  }
</script>

<p>Count: {count}</p>
<button onclick={increment}>+1</button>
```

---

## Svelte Store Pattern

Wrap the worker API in a Svelte store for sharing via context:

```ts
// src/lib/stores/math.ts
import { writable } from "svelte/store";
import { wrap, type Promisified } from "thread-weaver";
import type { MathApi } from "../../workers/math.worker";

function createMathStore() {
  const worker = new Worker(
    new URL("../../workers/math.worker.ts", import.meta.url),
    { type: "module" },
  );
  const api = wrap<MathApi>(worker);
  const { subscribe, set } = writable<Promisified<MathApi>>(api);

  return {
    subscribe,
    destroy() {
      api.dispose();
      worker.terminate();
    },
  };
}

export const mathStore = createMathStore();
```

---

## Tips

- **Worker URLs**: Use `new URL(…, import.meta.url)` — SvelteKit and Vite both support this pattern.
- **SvelteKit**: Workers run client-side only. Guard with `browser` from `$app/environment` or create in `onMount`.
- **`$effect` cleanup**: The return function in `$effect` runs before the next re-execution, making it ideal for aborting in-flight calls.
- **Svelte 4**: Replace `$state(…)` with `let x = …` and `$effect(…)` with `$: { … }` reactive blocks.
