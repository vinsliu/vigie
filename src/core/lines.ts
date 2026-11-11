import { createReadStream } from "node:fs";

/**
 * Longest line read. Real transcript lines are small; a longer one (a huge pasted blob, or hostile input)
 * is skipped instead of being held in memory, which could otherwise take over a gigabyte for a single request.
 */
export const MAX_LINE = 8 * 1024 * 1024;

/**
 * The lines of a text file, one at a time, without ever holding more than `maxLine` bytes of a line.
 * A line longer than that is dropped whole. Lines are decoded as UTF-8 once complete, so a multi-byte
 * character split across two chunks is read correctly. A trailing "\r" is removed.
 */
export async function* readLines(
  path: string,
  { maxLine = MAX_LINE, chunkSize = 256 * 1024 }: { maxLine?: number; chunkSize?: number } = {},
): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false; // inside a line that already went over the limit

  const take = () => Buffer.concat(parts).toString("utf8").replace(/\r$/, "");

  for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
    const buf = chunk as Buffer;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      const end = nl === -1 ? buf.length : nl;
      if (!skipping) {
        size += end - start;
        if (size > maxLine) {
          skipping = true;
          parts = [];
          size = 0;
        } else {
          parts.push(buf.subarray(start, end));
        }
      }
      if (nl === -1) break; // the line continues in the next chunk
      if (!skipping) yield take();
      parts = [];
      size = 0;
      skipping = false;
      start = nl + 1;
    }
  }
  if (!skipping && size > 0) yield take(); // last line without a trailing newline
}
