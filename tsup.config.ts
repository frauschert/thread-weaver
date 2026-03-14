import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    worker: "src/worker.ts",
    "service-worker": "src/service-worker.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
