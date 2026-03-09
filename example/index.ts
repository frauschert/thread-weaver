import { wrap } from "../src/main";
import type { MathWorkerApi } from "./math.worker";

// Spin up the worker (bundler-friendly syntax)
const worker = new Worker(new URL("./math.worker.ts", import.meta.url), {
  type: "module",
});

// Wrap it — every method is now an async function with full type safety
const math = wrap<MathWorkerApi>(worker);

async function main() {
  const sum = await math.add(2, 3);
  console.log("2 + 3 =", sum); // 5

  const fib = await math.fibonacci(10);
  console.log("fib(10) =", fib); // 55

  const loud = await math.uppercase("hello from the worker");
  console.log(loud); // HELLO FROM THE WORKER

  worker.terminate();
}

main();
