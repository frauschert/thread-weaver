import { expose } from "../src/worker";

// A small math / string API that runs off the main thread
const api = {
  add(a: number, b: number) {
    return a + b;
  },

  fibonacci(n: number): number {
    if (n <= 1) return n;
    let a = 0,
      b = 1;
    for (let i = 2; i <= n; i++) [a, b] = [b, a + b];
    return b;
  },

  uppercase(text: string) {
    return text.toUpperCase();
  },
};

expose(api);

// Re-export the type so the main thread can import it
export type MathWorkerApi = typeof api;
