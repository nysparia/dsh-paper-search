// test/d73-cache-limits-clamped.mjs — D73 (audit M2): `maxEntries <= 0` broke
// `set()`.
//
// THE DEFECT. `prune()` ran `keys.reduce(...)` with no initial value once the
// entry list was empty, and `maxEntries: 0` made `set()` report success while
// storing nothing. Measured 24 Nov 2026:
//
//   maxEntries: 0  -> set() returned: true | entries on disk: [] | get(): null
//   maxEntries: -1 -> set() THREW: TypeError: Reduce of empty array with no
//                     initial value
//
// `set()` is documented to return false on failure and is called from
// `lib/index.js` inside `Promise.all`, so one bad config rejected the whole
// search. With 0 the opposite happened: the caller believed it had a warm cache
// that was permanently cold.
//
// WHAT THIS TEST PINS:
//   1. `maxEntries: -1` does not throw out of `set()`, and the entry is stored;
//   2. `maxEntries: 0` stores the entry instead of silently dropping it;
//   3. the caps reported by `status()` are the clamped ones;
//   4. `maxBytes: 0` does not throw either, and is clamped to a usable floor.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d83-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const T0 = 1_000_000;
const now = () => T0;

/** Run `set()` and report a throw instead of letting it abort the test file. */
const trySet = (cache, key, value) => {
  try {
    return { ok: cache.set(key, value), threw: null };
  } catch (e) {
    return { ok: null, threw: `${e.constructor.name}: ${e.message}` };
  }
};

// ── 1. maxEntries: -1 ───────────────────────────────────────────────────────
{
  const file = join(root, 'negative.json');
  const cache = createCache({ file, maxEntries: -1, now });
  const r = trySet(cache, 'k', ['v']);
  check('maxEntries: -1 does not throw out of set()', r.threw === null, r.threw ?? 'no throw');
  check('maxEntries: -1 still stores the entry', r.ok === true && cache.get('k')?.value?.[0] === 'v',
    `set=${r.ok} get=${JSON.stringify(cache.get('k'))}`);
  check('status() reports the clamped cap (1, not -1)', cache.status().maxEntries === 1,
    `maxEntries=${cache.status().maxEntries}`);
}

// ── 2. maxEntries: 0 ────────────────────────────────────────────────────────
{
  const file = join(root, 'zero.json');
  const cache = createCache({ file, maxEntries: 0, now });
  const r = trySet(cache, 'k', ['v']);
  check('maxEntries: 0 does not throw out of set()', r.threw === null, r.threw ?? 'no throw');
  check('maxEntries: 0 stores the entry instead of reporting a no-op as success',
    r.ok === true && cache.get('k')?.value?.[0] === 'v',
    `set=${r.ok} get=${JSON.stringify(cache.get('k'))}`);
  check('status() reports the clamped cap (1, not 0)', cache.status().maxEntries === 1,
    `maxEntries=${cache.status().maxEntries}`);
}

// ── 3. maxBytes: 0 ──────────────────────────────────────────────────────────
{
  const file = join(root, 'bytes.json');
  const cache = createCache({ file, maxBytes: 0, now });
  const r = trySet(cache, 'k', ['v']);
  check('maxBytes: 0 does not throw out of set()', r.threw === null, r.threw ?? 'no throw');
  check('maxBytes: 0 is clamped to a floor that can hold an entry',
    cache.status().maxBytes >= 1024, `maxBytes=${cache.status().maxBytes}`);
  check('...so the entry is actually stored', r.ok === true && cache.get('k') !== null,
    `set=${r.ok} get=${JSON.stringify(cache.get('k'))}`);
}

rmSync(root, { recursive: true, force: true });
done('D73 maxEntries <= 0 broke set()');
