export { wrap, transfer, proxy } from "./main";
export { TimeoutError, AbortError, WorkerCrashedError } from "./errors";
export type {
  CancellablePromise,
  FunctionsOnly,
  MessageEndpoint,
  Promisified,
  ProxyMarker,
  RemoteObject,
  RemoteEmitter,
  Transfer,
  UnwrapTransfer,
  UnwrapTransferArgs,
  UnwrapReturn,
  WrapOptions,
} from "./main";
export { expose } from "./worker";
export type { ExposeOptions } from "./worker";
export { pool } from "./pool";
export type { Pool, PoolOptions } from "./pool";
