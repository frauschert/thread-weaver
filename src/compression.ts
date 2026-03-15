/** @internal */
export interface CompressionOptions {
  /** Minimum JSON byte size before compressing. */
  threshold: number;
}

const COMPRESSION_AVAILABLE = typeof CompressionStream !== "undefined";

/**
 * Resolve user-facing compression option into internal config.
 * Returns `null` when compression should not be used.
 */
export function resolveCompression(
  opt: boolean | { threshold?: number } | undefined,
): CompressionOptions | null {
  if (!opt || !COMPRESSION_AVAILABLE) return null;
  if (opt === true) return { threshold: 1024 };
  return { threshold: opt.threshold ?? 1024 };
}

/**
 * Compress a message if its JSON representation exceeds the threshold.
 * Returns `{ data, transfer }` — when compressed, `data` is
 * `{ __twCompressed: ArrayBuffer }` and `transfer` contains that buffer.
 */
export async function compressMessage(
  msg: any,
  opts: CompressionOptions,
): Promise<{ data: any; transfer?: Transferable[] }> {
  const json = JSON.stringify(msg);
  if (json.length <= opts.threshold) {
    return { data: msg };
  }
  const encoded = new TextEncoder().encode(json);
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(encoded);
  writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  const buffer = result.buffer as ArrayBuffer;
  return { data: { __twCompressed: buffer }, transfer: [buffer] };
}

/** Check whether inbound data is a compressed envelope. */
export function isCompressed(
  data: any,
): data is { __twCompressed: ArrayBuffer } {
  return data != null && typeof data === "object" && "__twCompressed" in data;
}

/**
 * Decompress a `{ __twCompressed: ArrayBuffer }` envelope back into the
 * original message object.
 */
export async function decompressMessage(data: {
  __twCompressed: ArrayBuffer;
}): Promise<any> {
  const buffer: ArrayBuffer = data.__twCompressed;
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(buffer));
  writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(result));
}
