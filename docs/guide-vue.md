# Vue Integration Guide

Idiomatic patterns for using **thread-weaver** in Vue 3 applications with the Composition API.

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

## Basic Composable: `useWorker`

Create a composable that manages the worker lifecycle. The worker is created eagerly and disposed when the component unmounts via `onScopeDispose`:

```ts
// src/composables/useWorker.ts
import { onScopeDispose } from "vue";
import { wrap, type Promisified, type WrapOptions } from "thread-weaver";

export function useWorker<T>(
  factory: () => Worker,
  options?: WrapOptions,
): Promisified<T> {
  const worker = factory();
  const api = wrap<T>(worker, options);

  onScopeDispose(() => {
    api.dispose();
    worker.terminate();
  });

  return api;
}
```

### Usage in a component

```vue
<!-- src/components/Fibonacci.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useWorker } from "../composables/useWorker";
import type { MathApi } from "../workers/math.worker";

const math = useWorker<MathApi>(
  () =>
    new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
      type: "module",
    }),
);

const result = ref<number | null>(null);

async function calculate() {
  result.value = await math.fibonacci(40);
}
</script>

<template>
  <button @click="calculate">Calculate fib(40)</button>
  <p v-if="result !== null">Result: {{ result }}</p>
</template>
```

---

## Reactive Worker Calls with `watchEffect`

Automatically recompute when reactive dependencies change, with cancellation on each re-run:

```vue
<script setup lang="ts">
import { ref, watchEffect } from "vue";
import { useWorker } from "../composables/useWorker";
import type { MathApi } from "../workers/math.worker";

const math = useWorker<MathApi>(
  () =>
    new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
      type: "module",
    }),
);

const n = ref(10);
const result = ref<number | null>(null);

watchEffect((onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());

  math
    .fibonacci(n.value)
    .signal(controller.signal)
    .then((v) => {
      result.value = v;
    })
    .catch(() => {});
});
</script>

<template>
  <input v-model.number="n" type="number" min="0" max="50" />
  <p>fib({{ n }}) = {{ result ?? "…" }}</p>
</template>
```

---

## Streaming with Reactive State

Consume async generator streams from a worker into a reactive array:

```vue
<script setup lang="ts">
import { ref, watch, onScopeDispose } from "vue";
import { useWorker } from "../composables/useWorker";
import type { MathApi } from "../workers/math.worker";

const math = useWorker<MathApi>(
  () =>
    new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
      type: "module",
    }),
);

const limit = ref(100);
const primes = ref<number[]>([]);
const done = ref(false);

watch(
  limit,
  async (newLimit) => {
    primes.value = [];
    done.value = false;

    const stream = await math.generatePrimes(newLimit);
    for await (const prime of stream) {
      primes.value.push(prime);
    }
    done.value = true;
  },
  { immediate: true },
);
</script>

<template>
  <input v-model.number="limit" type="number" min="2" />
  <p>Primes: {{ primes.join(", ") }}</p>
  <p v-if="done">Done!</p>
</template>
```

---

## Worker Pool Composable

For parallel work across multiple workers:

```ts
// src/composables/useWorkerPool.ts
import { onScopeDispose } from "vue";
import { pool, type Pool, type PoolOptions } from "thread-weaver";

export function useWorkerPool<T>(
  factory: () => Worker,
  options?: PoolOptions,
): Pool<T> {
  const p = pool<T>(factory, options);

  onScopeDispose(() => {
    p.terminate();
  });

  return p;
}
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useWorkerPool } from "../composables/useWorkerPool";
import type { MathApi } from "../workers/math.worker";

const workers = useWorkerPool<MathApi>(
  () =>
    new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
      type: "module",
    }),
  { size: 4, timeout: 10_000 },
);

const results = ref<number[]>([]);

async function computeAll() {
  results.value = await Promise.all(
    [35, 36, 37, 38].map((n) => workers.fibonacci(n)),
  );
}
</script>

<template>
  <button @click="computeAll">Compute in parallel</button>
  <pre>{{ results }}</pre>
</template>
```

---

## Async Composable with Loading State

A composable pattern that wraps a worker call with loading/error state:

```ts
// src/composables/useWorkerCall.ts
import { ref, type Ref } from "vue";
import type { CancellablePromise } from "thread-weaver";

export function useWorkerCall<T>(fn: () => CancellablePromise<T>) {
  const data = ref<T | null>(null) as Ref<T | null>;
  const error = ref<Error | null>(null);
  const loading = ref(false);

  async function execute() {
    loading.value = true;
    error.value = null;
    try {
      data.value = await fn();
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e));
    } finally {
      loading.value = false;
    }
  }

  return { data, error, loading, execute };
}
```

```vue
<script setup lang="ts">
import { useWorker } from "../composables/useWorker";
import { useWorkerCall } from "../composables/useWorkerCall";
import type { MathApi } from "../workers/math.worker";

const math = useWorker<MathApi>(
  () =>
    new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
      type: "module",
    }),
);

const { data, loading, error, execute } = useWorkerCall(() =>
  math.fibonacci(40),
);
</script>

<template>
  <button @click="execute" :disabled="loading">
    {{ loading ? "Computing…" : "Calculate fib(40)" }}
  </button>
  <p v-if="data !== null">Result: {{ data }}</p>
  <p v-if="error" class="error">{{ error.message }}</p>
</template>
```

---

## Remote Proxy Objects

Keep stateful objects alive in the worker:

```vue
<script setup lang="ts">
import { ref, onScopeDispose } from "vue";
import { useWorker } from "../composables/useWorker";
import type { RemoteObject } from "thread-weaver";

const api = useWorker<any>(
  () =>
    new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
      type: "module",
    }),
);

const counter = ref<RemoteObject<{
  get(): number;
  increment(): number;
}> | null>(null);
const count = ref(0);

(async () => {
  const c = await api.createCounter();
  counter.value = c;
  count.value = await c.get();
})();

onScopeDispose(() => {
  counter.value?.release();
});

async function increment() {
  if (counter.value) {
    count.value = await counter.value.increment();
  }
}
</script>

<template>
  <p>Count: {{ count }}</p>
  <button @click="increment">+1</button>
</template>
```

---

## Event Emitters

Subscribe to worker-side events using Vue's lifecycle:

```ts
// src/composables/useProxyEvent.ts
import { onScopeDispose } from "vue";
import type { RemoteObject } from "thread-weaver";

export function useProxyEvent<T>(
  proxy: RemoteObject<T>,
  event: string,
  handler: (data: any) => void,
) {
  const unsubscribe = proxy.on(event, handler);
  onScopeDispose(unsubscribe);
}
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useProxyEvent } from "../composables/useProxyEvent";

// Assume `counter` is a RemoteObject with emitter events
const count = ref(0);

useProxyEvent(counter, "changed", (value: number) => {
  count.value = value;
});
</script>
```

---

## Provide / Inject (Shared Worker Across Components)

Share a single worker instance across a component tree:

```ts
// src/providers/worker.ts
import { provide, inject, type InjectionKey } from "vue";
import { wrap, type Promisified } from "thread-weaver";
import type { MathApi } from "../workers/math.worker";

const WorkerKey: InjectionKey<Promisified<MathApi>> = Symbol("MathWorker");

export function provideWorker() {
  const worker = new Worker(
    new URL("../workers/math.worker.ts", import.meta.url),
    { type: "module" },
  );
  const api = wrap<MathApi>(worker);

  provide(WorkerKey, api);

  return { api, worker };
}

export function useInjectedWorker() {
  const api = inject(WorkerKey);
  if (!api)
    throw new Error(
      "Worker not provided. Call provideWorker() in a parent component.",
    );
  return api;
}
```

```vue
<!-- App.vue -->
<script setup>
import { onUnmounted } from "vue";
import { provideWorker } from "./providers/worker";

const { api, worker } = provideWorker();
onUnmounted(() => {
  api.dispose();
  worker.terminate();
});
</script>

<!-- Any child component -->
<script setup>
import { useInjectedWorker } from "../providers/worker";

const math = useInjectedWorker();
// math.add(1, 2), etc.
</script>
```

---

## Tips

- **Worker URL pattern**: Use `new URL("../workers/foo.worker.ts", import.meta.url)` for Vite compatibility.
- **Nuxt**: Workers must be created client-side. Use `onMounted` or wrap in `if (import.meta.client)` / `<ClientOnly>`.
- **`onScopeDispose`**: Preferred over `onUnmounted` — works in both components and `effectScope()` contexts.
- **Pinia stores**: You can create a worker in a Pinia store using `effectScope()` for app-wide shared workers.
