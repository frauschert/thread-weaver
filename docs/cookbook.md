# Cookbook / Recipes

Common patterns and real-world examples for **thread-weaver**.

---

## Table of Contents

1. [Image Processing Pipeline](#1-image-processing-pipeline)
2. [WASM in a Worker](#2-wasm-in-a-worker)
3. [SQLite / Database Queries](#3-sqlite--database-queries)
4. [CSV Parsing with Progress](#4-csv-parsing-with-progress)
5. [Markdown Rendering](#5-markdown-rendering)
6. [Debounced Search / Fuzzy Matching](#6-debounced-search--fuzzy-matching)
7. [Encryption / Hashing](#7-encryption--hashing)
8. [JSON Schema Validation](#8-json-schema-validation)
9. [PDF Generation](#9-pdf-generation)
10. [Parallel Map-Reduce with a Pool](#10-parallel-map-reduce-with-a-pool)
11. [Long-Lived Stateful Session](#11-long-lived-stateful-session)
12. [Real-Time Data Processing with Event Emitters](#12-real-time-data-processing-with-event-emitters)
13. [Retry on Worker Crash](#13-retry-on-worker-crash)
14. [Shared Worker (Multi-Tab)](#14-shared-worker-multi-tab)

---

## 1. Image Processing Pipeline

Offload image manipulation (resize, filter, convert) to a worker. Transfer pixel data zero-copy with `ArrayBuffer`.

### Worker

```ts
// image.worker.ts
import { expose, transfer } from "thread-weaver/worker";

const api = {
  async grayscale(imageData: ArrayBuffer, width: number, height: number) {
    const pixels = new Uint8ClampedArray(imageData);
    for (let i = 0; i < pixels.length; i += 4) {
      const avg = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = avg;
    }
    return transfer(pixels.buffer, [pixels.buffer]);
  },

  async resize(
    imageData: ArrayBuffer,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
  ) {
    const src = new Uint8ClampedArray(imageData);
    const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4);
    const xRatio = srcWidth / dstWidth;
    const yRatio = srcHeight / dstHeight;

    for (let y = 0; y < dstHeight; y++) {
      for (let x = 0; x < dstWidth; x++) {
        const srcX = Math.floor(x * xRatio);
        const srcY = Math.floor(y * yRatio);
        const srcIdx = (srcY * srcWidth + srcX) * 4;
        const dstIdx = (y * dstWidth + x) * 4;
        dst[dstIdx] = src[srcIdx];
        dst[dstIdx + 1] = src[srcIdx + 1];
        dst[dstIdx + 2] = src[srcIdx + 2];
        dst[dstIdx + 3] = src[srcIdx + 3];
      }
    }
    return transfer(dst.buffer, [dst.buffer]);
  },

  /** Pipeline: resize then grayscale */
  async pipeline(
    imageData: ArrayBuffer,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
  ) {
    const resized = await api.resize(imageData, srcW, srcH, dstW, dstH);
    // resized is a Transfer, unwrap the buffer
    const buf = resized.value ?? resized;
    return api.grayscale(buf as ArrayBuffer, dstW, dstH);
  },
};

expose(api);

export type ImageApi = typeof api;
```

### Main Thread

```ts
import { wrap, transfer } from "thread-weaver";
import type { ImageApi } from "./image.worker";

const worker = new Worker(new URL("./image.worker.ts", import.meta.url), {
  type: "module",
});
const img = wrap<ImageApi>(worker);

// Get image data from a canvas
const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;
const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

// Transfer the pixel buffer to the worker (zero-copy)
const result = await img.grayscale(
  transfer(imageData.data.buffer, [imageData.data.buffer]),
  canvas.width,
  canvas.height,
);

// Put processed pixels back
const processed = new ImageData(
  new Uint8ClampedArray(result),
  canvas.width,
  canvas.height,
);
ctx.putImageData(processed, 0, 0);

img.dispose();
worker.terminate();
```

---

## 2. WASM in a Worker

Load and run a WebAssembly module entirely off the main thread.

### Worker

```ts
// wasm.worker.ts
import { expose, transfer } from "thread-weaver/worker";
import { proxy } from "thread-weaver/worker";

let wasmInstance: WebAssembly.Instance | null = null;

const api = {
  /** Load the WASM module once. Call this before other methods. */
  async init(wasmBytes: ArrayBuffer) {
    const { instance } = await WebAssembly.instantiate(wasmBytes);
    wasmInstance = instance;
  },

  /** Call an exported WASM function. */
  compute(fnName: string, ...args: number[]): number {
    if (!wasmInstance)
      throw new Error("WASM not initialized — call init() first");
    const fn = wasmInstance.exports[fnName] as (...args: number[]) => number;
    if (typeof fn !== "function") throw new Error(`Unknown export: ${fnName}`);
    return fn(...args);
  },

  /** Process a buffer through WASM and return the result. */
  async processBuffer(inputBuffer: ArrayBuffer): Promise<ArrayBuffer> {
    if (!wasmInstance) throw new Error("WASM not initialized");
    const memory = wasmInstance.exports.memory as WebAssembly.Memory;
    const alloc = wasmInstance.exports.alloc as (n: number) => number;
    const process = wasmInstance.exports.process as (
      ptr: number,
      len: number,
    ) => number;
    const free = wasmInstance.exports.free as (ptr: number) => void;

    const input = new Uint8Array(inputBuffer);
    const ptr = alloc(input.length);
    new Uint8Array(memory.buffer, ptr, input.length).set(input);

    const outLen = process(ptr, input.length);
    const output = new Uint8Array(memory.buffer, ptr, outLen).slice();
    free(ptr);

    return transfer(output.buffer, [output.buffer]);
  },
};

expose(api);

export type WasmApi = typeof api;
```

### Main Thread

```ts
import { wrap, transfer } from "thread-weaver";
import type { WasmApi } from "./wasm.worker";

const worker = new Worker(new URL("./wasm.worker.ts", import.meta.url), {
  type: "module",
});
const wasm = wrap<WasmApi>(worker);

// Load the WASM binary and transfer it to the worker
const response = await fetch("/compute.wasm");
const bytes = await response.arrayBuffer();
await wasm.init(transfer(bytes, [bytes]));

// Call exported WASM functions
const result = wasm.compute("fibonacci", 42);
console.log(await result); // 267914296
```

---

## 3. SQLite / Database Queries

Run SQL queries in a worker using `sql.js` (SQLite compiled to WASM). Keep the database in the worker and query it from the main thread.

### Worker

```ts
// db.worker.ts
import { expose, transfer } from "thread-weaver/worker";
import { proxy } from "thread-weaver/worker";
import initSqlJs, { type Database } from "sql.js";

let db: Database | null = null;

const api = {
  /** Initialize the database from a file or empty. */
  async init(data?: ArrayBuffer) {
    const SQL = await initSqlJs();
    db = data ? new SQL.Database(new Uint8Array(data)) : new SQL.Database();
  },

  /** Execute a statement (INSERT, UPDATE, CREATE, etc.) */
  exec(sql: string, params?: Record<string, any>) {
    if (!db) throw new Error("Database not initialized");
    db.run(sql, params);
    return db.getRowsModified();
  },

  /** Query and return all rows. */
  query(sql: string, params?: Record<string, any>) {
    if (!db) throw new Error("Database not initialized");
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);

    const rows: Record<string, any>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  },

  /** Stream rows one at a time for large result sets. */
  async *queryStream(sql: string, params?: Record<string, any>) {
    if (!db) throw new Error("Database not initialized");
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);

    while (stmt.step()) {
      yield stmt.getAsObject();
    }
    stmt.free();
  },

  /** Export the entire database as a transferable ArrayBuffer. */
  exportDb() {
    if (!db) throw new Error("Database not initialized");
    const data = db.export();
    const buf = data.buffer as ArrayBuffer;
    return transfer(buf, [buf]);
  },

  close() {
    db?.close();
    db = null;
  },
};

expose(api);

export type DbApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { DbApi } from "./db.worker";

const worker = new Worker(new URL("./db.worker.ts", import.meta.url), {
  type: "module",
});
const db = wrap<DbApi>(worker, { timeout: 30_000 });

await db.init();

await db.exec(
  `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)`,
);
await db.exec(`INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')`);
await db.exec(`INSERT INTO users VALUES (2, 'Bob', 'bob@example.com')`);

// Standard query
const users = await db.query("SELECT * FROM users WHERE name LIKE $name", {
  $name: "%li%",
});
console.log(users); // [{ id: 1, name: "Alice", email: "alice@example.com" }]

// Stream large result sets
const stream = await db.queryStream("SELECT * FROM users");
for await (const row of stream) {
  console.log(row);
}

// Export and save
const backup = await db.exportDb();
// save `backup` as a file download or to IndexedDB

db.dispose();
worker.terminate();
```

---

## 4. CSV Parsing with Progress

Parse a large CSV file in a worker with progress callbacks.

### Worker

```ts
// csv.worker.ts
import { expose } from "thread-weaver/worker";

const api = {
  async parseCSV(
    text: string,
    onProgress: (percent: number) => void,
    signal: AbortSignal,
  ) {
    const lines = text.split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows: Record<string, string>[] = [];

    for (let i = 1; i < lines.length; i++) {
      if (signal.aborted) return rows; // cooperative cancellation

      const values = lines[i].split(",").map((v) => v.trim());
      if (values.length === headers.length) {
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          row[headers[j]] = values[j];
        }
        rows.push(row);
      }

      // Report progress every 1000 rows
      if (i % 1000 === 0) {
        await onProgress(Math.round((i / lines.length) * 100));
      }
    }

    await onProgress(100);
    return rows;
  },
};

expose(api);

export type CsvApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { CsvApi } from "./csv.worker";

const worker = new Worker(new URL("./csv.worker.ts", import.meta.url), {
  type: "module",
});
const csv = wrap<CsvApi>(worker);

const file = document.querySelector<HTMLInputElement>("#file-input")!.files![0];
const text = await file.text();

const rows = await csv.parseCSV(text, (pct) => {
  document.querySelector("#progress")!.textContent = `${pct}%`;
});

console.log(`Parsed ${rows.length} rows`);

csv.dispose();
worker.terminate();
```

---

## 5. Markdown Rendering

Render Markdown to HTML off the main thread using a library like `marked`.

### Worker

```ts
// markdown.worker.ts
import { expose } from "thread-weaver/worker";
import { marked } from "marked";

const api = {
  render(markdown: string): string {
    return marked.parse(markdown, { async: false }) as string;
  },

  /** Streaming: render sections as they're parsed. */
  async *renderSections(markdown: string) {
    const sections = markdown.split(/(?=^#{1,3}\s)/m);
    for (const section of sections) {
      yield {
        html: marked.parse(section, { async: false }) as string,
        raw: section,
      };
    }
  },
};

expose(api);

export type MarkdownApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { MarkdownApi } from "./markdown.worker";

const worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), {
  type: "module",
});
const md = wrap<MarkdownApi>(worker);

// One-shot render
const html = await md.render("# Hello\n\nWorld");
document.querySelector("#preview")!.innerHTML = html;

// Stream sections for progressive rendering
const container = document.querySelector("#preview")!;
container.innerHTML = "";
const stream = await md.renderSections(longDocument);
for await (const { html } of stream) {
  container.insertAdjacentHTML("beforeend", html);
}
```

---

## 6. Debounced Search / Fuzzy Matching

Run fuzzy search on a large dataset in a worker. Cancel previous searches on new input.

### Worker

```ts
// search.worker.ts
import { expose } from "thread-weaver/worker";

let items: string[] = [];

const api = {
  /** Load the dataset to search. */
  loadItems(data: string[]) {
    items = data;
  },

  /** Fuzzy search — respects AbortSignal for cancellation. */
  search(query: string, limit: number, signal: AbortSignal): string[] {
    if (!query) return [];
    const lower = query.toLowerCase();
    const results: { item: string; score: number }[] = [];

    for (const item of items) {
      if (signal.aborted) return [];

      const idx = item.toLowerCase().indexOf(lower);
      if (idx !== -1) {
        results.push({ item, score: idx === 0 ? 0 : 1 });
      }
    }

    return results
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map((r) => r.item);
  },
};

expose(api);

export type SearchApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { SearchApi } from "./search.worker";

const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
  type: "module",
});
const search = wrap<SearchApi>(worker);

// Load data once
await search.loadItems(hugeList); // e.g. 100k items

// Debounced search with automatic cancellation
let controller: AbortController | null = null;

input.addEventListener("input", async () => {
  controller?.abort(); // cancel previous search
  controller = new AbortController();

  try {
    const results = await search
      .search(input.value, 20)
      .signal(controller.signal);
    renderResults(results);
  } catch {
    // AbortError — user typed again, ignore
  }
});
```

---

## 7. Encryption / Hashing

Use the Web Crypto API in a worker for heavy hashing or encryption without blocking the UI.

### Worker

```ts
// crypto.worker.ts
import { expose, transfer } from "thread-weaver/worker";

const api = {
  async hash(data: ArrayBuffer, algorithm = "SHA-256"): Promise<string> {
    const hashBuffer = await crypto.subtle.digest(algorithm, data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  },

  /** Hash multiple files in sequence, streaming results. */
  async *hashFiles(files: { name: string; data: ArrayBuffer }[]) {
    for (const file of files) {
      const hex = await api.hash(file.data);
      yield { name: file.name, hash: hex };
    }
  },

  /** AES-GCM encrypt */
  async encrypt(plaintext: ArrayBuffer, password: string) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plaintext,
    );
    // Pack salt + iv + ciphertext into a single buffer
    const result = new Uint8Array(
      salt.length + iv.length + ciphertext.byteLength,
    );
    result.set(salt, 0);
    result.set(iv, salt.length);
    result.set(new Uint8Array(ciphertext), salt.length + iv.length);
    return transfer(result.buffer as ArrayBuffer, [
      result.buffer as ArrayBuffer,
    ]);
  },

  /** AES-GCM decrypt */
  async decrypt(packed: ArrayBuffer, password: string) {
    const data = new Uint8Array(packed);
    const salt = data.slice(0, 16);
    const iv = data.slice(16, 28);
    const ciphertext = data.slice(28);
    const key = await deriveKey(password, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return transfer(plaintext, [plaintext]);
  },
};

async function deriveKey(password: string, salt: Uint8Array) {
  const raw = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

expose(api);

export type CryptoApi = typeof api;
```

### Main Thread

```ts
import { wrap, transfer } from "thread-weaver";
import type { CryptoApi } from "./crypto.worker";

const worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), {
  type: "module",
});
const crypt = wrap<CryptoApi>(worker);

// Hash a file
const file = inputEl.files![0];
const buf = await file.arrayBuffer();
const hash = await crypt.hash(transfer(buf, [buf]));
console.log(`SHA-256: ${hash}`);

// Encrypt / decrypt round-trip
const plaintext = new TextEncoder().encode("secret message");
const encrypted = await crypt.encrypt(
  plaintext.buffer as ArrayBuffer,
  "my-password",
);
const decrypted = await crypt.decrypt(encrypted, "my-password");
console.log(new TextDecoder().decode(decrypted)); // "secret message"
```

---

## 8. JSON Schema Validation

Validate data against a JSON Schema in a worker using `ajv`.

### Worker

```ts
// validation.worker.ts
import { expose } from "thread-weaver/worker";
import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({ allErrors: true });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

const api = {
  /** Register a schema by name. */
  addSchema(name: string, schema: object) {
    validators.set(name, ajv.compile(schema));
  },

  /** Validate data against a named schema. */
  validate(
    schemaName: string,
    data: unknown,
  ): { valid: boolean; errors: ErrorObject[] | null } {
    const validate = validators.get(schemaName);
    if (!validate) throw new Error(`Unknown schema: ${schemaName}`);
    const valid = validate(data) as boolean;
    return { valid, errors: valid ? null : (validate.errors ?? null) };
  },

  /** Validate many items, streaming results. */
  async *validateBatch(schemaName: string, items: unknown[]) {
    const validate = validators.get(schemaName);
    if (!validate) throw new Error(`Unknown schema: ${schemaName}`);

    for (let i = 0; i < items.length; i++) {
      const valid = validate(items[i]) as boolean;
      yield {
        index: i,
        valid,
        errors: valid ? null : structuredClone(validate.errors),
      };
    }
  },
};

expose(api);

export type ValidationApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { ValidationApi } from "./validation.worker";

const worker = new Worker(new URL("./validation.worker.ts", import.meta.url), {
  type: "module",
});
const validator = wrap<ValidationApi>(worker);

await validator.addSchema("user", {
  type: "object",
  required: ["name", "email"],
  properties: {
    name: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
  },
});

const result = await validator.validate("user", { name: "", email: "bad" });
console.log(result.valid); // false
console.log(result.errors); // [{ keyword: "minLength", ... }, ...]

// Validate 10k records, streaming results
const stream = await validator.validateBatch("user", largeDataset);
let invalidCount = 0;
for await (const { index, valid, errors } of stream) {
  if (!valid) invalidCount++;
}
console.log(`${invalidCount} invalid records`);
```

---

## 9. PDF Generation

Generate PDFs in a worker using `jsPDF`.

### Worker

```ts
// pdf.worker.ts
import { expose, transfer } from "thread-weaver/worker";
import { jsPDF } from "jspdf";

const api = {
  async generateInvoice(data: {
    items: { name: string; qty: number; price: number }[];
    customer: string;
  }) {
    const doc = new jsPDF();
    doc.setFontSize(20);
    doc.text("Invoice", 20, 20);

    doc.setFontSize(12);
    doc.text(`Customer: ${data.customer}`, 20, 35);

    let y = 50;
    doc.text("Item", 20, y);
    doc.text("Qty", 100, y);
    doc.text("Price", 140, y);
    y += 10;

    let total = 0;
    for (const item of data.items) {
      doc.text(item.name, 20, y);
      doc.text(String(item.qty), 100, y);
      doc.text(`$${(item.qty * item.price).toFixed(2)}`, 140, y);
      total += item.qty * item.price;
      y += 8;
    }

    y += 5;
    doc.setFontSize(14);
    doc.text(`Total: $${total.toFixed(2)}`, 140, y);

    const buf = doc.output("arraybuffer");
    return transfer(buf, [buf]);
  },

  /** Generate multiple PDFs, streaming each as it completes. */
  async *generateBatch(invoices: Parameters<typeof api.generateInvoice>[0][]) {
    for (let i = 0; i < invoices.length; i++) {
      const buf = await api.generateInvoice(invoices[i]);
      yield { index: i, pdf: buf };
    }
  },
};

expose(api);

export type PdfApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { PdfApi } from "./pdf.worker";

const worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), {
  type: "module",
});
const pdf = wrap<PdfApi>(worker);

const invoiceData = {
  customer: "Acme Corp",
  items: [
    { name: "Widget", qty: 10, price: 9.99 },
    { name: "Gadget", qty: 3, price: 24.5 },
  ],
};

const pdfBuffer = await pdf.generateInvoice(invoiceData);

// Download the PDF
const blob = new Blob([pdfBuffer], { type: "application/pdf" });
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = "invoice.pdf";
a.click();
URL.revokeObjectURL(url);
```

---

## 10. Parallel Map-Reduce with a Pool

Distribute work across a pool and aggregate results.

### Worker

```ts
// compute.worker.ts
import { expose } from "thread-weaver/worker";

const api = {
  /** Process a chunk of data and return a partial result. */
  processChunk(numbers: number[]): {
    sum: number;
    count: number;
    min: number;
    max: number;
  } {
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const n of numbers) {
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    return { sum, count: numbers.length, min, max };
  },
};

expose(api);

export type ComputeApi = typeof api;
```

### Main Thread

```ts
import { pool } from "thread-weaver";
import type { ComputeApi } from "./compute.worker";

const workers = pool<ComputeApi>(
  () =>
    new Worker(new URL("./compute.worker.ts", import.meta.url), {
      type: "module",
    }),
  { size: navigator.hardwareConcurrency },
);

// Split 1M numbers into chunks, dispatch to pool
const data = Array.from({ length: 1_000_000 }, () => Math.random() * 1000);
const chunkSize = Math.ceil(data.length / workers.size);
const chunks: number[][] = [];
for (let i = 0; i < data.length; i += chunkSize) {
  chunks.push(data.slice(i, i + chunkSize));
}

// Map: dispatch chunks in parallel
const partials = await Promise.all(
  chunks.map((chunk) => workers.processChunk(chunk)),
);

// Reduce: aggregate partial results
const result = partials.reduce((acc, p) => ({
  sum: acc.sum + p.sum,
  count: acc.count + p.count,
  min: Math.min(acc.min, p.min),
  max: Math.max(acc.max, p.max),
}));

console.log(`Average: ${result.sum / result.count}`);
console.log(`Range: ${result.min} – ${result.max}`);

workers.terminate();
```

---

## 11. Long-Lived Stateful Session

Use `proxy()` to keep a stateful session object in the worker and interact with it from the main thread.

### Worker

```ts
// session.worker.ts
import { expose, emitter } from "thread-weaver/worker";
import { proxy } from "thread-weaver/worker";

const api = {
  createSession(userId: string) {
    const { emit, handle } = emitter<{ expired: string }>();

    const state = {
      userId,
      cart: [] as { id: string; name: string; price: number }[],
      createdAt: Date.now(),
    };

    // Auto-expire after 30 minutes
    const timer = setTimeout(
      () => {
        emit("expired", userId);
      },
      30 * 60 * 1000,
    );

    return handle(
      proxy({
        addToCart(item: { id: string; name: string; price: number }) {
          state.cart.push(item);
          return state.cart.length;
        },

        removeFromCart(itemId: string) {
          state.cart = state.cart.filter((i) => i.id !== itemId);
          return state.cart.length;
        },

        getCart() {
          return structuredClone(state.cart);
        },

        getTotal() {
          return state.cart.reduce((sum, item) => sum + item.price, 0);
        },

        checkout() {
          const order = {
            userId: state.userId,
            items: structuredClone(state.cart),
            total: state.cart.reduce((sum, item) => sum + item.price, 0),
          };
          state.cart = [];
          clearTimeout(timer);
          return order;
        },
      }),
    );
  },
};

expose(api);

export type SessionApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { SessionApi } from "./session.worker";

const worker = new Worker(new URL("./session.worker.ts", import.meta.url), {
  type: "module",
});
const store = wrap<SessionApi>(worker);

// Create a session — returns a RemoteObject with event emitter support
const session = await store.createSession("user-123");

// Listen for session expiry events
session.on("expired", (userId) => {
  console.log(`Session for ${userId} expired`);
});

// Use the session
await session.addToCart({ id: "p1", name: "Widget", price: 9.99 });
await session.addToCart({ id: "p2", name: "Gadget", price: 24.5 });

const cart = await session.getCart();
console.log(cart); // [{ id: "p1", ... }, { id: "p2", ... }]

const total = await session.getTotal();
console.log(`Total: $${total}`); // Total: $34.49

const order = await session.checkout();
console.log(order); // { userId: "user-123", items: [...], total: 34.49 }

// Clean up
session.release();
store.dispose();
worker.terminate();
```

---

## 12. Real-Time Data Processing with Event Emitters

Process a real-time data feed in a worker and push updates to the main thread via events.

### Worker

```ts
// feed.worker.ts
import { expose, emitter } from "thread-weaver/worker";
import { proxy } from "thread-weaver/worker";

const api = {
  /** Start monitoring with a moving-average window. */
  createMonitor(windowSize: number) {
    const { emit, handle } = emitter<{
      tick: { average: number; count: number };
      alert: { message: string; value: number };
    }>();

    const buffer: number[] = [];
    let count = 0;

    return handle(
      proxy({
        /** Push a new data point. */
        push(value: number) {
          buffer.push(value);
          if (buffer.length > windowSize) buffer.shift();
          count++;

          const average = buffer.reduce((a, b) => a + b, 0) / buffer.length;
          emit("tick", { average, count });

          // Emit alert if value exceeds 2x the average
          if (value > average * 2) {
            emit("alert", { message: "Spike detected", value });
          }
        },

        getStats() {
          const avg = buffer.reduce((a, b) => a + b, 0) / buffer.length;
          const min = Math.min(...buffer);
          const max = Math.max(...buffer);
          return {
            average: avg,
            min,
            max,
            samples: count,
            windowSize: buffer.length,
          };
        },
      }),
    );
  },
};

expose(api);

export type FeedApi = typeof api;
```

### Main Thread

```ts
import { wrap } from "thread-weaver";
import type { FeedApi } from "./feed.worker";

const worker = new Worker(new URL("./feed.worker.ts", import.meta.url), {
  type: "module",
});
const feed = wrap<FeedApi>(worker);

const monitor = await feed.createMonitor(50);

// Subscribe to events
monitor.on("tick", ({ average, count }) => {
  document.querySelector("#avg")!.textContent = average.toFixed(2);
  document.querySelector("#count")!.textContent = String(count);
});

monitor.on("alert", ({ message, value }) => {
  console.warn(`${message}: ${value}`);
});

// Simulate a data feed
const source = new EventSource("/api/metrics");
source.addEventListener("message", (event) => {
  monitor.push(parseFloat(event.data));
});

// Cleanup
// source.close();
// monitor.release();
// feed.dispose();
// worker.terminate();
```

---

## 13. Retry on Worker Crash

Use a pool with `respawn: true` to automatically recover from worker crashes.

```ts
import { pool } from "thread-weaver";
import { WorkerCrashedError } from "thread-weaver";
import type { ComputeApi } from "./compute.worker";

const workers = pool<ComputeApi>(
  () =>
    new Worker(new URL("./compute.worker.ts", import.meta.url), {
      type: "module",
    }),
  { size: 2, respawn: true, timeout: 5000 },
);

/** Call with automatic retry on crash. */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WorkerCrashedError && attempt < maxRetries) {
        console.warn(
          `Worker crashed, retrying (${attempt + 1}/${maxRetries})…`,
        );
        continue; // pool auto-respawns, just retry
      }
      throw err;
    }
  }
}

const result = await withRetry(() => workers.processChunk([1, 2, 3]));
```

---

## 14. Shared Worker (Multi-Tab)

Share a single worker across multiple browser tabs using `SharedWorker` and `MessagePort`.

### Shared Worker

```ts
// shared.worker.ts
import { expose } from "thread-weaver/worker";
import type { MessageEndpoint } from "thread-weaver";

const state = { visitors: 0 };

const api = {
  ping() {
    state.visitors++;
    return `pong (${state.visitors} total connections)`;
  },
  getVisitorCount() {
    return state.visitors;
  },
};

// Handle each connecting tab
addEventListener("connect", (event: MessageEvent) => {
  const port = (event as any).ports[0] as MessagePort;
  expose(api, port as unknown as MessageEndpoint);
  port.start();
});
```

### Main Thread (any tab)

```ts
import { wrap } from "thread-weaver";

const shared = new SharedWorker(
  new URL("./shared.worker.ts", import.meta.url),
  { type: "module" },
);

const api = wrap<{ ping(): string; getVisitorCount(): number }>(
  shared.port as any,
);
shared.port.start();

console.log(await api.ping()); // "pong (1 total connections)"
// Open another tab → "pong (2 total connections)"
```

---

## Patterns Summary

| Pattern          | Key Feature Used               | When to Use                      |
| ---------------- | ------------------------------ | -------------------------------- |
| Image processing | `transfer()`, `ArrayBuffer`    | Heavy pixel manipulation         |
| WASM             | `transfer()`, init pattern     | CPU-intensive algorithms         |
| Database         | `async *` streaming, proxy     | Persistent state, large queries  |
| CSV parsing      | Proxy callbacks, `AbortSignal` | Progress reporting, cancellation |
| Markdown         | Streaming, one-shot            | Real-time preview                |
| Search           | `.signal()`, cancellation      | Debounced user input             |
| Crypto           | `transfer()`, `ArrayBuffer`    | Hashing, encryption              |
| Validation       | Streaming, stateful worker     | Batch data validation            |
| PDF              | `transfer()`                   | Document generation              |
| Map-Reduce       | `pool()`, `Promise.all`        | Parallel data processing         |
| Stateful session | `proxy()`, `emitter()`         | Long-lived worker objects        |
| Real-time feed   | `emitter()`, `.on()`           | Live data monitoring             |
| Retry            | `pool({ respawn })`            | Fault tolerance                  |
| Shared Worker    | `expose(api, port)`            | Cross-tab shared state           |
