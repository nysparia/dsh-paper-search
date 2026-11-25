// lib/cache.js — BOUNDED local search cache (spirit of issue #94/#140).
//
// Principles that determine the whole design of this file:
//
//   1. **Failures are NEVER stored.** If a source fails, storing the failure
//      means that momentary failure "infects" the whole TTL — and the user
//      will see a "dead source" even though it has already recovered. Only
//      answers that actually succeeded are cached.
//   2. **Keys NEVER contain credentials.** A key is built from
//      source+query+options only. If a key carried an API key, the cache file
//      on disk would become a place where secrets leak — and that file is
//      written by our own hand.
//   3. **Keyed sources MUST be skipped** (same as the upstream rule).
//   4. **Always inspectable.** Every cache use is REPORTED to the user
//      together with its age, and there is `force_refresh`. An invisible
//      cache is a misleading cache.
//   5. **Bounded**: entry count AND byte size. Over the limit -> the
//      least-recently-used is dropped first.
//
// One file: `<root>/cache-search.json`, written ATOMICALLY (.part -> rename)
// so that dying mid-write does not leave half a JSON that makes the whole
// cache unreadable.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Cache key: source + query + options that AFFECT the result. Deliberately
 * accepts only primitive values, and `email`/`apiKey` are NOT included (see
 * principle 2).
 *
 * The key carries no credential, but it DOES carry one bit about one: `keyed`,
 * true when a credential was actually sent for this source in this run. A
 * source's answer can depend on WHETHER a key was sent — measured 24 Nov 2026, a
 * keyed Semantic Scholar call returned 2 results and an unkeyed one was
 * rate-limited to 1 — so the two answers must not share an entry. The bit never
 * identifies the secret, so principle 2 holds, and a rotated key reuses the
 * entry, which is right: the answer depends on having a key, not on its value.
 */
export function cacheKey(id, query, { rows, minCitations = null, kind = null, keyed = false } = {}) {
  const payload = JSON.stringify({
    id,
    q: String(query ?? '').trim().toLowerCase(),
    rows: Number(rows) || null,
    minCitations: minCitations ?? null,
    kind: Array.isArray(kind) ? [...kind].sort() : null,
    // ONE BIT, not the credential. A source's answer can depend on WHETHER a key
    // was sent (a keyed Semantic Scholar call returns more than a rate-limited
    // unkeyed one), so the two answers must not share an entry. The bit says
    // "a key was used", never which key, so principle 2 still holds: nothing on
    // disk identifies the secret, and a rotated key reuses the entry — which is
    // right, because the answer depends on having a key, not on its value.
    keyed: keyed === true,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * The sources whose REQUEST can carry an API key — the ones for which the
 * `keyed` bit in `cacheKey` is meaningful.
 *
 * WHY THIS LIST EXISTS. `isCacheable` used to skip only sources whose `credit`
 * contains `REQUIRED`, and that was read as "the keyed ones". It is not:
 * `REQUIRED` marks the sources that cannot work WITHOUT a key (CORE, Unpaywall),
 * while the sources that merely USE one when it is present — `semantic`, `doaj`,
 * `openalex` and the four OpenAlex-repository sources — declare `credit` as
 * 'raises rate limit', 'optional' or 'recommended (polite pool)'. Measured
 * 24 Nov 2026: a Semantic Scholar search made WITH a key (2 results) was served
 * from the cache to a later call WITHOUT a key, which would otherwise have been
 * rate-limited to 1 result.
 *
 * The first fix was to stop caching every one of them. That is correct but
 * expensive: 9 of the 21 default sources read a key, `openalex` among them, so
 * the most common search lost its cache hit — the plugin's single biggest
 * measured win (6.6 s -> 1 ms). So the key carries the `keyed` BIT instead, and
 * these sources stay cacheable. This list is what `runSearch` consults to decide
 * that bit, and `test/d40-cache-credential-key.mjs` pins it against `SOURCES` so
 * an id that stops existing fails the suite instead of silently protecting
 * nothing.
 *
 * A NEW KEYED SOURCE MUST BE ADDED HERE.
 */
export const KEYED_SOURCE_IDS = new Set([
  'openalex', 'doaj', 'semantic', 'core', 'ssrn', 'biorxiv', 'medrxiv', 'chemrxiv',
]);

/** Is this source ALLOWED to be cached? Keyed sources must be skipped. */
export function isCacheable(source) {
  if (!source) return false;
  const credit = String(source.credit ?? '');
  // `REQUIRED` marks a source that cannot work without a credential (CORE,
  // Unpaywall). Caching those would serve one user's keyed answer to the next
  // caller, so they are always skipped.
  if (/REQUIRED/i.test(credit)) return false;
  // A declared credential requirement is the same fact stated structurally, and
  // it is checked independently of the `credit` wording so that rewording a
  // `credit` string cannot quietly make a keyed source cacheable again.
  if (source.needs) return false;
  // Sources with a DOI input are not cached: their callers are rare, and the
  // result depends on an already-specific DOI.
  if (source.input === 'doi') return false;
  return true;
}

/**
 * Can this cache file actually be written?
 *
 * WHY THIS EXISTS. `write()` swallows every error, and that is correct — a
 * cache is an accelerator, not the source of truth, so a failed write must
 * never fail a search. But swallowing the error made a READ-ONLY library root
 * indistinguishable from a working cache: `set()` returned false, `get()`
 * returned null, and the startup note still said "search cache active".
 * Measured 24 Nov 2026 on this machine: `~/.dsh` is a read-only mount, so the
 * default cache file could never be written, every search paid full price, and
 * the report claimed the cache was on.
 *
 * The probe WRITES a real file and removes it. A permission bit on the
 * directory is not the same thing as a successful write: read-only mounts,
 * immutable attributes, ACLs and a full disk all pass an access check and then
 * fail the write. It runs ONCE, at construction, so startup cost is one
 * create+unlink.
 *
 * The probe targets the directory, not the file, because `write()` is atomic
 * (`<file>.part` -> rename) and a rename over an existing read-only file
 * succeeds as long as the directory is writable.
 */
function probeWritable(file) {
  const probe = `${file}.probe-${process.pid}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(probe, '');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function createCache({ file, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, now = () => Date.now() } = {}) {
  // Probed once. `get()`/`set()`/`clear()` keep their exact semantics: this is
  // a REPORT, not a gate — a read-only cache file that already exists is still
  // read, it just cannot store anything new.
  const writable = probeWritable(file);
  /**
   * Read the file, and RECORD whether it could be understood.
   *
   * A corrupt file is NOT a reason to die: the cache is an accelerator, not the
   * source of truth, so it is dropped and the caller starts clean. But dropping
   * it SILENTLY was a defect of its own. Measured 24 Nov 2026 with
   * `writeFileSync(file, '{ this is not json')`:
   *
   *   cache.get('anything')  -> null
   *   cache.status()         -> { count: 0, validCount: 0, exists: true }
   *
   * `exists: true` with `count: 0` was the only hint, and `paper_status` printed
   * the count without ever saying the file was unreadable — so a user whose cache
   * got truncated saw "0 entries" forever and never learned why.
   *
   * `corrupt` is computed on EVERY read rather than latched in a flag, so it
   * always describes the file as it is NOW: after one successful `set()` the file
   * is valid JSON again and `status()` stops reporting it. A latched flag would
   * keep accusing a file that has already healed.
   *
   * `get()`/`set()` semantics are UNCHANGED — they only ever look at `entries`.
   */
  const read = () => {
    if (!existsSync(file)) return { version: 1, entries: {}, corrupt: false };
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      // Parses, but is not a cache: same practical outcome as a parse failure —
      // nothing in it can be used, and the user deserves to know that.
      if (!j || typeof j !== 'object' || typeof j.entries !== 'object' || j.entries === null) {
        return { version: 1, entries: {}, corrupt: true };
      }
      return j;
    } catch {
      return { version: 1, entries: {}, corrupt: true };
    }
  };

  const write = (content) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.part`;
      // `corrupt` describes the file that was READ; it is not part of the cache
      // and must never be persisted, or the next read would report a healthy file
      // as corrupt.
      const { corrupt: _corrupt, ...payload } = content;
      writeFileSync(temporary, JSON.stringify(payload));
      renameSync(temporary, file);
      return true;
    } catch {
      return false;
    }
  };

  /** Drop expired entries + maintain the entry and byte limits. */
  const prune = (content) => {
    const limit = now() - ttlMs;
    for (const [k, v] of Object.entries(content.entries)) {
      if (!v || typeof v.usedAt !== 'number' || v.usedAt < limit) delete content.entries[k];
    }
    let keys = Object.keys(content.entries);
    while (keys.length > maxEntries) {
      const oldest = keys.reduce((a, b) => (content.entries[a].usedAt <= content.entries[b].usedAt ? a : b));
      delete content.entries[oldest];
      keys = Object.keys(content.entries);
    }
    let size = Buffer.byteLength(JSON.stringify(content));
    while (size > maxBytes && keys.length > 0) {
      const oldest = keys.reduce((a, b) => (content.entries[a].usedAt <= content.entries[b].usedAt ? a : b));
      delete content.entries[oldest];
      keys = Object.keys(content.entries);
      size = Buffer.byteLength(JSON.stringify(content));
    }
    return content;
  };

  return {
    file,
    ttlMs,
    /**
     * Whether the cache file can be written. False means every `set()` is a
     * no-op and every `get()` is a MISS — the caller MUST say so instead of
     * reporting the cache as active.
     */
    writable,
    /**
     * Get from the cache. Returns null when absent / expired.
     *
     * A HIT REFRESHES `usedAt`, and that is a real fix, not a nicety. Measured
     * 23 Nov 2026: `usedAt` was written only by `set()`, so
     *
     *   · the TTL counted from INSERT, not from last use — an entry read every
     *     minute still expired 30 minutes after it was stored, and
     *   · `prune()` evicts by `usedAt`, so it was evicting by INSERTION order
     *     while the comment above it claimed "least-recently-used". A hot entry
     *     was thrown away before a cold one.
     *
     * Both are the same root cause: nothing updated the timestamp on a read.
     * The write is best-effort — a cache that cannot be written is still a
     * usable cache, so a failed write must not turn a HIT into a MISS.
     */
    get(key) {
      const content = read();
      const v = content.entries?.[key];
      if (!v || typeof v.usedAt !== 'number') return null;
      const age = now() - v.usedAt;
      if (age > ttlMs) return null;
      // Refresh the timestamp so TTL and LRU both measure "last used".
      v.usedAt = now();
      write(content);
      return { value: v.value, ageMs: age, storedAt: v.usedAt };
    },
    /** Store ONLY what succeeded. `value` is required and must not be null. */
    set(key, value, { count = null } = {}) {
      if (value === null || value === undefined) return false;
      const content = read();
      content.entries[key] = { usedAt: now(), count, value };
      return write(prune(content));
    },
    /** Delete the ENTIRE cache. */
    clear() {
      try {
        if (existsSync(file)) unlinkSync(file);
        return true;
      } catch {
        return false;
      }
    },
    /** Drop ONLY the expired ones; return how many were dropped. */
    dropExpired() {
      const content = read();
      const before = Object.keys(content.entries ?? {}).length;
      write(prune(content));
      const after = Object.keys(prune(read()).entries ?? {}).length;
      return Math.max(0, before - after);
    },
    status() {
      const content = read();
      const entries = Object.entries(content.entries ?? {});
      const limit = now() - ttlMs;
      const valid = entries.filter(([, v]) => v?.usedAt >= limit);
      return {
        file,
        exists: existsSync(file),
        writable,
        // The file exists but could not be understood. Reported, never acted on:
        // `get()` already treats it as empty and the next `set()` overwrites it.
        corrupt: content.corrupt === true,
        bytes: existsSync(file) ? statSync(file).size : 0,
        ttlMs,
        maxEntries,
        maxBytes,
        count: entries.length,
        validCount: valid.length,
        oldestMs: valid.length ? now() - Math.min(...valid.map(([, v]) => v.usedAt)) : null,
        newestMs: valid.length ? now() - Math.max(...valid.map(([, v]) => v.usedAt)) : null,
      };
    },
  };
}

/** Default path of the cache file inside the library root. */
export function defaultCacheFile(root) {
  return join(root, 'cache-search.json');
}
