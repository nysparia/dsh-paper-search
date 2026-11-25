// test/d51-cache-dropexpired-count.mjs — D51 (audit M1): `dropExpired()`
// returned the number `prune()` removed for ANY reason, and reported a count
// even when the write had failed.
//
// THE DEFECT. It measured the file size before and after a `prune()`, so every
// LRU eviction and every byte-cap eviction was reported as an expiry, and the
// return value of `write()` was discarded. Measured 24 Nov 2026:
//
//   --- A. over maxEntries, NOTHING expired ---
//   file holds 6 entries, all fresh, maxEntries = 3
//   dropExpired() returned: 3        <- 3 removed, 0 of them expired
//
//   --- C. the read-only case ---
//   read-only dir, 1 expired entry -> dropExpired() returned: 1
//   entries still on disk: 1         <- the write failed, nothing was dropped
//
// A caller printing "dropped N expired entries" would state two false things at
// once. `dropExpired` has no caller in `lib/` today, so this is latent, not
// live — but it is exported API and GLOSSARY.md documents it, so it is fixed
// rather than deleted.
//
// WHAT THIS TEST PINS:
//   1. fresh entries are NOT counted as expired, and are NOT evicted by it;
//   2. genuinely expired entries ARE counted;
//   3. a failed write returns null, not a number.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d51-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const MIN = 60_000;
const TTL = 30 * MIN;
const T0 = 1_000_000;

/** Write entries straight to disk, so the caps are not applied on the way in. */
const seed = (file, entries) => writeFileSync(file, JSON.stringify({ version: 1, entries }));
const onDisk = (file) => Object.keys(JSON.parse(readFileSync(file, 'utf8')).entries);

// ── 1. Over the entry cap, nothing expired ──────────────────────────────────
{
  const file = join(root, 'over-cap.json');
  const entries = {};
  for (let i = 0; i < 6; i += 1) entries[`k${i}`] = { storedAt: T0 - i * 1000, usedAt: T0 - i * 1000, count: 1, value: ['v'] };
  seed(file, entries);
  const cache = createCache({ file, ttlMs: TTL, maxEntries: 3, now: () => T0 });
  const dropped = cache.dropExpired();
  check('6 fresh entries over maxEntries: dropExpired() reports 0 expired',
    dropped === 0, `returned ${dropped}`);
  check('...and it did NOT evict the fresh entries (that is set()\'s job)',
    onDisk(file).length === 6, `${onDisk(file).length} entries left`);
}

// ── 2. Genuinely expired entries are counted ────────────────────────────────
{
  const file = join(root, 'expired.json');
  seed(file, {
    fresh: { storedAt: T0 - 1000, usedAt: T0 - 1000, count: 1, value: ['v'] },
    old1: { storedAt: T0 - 60 * MIN, usedAt: T0 - 60 * MIN, count: 1, value: ['v'] },
    old2: { storedAt: T0 - 90 * MIN, usedAt: T0 - 90 * MIN, count: 1, value: ['v'] },
  });
  const cache = createCache({ file, ttlMs: TTL, now: () => T0 });
  const dropped = cache.dropExpired();
  check('2 expired + 1 fresh: dropExpired() reports 2', dropped === 2, `returned ${dropped}`);
  check('...and only the fresh one is left', JSON.stringify(onDisk(file)) === '["fresh"]',
    JSON.stringify(onDisk(file)));
}

// ── 3. A failed write is reported as a failure, not as a count ──────────────
{
  const dir = join(root, 'readonly');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cache-search.json');
  seed(file, { old1: { storedAt: T0 - 60 * MIN, usedAt: T0 - 60 * MIN, count: 1, value: ['v'] } });
  const cache = createCache({ file, ttlMs: TTL, now: () => T0 });
  chmodSync(dir, 0o555);
  const dropped = cache.dropExpired();
  chmodSync(dir, 0o755);
  check('a read-only directory: dropExpired() returns null, not a count',
    dropped === null, `returned ${JSON.stringify(dropped)}`);
  check('...and the file really is unchanged', onDisk(file).length === 1,
    `${onDisk(file).length} entries on disk`);
}

rmSync(root, { recursive: true, force: true });
done('D51 dropExpired counted every prune removal');
