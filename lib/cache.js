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
 */
export function cacheKey(id, query, { rows, minCitations = null, kind = null } = {}) {
  const payload = JSON.stringify({
    id,
    q: String(query ?? '').trim().toLowerCase(),
    rows: Number(rows) || null,
    minCitations: minCitations ?? null,
    kind: Array.isArray(kind) ? [...kind].sort() : null,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** Is this source ALLOWED to be cached? Keyed sources must be skipped. */
export function isCacheable(source) {
  if (!source) return false;
  const credit = String(source.credit ?? '');
  // `REQUIRED` marks a source that cannot work without a credential (CORE,
  // Unpaywall). Caching those would serve one user's keyed answer to the next
  // caller, so they are always skipped.
  if (/REQUIRED/i.test(credit)) return false;
  // Sources with a DOI input are not cached: their callers are rare, and the
  // result depends on an already-specific DOI.
  if (source.input === 'doi') return false;
  return true;
}

export function createCache({ file, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, now = () => Date.now() } = {}) {
  const read = () => {
    if (!existsSync(file)) return { version: 1, entries: {} };
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || typeof j.entries !== 'object' || j.entries === null) return { version: 1, entries: {} };
      return j;
    } catch {
      // A corrupt file is NOT a reason to die: the cache is an accelerator, not
      // the source of truth. Drop it and start clean.
      return { version: 1, entries: {} };
    }
  };

  const write = (content) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.part`;
      writeFileSync(temporary, JSON.stringify(content));
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
