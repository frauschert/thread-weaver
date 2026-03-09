import { isTransfer } from "./transfer";

export { transfer } from "./transfer";
export type { Transfer } from "./transfer";

export function expose(api: Record<string, (...args: any[]) => any>) {
  self.addEventListener("message", async (event: MessageEvent) => {
    const { id, method, args } = event.data;

    if (typeof api[method] !== "function") {
      self.postMessage({ id, error: `Unknown method: ${String(method)}` });
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
      self.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
