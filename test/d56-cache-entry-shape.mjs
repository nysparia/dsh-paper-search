// test/d56-cache-entry-shape.mjs — D56 (audit L2 + L3): `get()` served a null
// value as a HIT, and `status()` disagreed with `get()` about a numeric-string
// timestamp.
//
// THE DEFECTS. `get()` guarded on `usedAt` only, never on `value`, and
// `status()` used `v?.usedAt >= limit` (which coerces) while `get()` used
// `typeof v.usedAt !== 'number'` (which rejects). Measured 24 Nov 2026:
//
//   value: null      -> get() HIT {value:null}; perSource[0].papers = null;
//                       dedup THREW TypeError: Cannot read properties of null
//   usedAt: "999000" -> status(): validCount = 1, count = 1
//                       get():    MISS
//   no usedAt at all -> status(): count = 2, validCount = 1
//
// So `paper_status` advertised an entry that could never be served, and a
// hand-edited file could turn a cache read into a TypeError out of `runSearch`.
//
// WHAT THIS TEST PINS:
//   1. a null / absent value is a MISS, not a HIT;
//   2. a non-numeric timestamp is rejected by BOTH `get()` and `status()`;
//   3. unusable entries are counted separately (`unusable`), so "0 valid of 2
//      stored" is not a mystery;
//   4. a healthy entry is unaffected.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d56-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const T0 = 1_000_000;
const TTL = 30 * 60_000;
const now = () => T0;

/** Write one entry straight to disk and return a cache over it. */
const withEntry = (name, entry) => {
  const file = join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, entries: { k: entry } }));
  return createCache({ file, ttlMs: TTL, now });
};

// ── 1. value: null ──────────────────────────────────────────────────────────
{
  const cache = withEntry('null-value', { storedAt: T0 - 1000, usedAt: T0 - 1000, count: 1, value: null });
  check('an entry whose value is null is a MISS', cache.get('k') === null, JSON.stringify(cache.get('k')));
  const s = cache.status();
  check('...status() does not count it as valid', s.validCount === 0, `validCount=${s.validCount}`);
  check('...status() reports it as unusable', s.unusable === 1, `unusable=${s.unusable}`);
}

// ── 2. value absent ─────────────────────────────────────────────────────────
{
  const cache = withEntry('no-value', { storedAt: T0 - 1000, usedAt: T0 - 1000, count: 1 });
  check('an entry with no value at all is a MISS', cache.get('k') === null, JSON.stringify(cache.get('k')));
  check('...and is reported as unusable', cache.status().unusable === 1, `unusable=${cache.status().unusable}`);
}

// ── 3. A numeric STRING timestamp ───────────────────────────────────────────
{
  const cache = withEntry('string-usedAt', { storedAt: T0 - 1000, usedAt: String(T0 - 1000), count: 1, value: ['v'] });
  check('a numeric-string usedAt is a MISS in get()', cache.get('k') === null, JSON.stringify(cache.get('k')));
  const s = cache.status();
  check('...and status() agrees: validCount 0', s.validCount === 0, `validCount=${s.validCount}`);
  check('...and it is reported as unusable', s.unusable === 1, `unusable=${s.unusable}`);
}

// ── 4. No timestamp at all ──────────────────────────────────────────────────
{
  const cache = withEntry('no-usedAt', { storedAt: T0 - 1000, count: 1, value: ['v'] });
  check('an entry with no usedAt is a MISS', cache.get('k') === null, JSON.stringify(cache.get('k')));
  const s = cache.status();
  check('...status() counts it in `count` but not in `validCount`', s.count === 1 && s.validCount === 0,
    `count=${s.count} validCount=${s.validCount}`);
  check('...and says it is unusable', s.unusable === 1, `unusable=${s.unusable}`);
}

// ── 5. A healthy entry is unaffected ────────────────────────────────────────
{
  const cache = withEntry('healthy', { storedAt: T0 - 1000, usedAt: T0 - 1000, count: 1, value: ['v'] });
  check('a healthy entry is still a HIT', cache.get('k')?.value?.[0] === 'v', JSON.stringify(cache.get('k')));
  const s = cache.status();
  check('...and is counted as valid with nothing unusable',
    s.validCount === 1 && s.unusable === 0, `validCount=${s.validCount} unusable=${s.unusable}`);
}

rmSync(root, { recursive: true, force: true });
done('D56 a null value was a HIT and status()/get() disagreed');
