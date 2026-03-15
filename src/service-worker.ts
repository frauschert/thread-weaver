/**
 * Service Worker helpers for thread-weaver.
 *
 * Uses MessageChannel negotiation: each page creates a dedicated port pair,
 * sends one port to the Service Worker, and both sides use the existing
 * wrap(port) / expose(api, port) for type-safe RPC.
 *
 * @module thread-weaver/service-worker
 */

import { expose } from "./worker";
import type { MessageEndpoint } from "./main";
import { TimeoutError } from "./errors";

// ── Internal constants ────────────────────────────────────────────────

const HANDSHAKE_TYPE = "__tw_connect";
const HANDSHAKE_ACK = "__tw_connect_ack";
const BROADCAST_MARKER = "__tw_broadcast";

// ── Minimal DOM / Service Worker type declarations ────────────────────
// We don't add "DOM" to tsconfig lib (would pollute Worker-side types),
// so we declare only the interfaces we actually use.

interface SWRegistration {
  readonly active: SWInstance | null;
  readonly installing: SWInstance | null;
  readonly waiting: SWInstance | null;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

interface SWInstance {
  readonly state: string;
  postMessage(message: any, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

interface SWClient {
  postMessage(message: any, transfer?: Transferable[]): void;
}

interface SWClients {
  matchAll(options?: {
    type?: string;
    includeUncontrolled?: boolean;
  }): Promise<SWClient[]>;
}

// ── Page-side helpers ─────────────────────────────────────────────────

export interface ConnectOptions {
  /** Timeout in ms for the handshake. Default: 5 000. */
  timeout?: number;
}

/**
 * Connect to a Service Worker and obtain a MessagePort for RPC.
 *
 * Creates a `MessageChannel`, sends one port to the active Service Worker,
 * and waits for an acknowledgement. The returned port satisfies
 * `MessageEndpoint` and can be passed directly to `wrap()`.
 *
 * @param registration The `ServiceWorkerRegistration` from `navigator.serviceWorker.register()`.
 * @param options Optional `{ timeout }` for the handshake (default 5 000 ms).
 * @returns A `MessageEndpoint` connected to the Service Worker.
 *
 * @example
 * ```ts
 * const reg = await navigator.serviceWorker.register("./sw.ts", { type: "module" });
 * const port = await connectServiceWorker(reg);
 * const api = wrap<MyAPI>(port);
 * ```
 */
export async function connectServiceWorker(
  registration: SWRegistration,
  options?: ConnectOptions,
): Promise<MessageEndpoint> {
  const sw = await getActiveSW(registration);
  const timeout = options?.timeout ?? 5_000;

  const { port1, port2 } = new MessageChannel();

  return new Promise<MessageEndpoint>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function onAck(event: MessageEvent) {
      if (event.data?.type === HANDSHAKE_ACK) {
        if (timer) clearTimeout(timer);
        port1.removeEventListener("message", onAck);
        resolve(port1 as unknown as MessageEndpoint);
      }
    }

    port1.addEventListener("message", onAck);
    port1.start();

    sw.postMessage({ type: HANDSHAKE_TYPE }, [port2]);

    if (timeout > 0) {
      timer = setTimeout(() => {
        port1.removeEventListener("message", onAck);
        port1.close();
        reject(
          new TimeoutError(
            `Service Worker handshake timed out after ${timeout}ms`,
            "connectServiceWorker",
            timeout,
          ),
        );
      }, timeout);
    }
  });
}

/**
 * Wait for the Service Worker to reach the "activated" state.
 */
function getActiveSW(reg: SWRegistration): Promise<SWInstance> {
  if (reg.active) return Promise.resolve(reg.active);

  return new Promise<SWInstance>((resolve, reject) => {
    const sw = reg.installing ?? reg.waiting;
    if (!sw) {
      reject(new Error("No Service Worker found in the registration"));
      return;
    }

    function onStateChange() {
      if (sw!.state === "activated") {
        sw!.removeEventListener("statechange", onStateChange);
        resolve(sw!);
      } else if (sw!.state === "redundant") {
        sw!.removeEventListener("statechange", onStateChange);
        reject(new Error("Service Worker became redundant before activating"));
      }
    }

    sw.addEventListener("statechange", onStateChange);
  });
}

// ── Service-Worker-side helpers ───────────────────────────────────────

/**
 * Expose an API inside a Service Worker.
 *
 * Listens for incoming `MessageChannel` handshakes from pages and calls
 * `expose(api, port)` on each connected port. Each page gets its own
 * independent RPC channel.
 *
 * @param api Object mapping method names to functions.
 * @returns A cleanup function that removes the listener.
 *
 * @example
 * ```ts
 * // sw.ts
 * import { exposeServiceWorker } from "thread-weaver/service-worker";
 *
 * exposeServiceWorker({
 *   double(n: number) { return n * 2; },
 * });
 * ```
 */
export function exposeServiceWorker(
  api: Record<string, (...args: any[]) => any>,
): () => void {
  const scope = self as any;

  function onConnect(event: MessageEvent) {
    if (event.data?.type !== HANDSHAKE_TYPE) return;
    const port: MessagePort = event.ports[0];
    if (!port) return;

    expose(api, port as unknown as MessageEndpoint);
    port.postMessage({ type: HANDSHAKE_ACK });
  }

  scope.addEventListener("message", onConnect);
  return () => scope.removeEventListener("message", onConnect);
}

// ── Broadcast ─────────────────────────────────────────────────────────

/**
 * Broadcast a message from a Service Worker to **all** connected window clients.
 *
 * This is independent of RPC channels — any page can listen via `onBroadcast()`.
 *
 * @param data Structured-cloneable data to send to all pages.
 *
 * @example
 * ```ts
 * await broadcast({ type: "cache-updated", url: "/data.json" });
 * ```
 */
export async function broadcast(data: unknown): Promise<void> {
  const scope = self as any;
  const clients: SWClients = scope.clients;
  const all = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of all) {
    client.postMessage({ [BROADCAST_MARKER]: true, data });
  }
}

/**
 * Listen for broadcast messages from a Service Worker.
 *
 * @param handler Called with the broadcast data each time the SW broadcasts.
 * @returns An unsubscribe function.
 *
 * @example
 * ```ts
 * const unsub = onBroadcast((data) => {
 *   console.log("SW says:", data);
 * });
 * // later:
 * unsub();
 * ```
 */
export function onBroadcast(handler: (data: unknown) => void): () => void {
  const container = (navigator as any).serviceWorker as {
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
  };

  function onMessage(event: MessageEvent) {
    if (event.data?.[BROADCAST_MARKER]) {
      handler(event.data.data);
    }
  }

  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}
