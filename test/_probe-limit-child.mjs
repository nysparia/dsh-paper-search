// test/_probe-limit-child.mjs — helper for d50, not a test (run.mjs skips `_`).
//
// Constructs a cache under whatever file-size limit the parent set (d50 runs
// this under `ulimit -f 1`, a 512-byte limit — the same shape as a nearly-full
// disk) and prints what the probe and a real `set()` did, as one JSON line.
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createCache } from '../lib/cache.js';

const file = process.argv[2];
const cache = createCache({ file });
const setOk = cache.set('k', ['x'.repeat(4000)]);
const hit = cache.get('k');
console.log(JSON.stringify({
  writable: cache.writable,
  setOk,
  hit: hit !== null,
  dir: readdirSync(dirname(file)),
}));
