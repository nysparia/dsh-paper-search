// test/_cache-writer-child.mjs — helper for d54, not a test (run.mjs skips `_`).
//
// Writes `count` entries of ~4 kB into the cache file given on the command
// line. d54 runs several of these at once against ONE file, which is the shape
// that used to publish a truncated `.part`.
import { createCache } from '../lib/cache.js';

const file = process.argv[2];
const count = Number(process.argv[3] ?? 200);
const cache = createCache({ file });
for (let i = 0; i < count; i += 1) cache.set(`k${i}`, ['v'.repeat(4000)]);
