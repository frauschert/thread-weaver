# React Integration Guide

Idiomatic patterns for using **thread-weaver** in React applications (with Vite, Next.js, or any bundler that supports `new Worker(new URL(…), { type: "module" })`).

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
    // expensive computation off the main thread
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

## Basic Hook: `useWorker`

Create a reusable hook that manages the worker lifecycle with React. The worker is created on mount and disposed on unmount:

```tsx
// src/hooks/useWorker.ts
import { useEffect, useRef } from "react";
import { wrap, type Promisified } from "thread-weaver";
import type { MathApi } from "../workers/math.worker";

export function useWorker() {
  const apiRef = useRef<Promisified<MathApi> | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/math.worker.ts", import.meta.url),
      { type: "module" },
    );
    const api = wrap<MathApi>(worker);

    workerRef.current = worker;
    apiRef.current = api;

    return () => {
      api.dispose();
      worker.terminate();
    };
  }, []);

  return apiRef;
}
```

### Usage in a component

```tsx
// src/components/Fibonacci.tsx
import { useState } from "react";
import { useWorker } from "../hooks/useWorker";

export function Fibonacci() {
  const api = useWorker();
  const [result, setResult] = useState<number | null>(null);

  async function calculate() {
    const value = await api.current!.fibonacci(40);
    setResult(value);
  }

  return (
    <div>
      <button onClick={calculate}>Calculate fib(40)</button>
      {result !== null && <p>Result: {result}</p>}
    </div>
  );
}
```

---

## Generic Hook: `useWorkerApi`

A more flexible hook that accepts a factory function, making it reusable across different workers:

```tsx
// src/hooks/useWorkerApi.ts
import { useEffect, useRef } from "react";
import { wrap, type Promisified, type WrapOptions } from "thread-weaver";

export function useWorkerApi<T>(factory: () => Worker, options?: WrapOptions) {
  const apiRef = useRef<Promisified<T> | null>(null);
  const workerRef = useRef<Worker | null>(null);

  if (!workerRef.current) {
    const worker = factory();
    workerRef.current = worker;
    apiRef.current = wrap<T>(worker, options);
  }

  useEffect(() => {
    return () => {
      apiRef.current?.dispose();
      workerRef.current?.terminate();
      apiRef.current = null;
      workerRef.current = null;
    };
  }, []);

  return apiRef.current!;
}
```

```tsx
import { useWorkerApi } from "../hooks/useWorkerApi";
import type { MathApi } from "../workers/math.worker";

function App() {
  const math = useWorkerApi<MathApi>(
    () =>
      new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
        type: "module",
      }),
    { timeout: 5000 },
  );

  // math.add(1, 2), math.fibonacci(40), etc.
}
```

---

## Cancellation with AbortController

Use React's cleanup to cancel in-flight calls when a component unmounts or dependencies change:

```tsx
import { useEffect, useState } from "react";
import { useWorkerApi } from "../hooks/useWorkerApi";
import type { MathApi } from "../workers/math.worker";

function FibonacciAuto({ n }: { n: number }) {
  const math = useWorkerApi<MathApi>(
    () =>
      new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
        type: "module",
      }),
  );
  const [result, setResult] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    math
      .fibonacci(n)
      .signal(controller.signal)
      .then(setResult)
      .catch(() => {});

    return () => controller.abort();
  }, [math, n]);

  return (
    <p>
      fib({n}) = {result ?? "…"}
    </p>
  );
}
```

---

## Streaming with `useReducer`

Consume async generator streams from a worker:

```tsx
import { useEffect, useReducer } from "react";
import { useWorkerApi } from "../hooks/useWorkerApi";
import type { MathApi } from "../workers/math.worker";

type State = { primes: number[]; done: boolean };
type Action = { type: "add"; value: number } | { type: "done" };

function reducer(state: State, action: Action): State {
  if (action.type === "add")
    return { ...state, primes: [...state.primes, action.value] };
  return { ...state, done: true };
}

function PrimeStream({ limit }: { limit: number }) {
  const math = useWorkerApi<MathApi>(
    () =>
      new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
        type: "module",
      }),
  );
  const [state, dispatch] = useReducer(reducer, { primes: [], done: false });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stream = await math.generatePrimes(limit);
      for await (const prime of stream) {
        if (cancelled) break;
        dispatch({ type: "add", value: prime });
      }
      if (!cancelled) dispatch({ type: "done" });
    })();

    return () => {
      cancelled = true;
    };
  }, [math, limit]);

  return (
    <div>
      <p>
        Primes up to {limit}: {state.primes.join(", ")}
      </p>
      {state.done && <p>Done!</p>}
    </div>
  );
}
```

---

## Worker Pool

For CPU-heavy parallel work, use a pool:

```tsx
import { useEffect, useRef } from "react";
import { pool, type Pool } from "thread-weaver";
import type { MathApi } from "../workers/math.worker";

export function useWorkerPool(size = 4) {
  const poolRef = useRef<Pool<MathApi> | null>(null);

  if (!poolRef.current) {
    poolRef.current = pool<MathApi>(
      () =>
        new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
          type: "module",
        }),
      { size, timeout: 10_000 },
    );
  }

  useEffect(() => {
    return () => {
      poolRef.current?.terminate();
      poolRef.current = null;
    };
  }, []);

  return poolRef.current!;
}
```

```tsx
function ParallelFib() {
  const workers = useWorkerPool(4);
  const [results, setResults] = useState<number[]>([]);

  async function computeAll() {
    const values = await Promise.all(
      [35, 36, 37, 38].map((n) => workers.fibonacci(n)),
    );
    setResults(values);
  }

  return (
    <div>
      <button onClick={computeAll}>Compute in parallel</button>
      <pre>{JSON.stringify(results)}</pre>
    </div>
  );
}
```

---

## Remote Proxy Objects (Stateful Workers)

Keep long-lived objects in the worker and interact with them from React:

```tsx
import { useEffect, useRef, useState } from "react";
import { wrap, type RemoteObject } from "thread-weaver";

// Assuming the worker exposes createCounter() that returns a proxy object
function useRemoteCounter(api: ReturnType<typeof wrap<any>>) {
  const counterRef = useRef<RemoteObject<{
    get(): number;
    increment(): number;
  }> | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let released = false;

    (async () => {
      const counter = await api.createCounter();
      if (released) {
        counter.release();
        return;
      }
      counterRef.current = counter;
      setCount(await counter.get());
    })();

    return () => {
      released = true;
      counterRef.current?.release();
    };
  }, [api]);

  async function increment() {
    if (counterRef.current) {
      const next = await counterRef.current.increment();
      setCount(next);
    }
  }

  return { count, increment };
}
```

---

## Event Emitters

Subscribe to worker-side events in React:

```tsx
import { useEffect, useState } from "react";
import type { RemoteObject } from "thread-weaver";

function useProxyEvents<T>(
  proxy: RemoteObject<T> | null,
  event: string,
  handler: (data: any) => void,
) {
  useEffect(() => {
    if (!proxy) return;
    return proxy.on(event, handler); // returns unsubscribe function
  }, [proxy, event, handler]);
}

// Usage:
function LiveCounter() {
  const api = useWorkerApi<WorkerApi>(/* ... */);
  const [counter, setCounter] = useState<RemoteObject<any> | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    api.createEmittingCounter().then(setCounter);
    return () => counter?.release();
  }, [api]);

  // Subscribe to "changed" events emitted by the worker
  useProxyEvents(counter, "changed", setCount);

  return <p>Count: {count}</p>;
}
```

---

## Tips

- **Worker URL pattern**: Use `new URL("../workers/foo.worker.ts", import.meta.url)` for Vite/Rollup/webpack 5 compatibility.
- **Strict Mode**: React 18 Strict Mode mounts/unmounts twice in dev. The cleanup in `useEffect` ensures workers are properly disposed.
- **Suspense**: Wrap worker calls in a Suspense-compatible cache if you want to use `use()` in React 19+.
- **Next.js**: Workers must be created client-side only. Use `useEffect` or dynamic imports with `ssr: false`.
