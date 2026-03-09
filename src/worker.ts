export function expose(api: Record<string, (...args: any[]) => any>) {
  self.addEventListener("message", async (event: MessageEvent) => {
    const { id, method, args } = event.data;

    if (typeof api[method] !== "function") {
      self.postMessage({ id, error: `Unknown method: ${String(method)}` });
      return;
    }

    try {
      const result = await api[method](...args);
      self.postMessage({ id, result });
    } catch (error) {
      self.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
