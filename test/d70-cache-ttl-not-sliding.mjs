// test/d70-cache-ttl-not-sliding.mjs — D70 (audit H1): `get()` made the TTL
// sliding and reported the wrong age.
//
// THE DEFECT. `get()` refreshed `usedAt` on every hit and then returned the
// refreshed value as `storedAt`, so ONE field answered two different questions.
// Measured 24 Nov 2026 with TTL 30 minutes, one `set()` at t=0 and a `get()`
// every 20 minutes:
//
//   t(min) | hit | ageMs reported | true age of the DATA
//       20 | HIT |  20 min        |  20 min
//       40 | HIT |  20 min        |  40 min
//      300 | HIT |  20 min        | 300 min
//
// An entry read once per TTL never expired, and the reply said "oldest 20
// minutes ago" about data fetched five hours earlier. The argument for the
// refresh was about LRU, and LRU still needs it — so the fix keeps `usedAt`
// for eviction and adds `storedAt` for expiry.
//
// WHAT THIS TEST PINS:
//   1. the TTL measures `storedAt`, so the entry really expires;
//   2. `ageMs` and `storedAt` describe the DATA, not the last read;
//   3. `status()` ages come from `storedAt` too;
//   4. LRU eviction still measures `usedAt` (the refresh was not just deleted);
//   5. a hit does not rewrite the file unless `usedAt` needs refreshing.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d80-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const MIN = 60_000;
const TTL = 30 * MIN;
const T0 = 1_000_000;

// ── 1. The TTL measures the DATA, so it expires ─────────────────────────────
{
  const file = join(root, 'ttl.json');
  let t = T0;
  const cache = createCache({ file, ttlMs: TTL, now: () => t });

  cache.set('k', ['paper-A']);
  t = T0 + 20 * MIN;
  const hit = cache.get('k');
  check('a hit 20 minutes after the insert is still a HIT (TTL 30)',
    hit !== null, hit === null ? 'MISS' : `ageMs=${Math.round(hit.ageMs / MIN)} min`);
  check('ageMs is the age of the DATA (20 min), not time-since-last-read',
    hit !== null && hit.ageMs === 20 * MIN, hit === null ? 'MISS' : `${hit.ageMs} ms`);
  check('storedAt is the INSERT time, not `now`',
    hit !== null && hit.storedAt === T0, hit === null ? 'MISS' : `${hit.storedAt} vs ${T0}`);

  t = T0 + 40 * MIN;
  check('a hit 40 minutes after the insert is a MISS (the TTL did not slide)',
    cache.get('k') === null, cache.get('k') === null ? 'MISS' : 'still a HIT');

  // The on-disk `storedAt` must not move when the entry is read.
  const onDisk = JSON.parse(readFileSync(file, 'utf8')).entries.k;
  check('the stored timestamp on disk is unchanged by a read',
    onDisk.storedAt === T0, `storedAt=${onDisk.storedAt}`);
}

// ── 2. status() reports the age of the DATA too ─────────────────────────────
{
  const file = join(root, 'status.json');
  let t = T0;
  const cache = createCache({ file, ttlMs: TTL, now: () => t });
  cache.set('old', ['v']);
  t = T0 + 10 * MIN;
  cache.set('new', ['v']);
  t = T0 + 20 * MIN;
  cache.get('old'); // a read must not make the entry look younger
  cache.get('new');
  const s = cache.status();
  check('status().oldestMs is the age of the oldest DATA (20 min)',
    s.oldestMs === 20 * MIN, `${s.oldestMs} ms`);
  check('status().newestMs is the age of the newest DATA (10 min)',
    s.newestMs === 10 * MIN, `${s.newestMs} ms`);
  check('both entries are still valid', s.validCount === 2, `validCount=${s.validCount}`);
}

// ── 3. LRU eviction still measures `usedAt` ─────────────────────────────────
//
// The refresh was not simply deleted: a hot entry must survive over a cold one
// even when the cold one is NEWER. A is stored first, B second, A is read, then
// C is stored — B is the least recently used and must go.
{
  const file = join(root, 'lru.json');
  let t = T0;
  const cache = createCache({ file, ttlMs: TTL, maxEntries: 2, now: () => t });
  cache.set('A', ['a']);
  t = T0 + 5 * MIN;
  cache.set('B', ['b']);
  t = T0 + 10 * MIN;
  check('the hot entry is a HIT before the eviction', cache.get('A') !== null);
  t = T0 + 11 * MIN;
  cache.set('C', ['c']);
  check('the least-recently-USED entry (B) was evicted', cache.get('B') === null,
    cache.get('B') === null ? 'MISS' : 'still a HIT');
  check('the recently-read entry (A) survived, though it is the OLDEST by storedAt',
    cache.get('A') !== null, cache.get('A') === null ? 'MISS' : 'HIT');
  check('the entry just stored (C) survived', cache.get('C') !== null);
}

// ── 4. A hit does not rewrite the file unless `usedAt` needs refreshing ─────
//
// Measured 24 Nov 2026 on a 103 kB cache: one `get()` changed the file's mtime
// AND its content, i.e. a read performed a full serialize + rename of up to
// `maxBytes`. The refresh is now batched (once per minute).
{
  const file = join(root, 'amplify.json');
  let t = T0;
  const cache = createCache({ file, ttlMs: TTL, now: () => t });
  cache.set('k', ['v']);
  const before = readFileSync(file, 'utf8');
  t = T0 + 1000;
  check('a hit inside the refresh window is still a HIT', cache.get('k') !== null);
  check('a hit inside the refresh window does NOT rewrite the file',
    readFileSync(file, 'utf8') === before, 'the file changed on a read');

  t = T0 + 61_000;
  check('a hit after the refresh window is still a HIT', cache.get('k') !== null);
  const later = JSON.parse(readFileSync(file, 'utf8')).entries.k;
  check('a hit after the refresh window updates usedAt',
    later.usedAt === T0 + 61_000, `usedAt=${later.usedAt}`);
  check('...and leaves storedAt alone', later.storedAt === T0, `storedAt=${later.storedAt}`);
}

rmSync(root, { recursive: true, force: true });
done('D70 the cache TTL slid on every read');
