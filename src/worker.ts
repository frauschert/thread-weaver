import { isTransfer } from "./transfer";

export { transfer } from "./transfer";
export type { Transfer } from "./transfer";

function serializeError(error: unknown): {
  message: string;
  name?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error) };
}

export function expose(api: Record<string, (...args: any[]) => any>) {
  self.addEventListener("message", async (event: MessageEvent) => {
    const { id, method, args } = event.data;

    if (!Object.hasOwn(api, method) || typeof api[method] !== "function") {
      self.postMessage({
        id,
        error: serializeError(new Error(`Unknown method: ${String(method)}`)),
      });
      return;
    }

    try {
      const raw = await api[method](...args);
      if (isTransfer(raw)) {
        self.postMessage({ id, result: raw.value }, raw.transferables);
      } else {
        self.postMessage({ id, result: raw });
      }
    } catch (error) {
      self.postMessage({ id, error: serializeError(error) });
    }
  });
}
