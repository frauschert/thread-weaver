import { expose } from "../../src/worker";

/**
 * Count primes up to `n` using trial division.
 * Intentionally CPU-heavy so the difference is visible.
 */
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

/** Count primes in the half-open range (from, to]. */
function countPrimesInRange(from: number, to: number): number {
  let count = 0;
  for (let i = Math.max(2, from + 1); i <= to; i++) {
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

const api = { countPrimes, countPrimesInRange };

expose(api);

export type BenchWorkerApi = typeof api;
