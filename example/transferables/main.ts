import { wrap } from "../../src/main";
import { transfer } from "../../src/transfer";
import type { ImageWorkerApi } from "./transfer.worker";

const $ = (id: string) => document.getElementById(id)!;
const log = (msg: string) => {
  const el = $("log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
};

const SIZE = 64 * 1024 * 1024; // 64 MB

const worker = new Worker(new URL("./transfer.worker.ts", import.meta.url), {
  type: "module",
});
const api = wrap<ImageWorkerApi>(worker);

async function runStructuredClone() {
  log("▸ Without transferables (structured clone)…");
  const buf = new ArrayBuffer(SIZE);
  new Uint8Array(buf).fill(42);

  const t0 = performance.now();
  // postMessage without transfer list → full copy both ways
  const result = await api.doubleBytes(buf);
  const ms = performance.now() - t0;

  log(`  Buffer size: ${(SIZE / 1024 / 1024).toFixed(0)} MB`);
  log(`  Round-trip:  ${ms.toFixed(1)} ms`);
  log(`  Main-thread buffer still usable: byteLength = ${buf.byteLength}`);
  log(`  Result[0] = ${new Uint8Array(result)[0]} (expected 84)\n`);
}

async function runTransferable() {
  log("▸ With transferables (zero-copy)…");
  const buf = new ArrayBuffer(SIZE);
  new Uint8Array(buf).fill(42);

  const t0 = performance.now();
  // transfer() wraps the arg so postMessage moves it instead of copying
  const result = await api.doubleBytes(transfer(buf, [buf]) as any);
  const ms = performance.now() - t0;

  log(`  Buffer size: ${(SIZE / 1024 / 1024).toFixed(0)} MB`);
  log(`  Round-trip:  ${ms.toFixed(1)} ms`);
  log(
    `  Main-thread buffer neutered: byteLength = ${buf.byteLength} (expected 0)`,
  );
  log(`  Result[0] = ${new Uint8Array(result)[0]} (expected 84)\n`);
}

async function runGenerate() {
  log("▸ Worker-generated buffer (transferred back)…");

  const t0 = performance.now();
  const buf = await api.generateBuffer(SIZE);
  const ms = performance.now() - t0;

  log(`  Buffer size: ${(SIZE / 1024 / 1024).toFixed(0)} MB`);
  log(`  Transfer:    ${ms.toFixed(1)} ms`);
  log(
    `  buf[0] = ${new Uint8Array(buf)[0]}, buf[255] = ${new Uint8Array(buf)[255]}\n`,
  );
}

async function run() {
  ($("run") as HTMLButtonElement).disabled = true;
  $("log").textContent = "";
  log(`Transferables demo — ${(SIZE / 1024 / 1024).toFixed(0)} MB buffers\n`);

  await runStructuredClone();
  await runTransferable();
  await runGenerate();

  log("━".repeat(50));
  log("Done! Compare the round-trip times above.");
  log("With transferables the buffer moves instantly (zero-copy),");
  log("but the sender's buffer becomes neutered (byteLength = 0).");

  ($("run") as HTMLButtonElement).disabled = false;
}

$("run").addEventListener("click", run);
