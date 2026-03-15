# Angular Integration Guide

Idiomatic patterns for using **thread-weaver** in Angular applications (v17+, standalone components). Patterns also apply to NgModule-based apps.

---

## Setup

```bash
npm install thread-weaver
```

Angular CLI supports `new Worker()` syntax natively — no additional bundler config needed.

### Worker file

```ts
// src/app/workers/math.worker.ts
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

> **Note:** With Angular CLI, add web workers via `ng generate web-worker <name>`, or simply create the file manually as above. The CLI's webpack/esbuild config handles the bundling.

---

## Injectable Service

Wrap the worker in an Angular service for dependency injection. Use `DestroyRef` to auto-dispose:

```ts
// src/app/services/math-worker.service.ts
import { Injectable, DestroyRef, inject } from "@angular/core";
import { wrap, type Promisified, type WrapOptions } from "thread-weaver";
import type { MathApi } from "../workers/math.worker";

@Injectable({ providedIn: "root" })
export class MathWorkerService {
  private worker: Worker;
  readonly api: Promisified<MathApi>;

  constructor() {
    this.worker = new Worker(
      new URL("../workers/math.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.api = wrap<MathApi>(this.worker, { timeout: 10_000 });

    // Auto-cleanup when the injector is destroyed
    inject(DestroyRef).onDestroy(() => {
      this.api.dispose();
      this.worker.terminate();
    });
  }
}
```

### Usage in a component

```ts
// src/app/components/fibonacci.component.ts
import { Component, inject } from "@angular/core";
import { MathWorkerService } from "../services/math-worker.service";

@Component({
  selector: "app-fibonacci",
  standalone: true,
  template: `
    <button (click)="calculate()">Calculate fib(40)</button>
    @if (result !== null) {
      <p>Result: {{ result }}</p>
    }
  `,
})
export class FibonacciComponent {
  private math = inject(MathWorkerService);
  result: number | null = null;

  async calculate() {
    this.result = await this.math.api.fibonacci(40);
  }
}
```

---

## Generic Worker Service Factory

A reusable factory for creating services for different worker types:

```ts
// src/app/services/worker.service.ts
import { DestroyRef, inject } from "@angular/core";
import { wrap, type Promisified, type WrapOptions } from "thread-weaver";

export function createWorkerService<T>(
  factory: () => Worker,
  options?: WrapOptions,
): Promisified<T> {
  const worker = factory();
  const api = wrap<T>(worker, options);

  inject(DestroyRef).onDestroy(() => {
    api.dispose();
    worker.terminate();
  });

  return api;
}
```

```ts
@Injectable({ providedIn: "root" })
export class ImageWorkerService {
  readonly api = createWorkerService<ImageApi>(
    () =>
      new Worker(new URL("../workers/image.worker.ts", import.meta.url), {
        type: "module",
      }),
  );
}
```

---

## RxJS Integration

Convert thread-weaver calls to Observables for Angular's reactive patterns:

```ts
// src/app/utils/worker-rx.ts
import { Observable } from "rxjs";
import type { CancellablePromise } from "thread-weaver";

/** Convert a CancellablePromise to an Observable that cancels on unsubscribe. */
export function fromWorkerCall<T>(call: CancellablePromise<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    call
      .then((value) => {
        subscriber.next(value);
        subscriber.complete();
      })
      .catch((err) => subscriber.error(err));

    return () => call.abort();
  });
}

/** Convert a worker streaming call to an Observable. */
export function fromWorkerStream<T>(
  callFn: () => CancellablePromise<AsyncIterableIterator<T>>,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    let cancelled = false;

    (async () => {
      try {
        const stream = await callFn();
        for await (const value of stream) {
          if (cancelled) break;
          subscriber.next(value);
        }
        if (!cancelled) subscriber.complete();
      } catch (err) {
        if (!cancelled) subscriber.error(err);
      }
    })();

    return () => {
      cancelled = true;
    };
  });
}
```

### Using with `async` pipe

```ts
import { Component, inject } from "@angular/core";
import { AsyncPipe } from "@angular/common";
import { Subject, switchMap } from "rxjs";
import { MathWorkerService } from "../services/math-worker.service";
import { fromWorkerCall } from "../utils/worker-rx";

@Component({
  selector: "app-fib-rx",
  standalone: true,
  imports: [AsyncPipe],
  template: `
    <button (click)="compute$.next(40)">Calculate fib(40)</button>
    @if (result$ | async; as result) {
      <p>Result: {{ result }}</p>
    }
  `,
})
export class FibRxComponent {
  private math = inject(MathWorkerService);

  compute$ = new Subject<number>();

  result$ = this.compute$.pipe(
    switchMap((n) => fromWorkerCall(this.math.api.fibonacci(n))),
  );
}
```

### Streaming with RxJS

```ts
import { Component, inject } from "@angular/core";
import { AsyncPipe } from "@angular/common";
import { scan, Subject, switchMap } from "rxjs";
import { MathWorkerService } from "../services/math-worker.service";
import { fromWorkerStream } from "../utils/worker-rx";

@Component({
  selector: "app-prime-stream",
  standalone: true,
  imports: [AsyncPipe],
  template: `
    <button (click)="start$.next(100)">Find primes up to 100</button>
    <p>{{ primes$ | async }}</p>
  `,
})
export class PrimeStreamComponent {
  private math = inject(MathWorkerService);

  start$ = new Subject<number>();

  primes$ = this.start$.pipe(
    switchMap((limit) =>
      fromWorkerStream<number>(
        () => this.math.api.generatePrimes(limit) as any,
      ).pipe(scan((acc, v) => [...acc, v], [] as number[])),
    ),
  );
}
```

---

## Cancellation with AbortSignal

Wire Angular component destruction to cancel in-flight calls:

```ts
@Component({
  selector: "app-auto-fib",
  standalone: true,
  template: `
    <input type="number" [value]="n" (input)="onInput($event)" />
    <p>fib({{ n }}) = {{ result ?? "…" }}</p>
  `,
})
export class AutoFibComponent {
  private math = inject(MathWorkerService);
  n = 10;
  result: number | null = null;
  private controller: AbortController | null = null;

  async onInput(event: Event) {
    this.n = +(event.target as HTMLInputElement).value;

    // Cancel the previous call
    this.controller?.abort();
    this.controller = new AbortController();

    try {
      this.result = await this.math.api
        .fibonacci(this.n)
        .signal(this.controller.signal);
    } catch {
      // AbortError — ignored
    }
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
  }
}
```

---

## Worker Pool Service

For CPU-heavy parallel work:

```ts
// src/app/services/math-pool.service.ts
import { Injectable, DestroyRef, inject } from "@angular/core";
import { pool, type Pool, type PoolOptions } from "thread-weaver";
import type { MathApi } from "../workers/math.worker";

@Injectable({ providedIn: "root" })
export class MathPoolService {
  readonly pool: Pool<MathApi>;

  constructor() {
    this.pool = pool<MathApi>(
      () =>
        new Worker(new URL("../workers/math.worker.ts", import.meta.url), {
          type: "module",
        }),
      { size: 4, timeout: 10_000, respawn: true },
    );

    inject(DestroyRef).onDestroy(() => this.pool.terminate());
  }
}
```

```ts
@Component({
  selector: "app-parallel",
  standalone: true,
  template: `
    <button (click)="computeAll()">Compute in parallel</button>
    <pre>{{ results | json }}</pre>
  `,
})
export class ParallelComponent {
  private pool = inject(MathPoolService);
  results: number[] = [];

  async computeAll() {
    this.results = await Promise.all(
      [35, 36, 37, 38].map((n) => this.pool.pool.fibonacci(n)),
    );
  }
}
```

---

## Remote Proxy Objects

Manage long-lived worker-side objects:

```ts
@Component({
  selector: "app-counter",
  standalone: true,
  template: `
    <p>Count: {{ count }}</p>
    <button (click)="increment()">+1</button>
  `,
})
export class CounterComponent {
  private math = inject(MathWorkerService);
  private counter: RemoteObject<any> | null = null;
  count = 0;

  constructor() {
    this.init();

    inject(DestroyRef).onDestroy(() => {
      this.counter?.release();
    });
  }

  private async init() {
    this.counter = await this.math.api.createCounter();
    this.count = await this.counter!.get();
  }

  async increment() {
    if (this.counter) {
      this.count = await this.counter.increment();
    }
  }
}
```

---

## Event Emitters

Subscribe to worker-side events, cleaning up on destroy:

```ts
@Component({
  selector: "app-live-counter",
  standalone: true,
  template: `<p>Live count: {{ count }}</p>`,
})
export class LiveCounterComponent {
  private math = inject(MathWorkerService);
  count = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);

    (async () => {
      const counter = await this.math.api.createEmittingCounter();

      // Subscribe to events from the worker
      const unsubscribe = counter.on("changed", (value: number) => {
        this.count = value;
      });

      destroyRef.onDestroy(() => {
        unsubscribe();
        counter.release();
      });
    })();
  }
}
```

---

## Signals Integration (Angular 17+)

Use Angular Signals with worker calls for fine-grained reactivity:

```ts
import { Component, inject, signal, effect } from "@angular/core";
import { MathWorkerService } from "../services/math-worker.service";

@Component({
  selector: "app-signal-fib",
  standalone: true,
  template: `
    <input
      type="number"
      [value]="n()"
      (input)="n.set(+$any($event.target).value)"
    />
    <p>fib({{ n() }}) = {{ result() ?? "…" }}</p>
  `,
})
export class SignalFibComponent {
  private math = inject(MathWorkerService);

  n = signal(10);
  result = signal<number | null>(null);

  constructor() {
    effect((onCleanup) => {
      const controller = new AbortController();
      onCleanup(() => controller.abort());

      const currentN = this.n(); // tracked dependency

      this.math.api
        .fibonacci(currentN)
        .signal(controller.signal)
        .then((v) => this.result.set(v))
        .catch(() => {});
    });
  }
}
```

---

## Tips

- **Worker URLs**: Angular CLI (v17+ with esbuild or webpack) supports `new URL(…, import.meta.url)`. For older setups, use `ng generate web-worker`.
- **Zone.js**: Worker calls are Promises, so they work with Angular's zone-based change detection out of the box.
- **Zoneless (experimental)**: With `provideExperimentalZonelessChangeDetection()`, use Signals and `effect()` for automatic change detection without zones.
- **SSR/Prerendering**: Workers are browser-only. Guard with `isPlatformBrowser(platformId)` or use `afterNextRender()` in Angular 17+.
- **NgModule apps**: Replace `inject(DestroyRef).onDestroy(…)` with `ngOnDestroy()` lifecycle hook. Services work the same way.
