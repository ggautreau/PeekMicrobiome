// Mirrors web/app.js downsample() using the same Web Streams APIs, run in Node.
// Cuts the first 1000 reads from a gzipped FASTQ and checks line counts.
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
const maxReads = Number(process.argv[4] || 1000);

const head = Buffer.alloc(2);
const fd = fs.openSync(inputPath, 'r');
fs.readSync(fd, head, 0, 2, 0);
fs.closeSync(fd);
const isGz = head[0] === 0x1f && head[1] === 0x8b;

const targetNewlines = maxReads * 4;

// Build a Web ReadableStream from the (possibly gunzipped) Node stream.
const nodeStream = isGz
  ? fs.createReadStream(inputPath).pipe(createGunzip())
  : fs.createReadStream(inputPath);

const webIn = Readable.toWeb(nodeStream);

let newlines = 0;
const trimmed = new ReadableStream({
  async start(controller) {
    const reader = webIn.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // node's web stream may hand us Buffers — coerce to Uint8Array views
      const arr = value instanceof Uint8Array ? value : new Uint8Array(value);
      let cutoff = -1;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === 0x0A) {
          newlines++;
          if (newlines === targetNewlines) { cutoff = i + 1; break; }
        }
      }
      if (cutoff >= 0) {
        controller.enqueue(arr.subarray(0, cutoff));
        controller.close();
        await reader.cancel();
        return;
      }
      controller.enqueue(arr);
    }
    controller.close();
  },
});

const out = fs.createWriteStream(outputPath);
await pipeline(Readable.fromWeb(trimmed), out);

const lines = fs.readFileSync(outputPath, 'utf-8').split('\n');
// trailing newline yields an empty last element
const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
console.log(JSON.stringify({
  inputBytes: fs.statSync(inputPath).size,
  outputBytes: fs.statSync(outputPath).size,
  newlinesCounted: newlines,
  expectedNewlines: targetNewlines,
  lineCount,
  readsKept: Math.floor(newlines / 4),
  firstHeader: lines[0],
  lastHeader: lines[(maxReads - 1) * 4],
}, null, 2));
