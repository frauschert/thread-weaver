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
  const activeStreams = new Map<number, { cancel(): void }>();
  const activeAborts = new Map<number, AbortController>();

  self.addEventListener("message", async (event: MessageEvent) => {
    const { id, method, args, type } = event.data;

    // Handle stream cancellation from main thread
    if (type === "cancel") {
      const stream = activeStreams.get(id);
      if (stream) {
        stream.cancel();
        activeStreams.delete(id);
      }
      const controller = activeAborts.get(id);
      if (controller) {
        controller.abort();
        activeAborts.delete(id);
      }
      return;
    }

    if (!Object.hasOwn(api, method) || typeof api[method] !== "function") {
      self.postMessage({
        id,
        error: serializeError(new Error(`Unknown method: ${String(method)}`)),
      });
      return;
    }

    try {
      const controller = new AbortController();
      activeAborts.set(id, controller);
      const raw = await api[method](...args, controller.signal);
      activeAborts.delete(id);

      // Check for async iterable (async generators)
      if (
        raw != null &&
        typeof raw === "object" &&
        Symbol.asyncIterator in raw
      ) {
        let cancelled = false;
        activeStreams.set(id, {
          cancel() {
            cancelled = true;
          },
        });

        try {
          for await (const value of raw) {
            if (cancelled) break;
            if (isTransfer(value)) {
              self.postMessage(
                { id, type: "next", value: value.value },
                value.transferables,
              );
            } else {
              self.postMessage({ id, type: "next", value });
            }
          }
          if (!cancelled) {
            self.postMessage({ id, type: "done" });
          }
        } catch (error) {
          if (!cancelled) {
            self.postMessage({
              id,
              type: "error",
              error: serializeError(error),
            });
          }
        } finally {
          activeStreams.delete(id);
        }
        return;
      }

      if (isTransfer(raw)) {
        self.postMessage({ id, result: raw.value }, raw.transferables);
      } else {
        self.postMessage({ id, result: raw });
      }
    } catch (error) {
      activeAborts.delete(id);
      self.postMessage({ id, error: serializeError(error) });
    }
  });
}
