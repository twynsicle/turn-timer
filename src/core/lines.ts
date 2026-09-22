import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

export interface Line {
  text: string;
  /** Byte offset of the start of this line in the file. */
  offset: number;
}

/**
 * Stream a file line by line, tracking byte offsets so records can be re-read later.
 * Works on arbitrarily large files; a trailing partial line (file still being written) is
 * yielded too and left to the caller's JSON.parse to reject.
 */
export async function* readLines(path: string, start = 0, end?: number): AsyncGenerator<Line> {
  const stream = createReadStream(path, { start, end, highWaterMark: 1 << 20 });
  // Pieces of the current (incomplete) line. Kept as a list so very long lines
  // (multi-MB tool results) are concatenated once rather than once per chunk.
  let pending: Buffer[] = [];
  let lineStart = start;
  let pos = start;
  const emit = (buf: Buffer, offset: number): Line | undefined => {
    let len = buf.length;
    if (len && buf[len - 1] === 0x0d) len--;
    return len ? { text: buf.toString("utf8", 0, len), offset } : undefined;
  };
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl === -1) break;
      const piece = chunk.subarray(from, nl);
      const line = pending.length ? emit(Buffer.concat([...pending, piece]), lineStart) : emit(piece, lineStart);
      pending = [];
      if (line) yield line;
      from = nl + 1;
      lineStart = pos + from;
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
    pos += chunk.length;
  }
  if (pending.length) {
    const line = emit(Buffer.concat(pending), lineStart);
    if (line) yield line;
  }
}

/** Read the single JSONL line starting at `offset`. */
export async function readLineAt(path: string, offset: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const parts: Buffer[] = [];
    let pos = offset;
    const size = 1 << 16;
    for (;;) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, pos);
      if (bytesRead === 0) break;
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (nl !== -1) {
        parts.push(buf.subarray(0, nl));
        break;
      }
      parts.push(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return Buffer.concat(parts).toString("utf8").replace(/\r$/, "");
  } finally {
    await fh.close();
  }
}

export function tryParse(text: string): any | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
