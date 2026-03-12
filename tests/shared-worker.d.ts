// SharedWorker types are part of the DOM lib but our tsconfig uses WebWorker.
// Provide minimal declarations so e2e tests (and the shared.worker fixture) compile.

interface SharedWorkerGlobalScope extends WorkerGlobalScope {
  onconnect: ((this: SharedWorkerGlobalScope, ev: MessageEvent) => any) | null;
}

declare const SharedWorker: {
  prototype: SharedWorkerInstance;
  new (
    scriptURL: string | URL,
    options?: string | WorkerOptions,
  ): SharedWorkerInstance;
};

interface SharedWorkerInstance extends EventTarget {
  readonly port: MessagePort;
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => any) | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
declare interface SharedWorker extends SharedWorkerInstance {}
