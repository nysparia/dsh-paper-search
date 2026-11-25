// test/d53-cache-entries-array.mjs — D53 (audit M3): `read()` accepted
// `entries: []` as a healthy cache, so `set()` reported success and the entry
// was silently lost.
//
// THE DEFECT. The shape guard was `typeof j.entries !== 'object'`, and
// `typeof [] === 'object'`, so an array passed. `content.entries[key] = …` then
// set a NON-INDEX property, which `JSON.stringify` drops. Measured 24 Nov 2026
// with `{"version":1,"entries":[]}`:
//
//   status().corrupt = false
//   set() returned: true
//   file on disk now: {"version":1,"entries":[]}
//   get() -> null
//
// A working cache that never hits, with every layer reporting success. That is
// the worst shape a cache can fail in, so an array (and any non-plain object)
// is now CORRUPT.
//
// WHAT THIS TEST PINS:
//   1. `entries: []` is reported as corrupt;
//   2. `set()` on it really stores the entry and `get()` serves it;
//   3. a plain `entries: {}` is still healthy (the guard did not over-reject).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d53-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// ── 1. entries is an ARRAY ──────────────────────────────────────────────────
{
  const file = join(root, 'array.json');
  writeFileSync(file, '{"version":1,"entries":[]}');
  const cache = createCache({ file });
  check('an array of entries is reported as corrupt', cache.status().corrupt === true,
    `corrupt=${cache.status().corrupt}`);
  check('set() on it reports success', cache.set('k', ['paper-A']) === true);
  check('...and the entry is really served back', cache.get('k')?.value?.[0] === 'paper-A',
    JSON.stringify(cache.get('k')));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  check('...and it is on disk as a real entry, not a dropped property',
    raw.entries?.k?.value?.[0] === 'paper-A', JSON.stringify(raw).slice(0, 120));
  check('the file is no longer reported as corrupt', cache.status().corrupt === false);
}

// ── 2. A plain object is still healthy ──────────────────────────────────────
{
  const file = join(root, 'object.json');
  writeFileSync(file, '{"version":1,"entries":{}}');
  const cache = createCache({ file });
  check('a plain `entries: {}` is NOT reported as corrupt', cache.status().corrupt === false,
    `corrupt=${cache.status().corrupt}`);
  check('...and it stores and serves normally',
    cache.set('k', ['paper-B']) === true && cache.get('k')?.value?.[0] === 'paper-B');
}

rmSync(root, { recursive: true, force: true });
done('D53 read() accepted entries: []');
