import { wrap } from "../../src/main";
import type { BenchWorkerApi } from "./bench.worker";

// ---------------------------------------------------------------------------
// Same function inlined on the main thread for comparison
// ---------------------------------------------------------------------------
function countPrimes(n: number): number {
  let count = 0;
  for (let i = 2; i <= n; i++) {
    let isPrime = true;
    for (let j = 2; j * j <= i; j++) {
      if (i % j === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
const log = (msg: string) => {
  const el = $("log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
};
const spinner = $("spinner") as HTMLDivElement;

function startCounter() {
  const el = $("counter");
  let i = 0;
  return setInterval(() => {
    el.textContent = String(i++);
  }, 16); // ~60 fps
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------
const N = 5_000_000; // tune this if the run is too fast / slow

async function run() {
  ($("run") as HTMLButtonElement).disabled = true;
  log(`\nCounting primes up to ${N.toLocaleString()}…\n`);

  // Start a frame counter so the user can see UI freezes
  const counter = startCounter();

  // ---- Main-thread run ----
  log("▸ Main thread (synchronous)…");
  spinner.classList.add("frozen");

  // Yield one frame so the browser paints "frozen" state
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));

  const t0 = performance.now();
  const resultMain = countPrimes(N);
  const mainMs = performance.now() - t0;

  spinner.classList.remove("frozen");
  log(`  Result: ${resultMain.toLocaleString()} primes`);
  log(`  Time:   ${mainMs.toFixed(1)} ms`);
  log(`  ⚠ UI was frozen during this — the counter & spinner stopped\n`);

  // Small pause so the user can see the spinner recover
  await new Promise((r) => setTimeout(r, 500));

  // ---- Worker run (single) ----
  log("▸ Worker thread (via thread-weaver)…");
  const worker = new Worker(new URL("./bench.worker.ts", import.meta.url), {
    type: "module",
  });
  const api = wrap<BenchWorkerApi>(worker);

  const t1 = performance.now();
  const resultWorker = await api.countPrimes(N);
  const workerMs = performance.now() - t1;
  worker.terminate();

  log(`  Result: ${resultWorker.toLocaleString()} primes`);
  log(`  Time:   ${workerMs.toFixed(1)} ms`);
  log(`  ✓ UI stayed responsive — counter & spinner kept running\n`);

  // ---- Parallel workers ----
  const WORKERS = navigator.hardwareConcurrency || 4;
  log(`▸ Parallel workers (${WORKERS}× via thread-weaver)…`);

  const chunkSize = Math.ceil(N / WORKERS);
  const workers: { w: Worker; api: ReturnType<typeof wrap<BenchWorkerApi>> }[] =
    [];

  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(new URL("./bench.worker.ts", import.meta.url), {
      type: "module",
    });
    workers.push({ w, api: wrap<BenchWorkerApi>(w) });
  }

  const t2 = performance.now();
  const results = await Promise.all(
    workers.map((_, i) => {
      const from = i * chunkSize;
      const to = Math.min((i + 1) * chunkSize, N);
      return _.api.countPrimesInRange(from, to);
    }),
  );
  const parallelMs = performance.now() - t2;
  workers.forEach(({ w }) => w.terminate());

  // Sum partial counts from each chunk
  const resultParallel = results.reduce((a, b) => a + b, 0);
  log(`  Result: ${resultParallel.toLocaleString()} primes`);
  log(`  Time:   ${parallelMs.toFixed(1)} ms`);
  log(`  ✓ UI stayed responsive the entire time\n`);

  // ---- Summary ----
  clearInterval(counter);
  log("━".repeat(50));
  log("Summary");
  log("━".repeat(50));
  log(`  Main thread:      ${mainMs.toFixed(1)} ms  (UI blocked)`);
  log(`  Single worker:    ${workerMs.toFixed(1)} ms  (UI responsive)`);
  log(
    `  ${WORKERS} workers:  ${" ".repeat(Math.max(0, 6 - WORKERS.toString().length))}${parallelMs.toFixed(1)} ms  (UI responsive, ${(mainMs / parallelMs).toFixed(1)}× speedup)`,
  );

  ($("run") as HTMLButtonElement).disabled = false;
}

$("run").addEventListener("click", run);
