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
// One file: `<root>/cache-search.json`, written ATOMICALLY
// (`<file>.<pid>.<n>.part` -> rename) so that dying mid-write does not leave
// half a JSON that makes the whole cache unreadable.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The smallest `maxBytes` that can hold a cache at all.
 *
 * A cap below one entry's JSON makes `set()` drop everything it just wrote and
 * still report success — the same lie as `maxEntries: 0` (see `createCache`).
 * One minimal entry (`{"version":1,"entries":{"<32 hex>":{"storedAt":…,
 * "usedAt":…,"count":1,"value":[]}}}`) is about 110 bytes, so 1 kB holds
 * several and is a floor, not a target.
 */
const MIN_MAX_BYTES = 1024;

/**
 * How stale `usedAt` is allowed to get before a hit rewrites the file.
 *
 * `usedAt` only orders LRU eviction, so a minute of error costs nothing; a
 * write per read costs a full serialize + rename of up to `maxBytes`. Measured
 * 24 Nov 2026 on a 103 kB cache: one `get()` changed the file's mtime AND its
 * content. A read-only cache now keeps a stale `usedAt` instead — accepted,
 * because the alternative is a write per read.
 */
const USED_AT_REFRESH_MS = 60 * 1000;

/**
 * Unique temporary names for `write()` and the probe.
 *
 * A fixed `<file>.part` let two writers interleave into ONE file and then
 * rename the half-written result into place. Measured 24 Nov 2026 with three
 * writers and one reader on the same file: 53,701 reads, 41,747 unparseable,
 * 41,450 of them zero bytes — and the reader reported CORRUPT for a cache that
 * was merely concurrent. `${pid}.${counter}` gives every write its own file, so
 * a rename can only ever publish a COMPLETE payload.
 */
let temporaryCounter = 0;

/** A JSON object — not an array, not null. `JSON.parse` cannot yield a class instance. */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A finite integer, clamped to `min`; anything unusable falls back to `fallback`. */
const clampInt = (value, fallback, min) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
};

/**
 * Can this stored entry be SERVED? ONE predicate for `get()`, `status()` and
 * `prune()`, so the three cannot disagree about the same entry.
 *
 * They used to disagree. Measured 24 Nov 2026 with `usedAt` stored as the
 * string "999000": `status()` reported `validCount: 1` (its `>=` coerced the
 * string) while `get()` was a MISS (its `typeof !== 'number'` rejected it), so
 * `paper_status` advertised an entry that could never be served. An entry with
 * no `usedAt` at all was counted in `count` but not in `validCount`, with
 * nothing saying why.
 *
 * `value: null` is NOT servable either. `set()` refuses to store null, but a
 * hand-edited or externally corrupted file could carry it, and `get()` returned
 * it as a HIT: measured 24 Nov 2026, `perSource[0].papers = null` and `dedup`
 * threw `TypeError: Cannot read properties of null (reading 'doi')` out of
 * `runSearch`. A MISS is the honest answer for data that is not there.
 *
 * `Number.isFinite`, not `typeof === 'number'`: a NaN timestamp makes
 * `now - storedAt > ttlMs` false forever, so the entry would never expire.
 *
 * An entry written by 0.7.0 carries `usedAt` but no `storedAt`, so it is
 * unusable and is dropped by the next `set()`. Falling back to `usedAt` would
 * resurrect the very lie this fixes — an age measured from the last read — and
 * a cache is an accelerator, so a cold start after the upgrade costs one search.
 */
const isUsable = (v) => isPlainObject(v)
  && Number.isFinite(v.storedAt)
  && Number.isFinite(v.usedAt)
  && v.value !== null
  && v.value !== undefined;

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
 * these sources stay cacheable. `lib/index.js` IMPORTS this set and consults it
 * for every source it caches, so this is the single source of truth for the
 * bit. It used to keep a second, private copy (`OPENALEX_KEYED_IDS`, five ids
 * against these eight) and the two could drift with nothing to notice.
 * `test/d40-cache-credential-key.mjs` pins the ids against `SOURCES` so an id
 * that stops existing fails the suite instead of silently protecting nothing,
 * and `test/d55-cache-keyed-source-list.mjs` pins that the caller really reads
 * THIS set rather than a copy.
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
 * THE PAYLOAD IS REALISTIC, NOT EMPTY. A 0-byte write proves almost nothing:
 * measured 24 Nov 2026 under `ulimit -f 1` (a 512-byte file-size limit, the
 * same shape as a nearly-full disk), the empty probe succeeded, `writable` was
 * reported true, and then EVERY `set()` failed — `set()` -> false, `get()` ->
 * null, while the startup note still said "search cache active". That is the
 * exact defect this function exists to prevent, so the probe now writes
 * `PROBE_BYTES` of payload: more than an entry header, so a file-size limit or
 * a nearly-full disk fails the probe instead of the first real search.
 *
 * The probe targets the directory, not the file, because `write()` is atomic
 * (`<file>.<pid>.<n>.part` -> rename) and a rename over an existing read-only
 * file succeeds as long as the directory is writable. The one case that breaks
 * that reasoning is the cache PATH ITSELF being a directory: the probe (which
 * writes `<file>.probe-…`) succeeds while every rename onto `<file>` fails, so
 * that shape is rejected explicitly.
 *
 * The probe file is removed on EVERY path, including failure, and probes left
 * by a process that died between write and unlink are swept: one file per dead
 * pid would otherwise accumulate forever.
 */
const PROBE_BYTES = 4096;

function probeWritable(file) {
  const dir = dirname(file);
  const probe = `${file}.probe-${process.pid}-${(temporaryCounter += 1)}`;
  try {
    mkdirSync(dir, { recursive: true });
    // Sweeping is safe: a live probe is written and unlinked inside one
    // synchronous call, and unlinking another process's probe only makes its
    // own unlink throw ENOENT, which it already ignores.
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(`${basename(file)}.probe-`) && name !== basename(probe)) {
          try { unlinkSync(join(dir, name)); } catch { /* another process owns it */ }
        }
      }
    } catch { /* the directory could not be listed; the write below decides */ }
    if (existsSync(file) && statSync(file).isDirectory()) return false;
    writeFileSync(probe, 'x'.repeat(PROBE_BYTES));
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(probe); } catch { /* never created, or already gone */ }
  }
}

export function createCache({ file, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, now = () => Date.now() } = {}) {
  // A cache with no file is not a cache: `set()` is a no-op, `get()` is always
  // a MISS, and `status().file` prints `undefined` while Node emits DEP0187
  // ("Passing invalid argument types to fs.existsSync"). Measured 24 Nov 2026:
  // `createCache()` -> `file: undefined, writable: false`, no throw. A caller
  // that prints the path then reports a cache at a path that does not exist.
  if (typeof file !== 'string' || file === '') {
    throw new TypeError('createCache requires a file path (config libraryRoot/cacheFile); without one every set() is a no-op and status().file prints undefined');
  }
  // CLAMPED. `maxEntries: -1` used to throw `TypeError: Reduce of empty array
  // with no initial value` out of `set()`, which `lib/index.js` calls inside
  // `Promise.all` — so one bad config killed the whole search. `maxEntries: 0`
  // was the opposite lie: `set()` returned true and stored nothing, so the
  // caller believed it had a warm cache that was permanently cold. Measured
  // 24 Nov 2026. A cap below one entry's JSON does the same thing through the
  // byte limit, hence the byte floor.
  const entriesCap = clampInt(maxEntries, DEFAULT_MAX_ENTRIES, 1);
  const bytesCap = clampInt(maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES);
  // A NaN TTL would make `age > ttlMs` false forever — a cache that never
  // expires. 0 is a coherent "expire immediately" and is kept.
  ttlMs = Number.isFinite(Number(ttlMs)) ? Math.max(0, Math.trunc(Number(ttlMs))) : DEFAULT_TTL_MS;
  // How stale `usedAt` may get before a hit rewrites the file: a minute, or a
  // tenth of the TTL when that is shorter, so a short-lived cache still orders
  // its evictions by use rather than by insertion.
  const refreshMs = Math.min(USED_AT_REFRESH_MS, Math.max(1, Math.floor(ttlMs / 10)));
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
      //
      // AN ARRAY IS NOT A CACHE, and `typeof [] === 'object'` let one through.
      // Measured 24 Nov 2026 with `{"version":1,"entries":[]}`: `corrupt` stayed
      // false, `set()` returned TRUE, `content.entries[key] = …` set a
      // non-index property that `JSON.stringify` drops, the file stayed
      // `{"entries":[]}`, and `get()` was a MISS — success reported for a no-op,
      // which is the worst shape a cache can fail in.
      if (!isPlainObject(j) || !isPlainObject(j.entries)) {
        return { version: 1, entries: {}, corrupt: true };
      }
      return j;
    } catch {
      return { version: 1, entries: {}, corrupt: true };
    }
  };

  const write = (content) => {
    // UNIQUE PER WRITE. A fixed `<file>.part` let two writers interleave into
    // one file and then rename the half-written result into place; the reader
    // then reported CORRUPT for a cache that was merely concurrent (measured
    // 24 Nov 2026: 41,747 of 53,701 reads unparseable, 41,450 of them zero
    // bytes). The rename is still LAST-WRITER-WINS — acceptable for a cache,
    // because the loser's entries are only lost, never half-written. What is
    // not acceptable is publishing a truncated file, and a per-write name makes
    // that impossible.
    const temporary = `${file}.${process.pid}.${(temporaryCounter += 1)}.part`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      // `corrupt` describes the file that was READ; it is not part of the cache
      // and must never be persisted, or the next read would report a healthy file
      // as corrupt.
      const { corrupt: _corrupt, ...payload } = content;
      writeFileSync(temporary, JSON.stringify(payload));
      renameSync(temporary, file);
      return true;
    } catch {
      return false;
    } finally {
      // A failed rename used to leave the temporary behind — a file the user
      // never asked for, visible in their library root. Measured 24 Nov 2026:
      // `set()` -> false with `["cache-search.json","cache-search.json.part"]`
      // in the directory.
      try { unlinkSync(temporary); } catch { /* renamed into place, or never created */ }
    }
  };

  /**
   * Drop what can never be served + maintain the entry and byte limits.
   *
   * EXPIRY MEASURES `storedAt` (the age of the DATA); EVICTION MEASURES
   * `usedAt` (least-recently-used). They are two different questions and used
   * to share one field, which is why the TTL slid (see `get()`).
   *
   * Returns the counts so a caller can report what actually happened instead of
   * inferring it from a size difference: `dropExpired()` used to return every
   * entry `prune()` removed for ANY reason, so a cache with 6 fresh entries and
   * `maxEntries: 3` reported "3 expired" while nothing had expired.
   */
  const prune = (content) => {
    const limit = now() - ttlMs;
    let expired = 0;
    let evicted = 0;
    for (const [k, v] of Object.entries(content.entries)) {
      if (isUsable(v) && v.storedAt >= limit) continue;
      // An entry that is past the TTL is EXPIRED; one that cannot be served at
      // all (no timestamps, null value) is garbage, not an expiry, and is not
      // counted as one.
      if (isUsable(v)) expired += 1;
      delete content.entries[k];
    }
    let keys = Object.keys(content.entries);
    const lru = () => keys.reduce((a, b) => (content.entries[a].usedAt <= content.entries[b].usedAt ? a : b), keys[0]);
    while (keys.length > entriesCap) {
      delete content.entries[lru()];
      evicted += 1;
      keys = Object.keys(content.entries);
    }
    let size = Buffer.byteLength(JSON.stringify(content));
    while (size > bytesCap && keys.length > 0) {
      delete content.entries[lru()];
      evicted += 1;
      keys = Object.keys(content.entries);
      size = Buffer.byteLength(JSON.stringify(content));
    }
    return { expired, evicted };
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
     * Get from the cache. Returns null when absent / expired / unusable.
     *
     * TWO TIMESTAMPS, and they answer different questions:
     *
     *   · `storedAt` is written by `set()` ONLY, and is what the TTL measures.
     *   · `usedAt` is refreshed by a hit, and is what LRU eviction measures.
     *
     * They used to be ONE field. `get()` refreshed it on every hit and then
     * returned the refreshed value as `storedAt`, so the TTL slid: measured
     * 24 Nov 2026 with TTL 30 minutes, one `set()` at t=0 and a `get()` every
     * 20 minutes, the entry was still a HIT at t=300 minutes and every hit
     * reported `ageMs` = 20 minutes. The reply said "oldest 20 minutes ago"
     * about data fetched five hours earlier, and a query searched every 20
     * minutes was answered from the FIRST search forever.
     *
     * The argument for refreshing was about LRU, and LRU still needs `usedAt`:
     * without it `prune()` evicted by insertion order while claiming
     * "least-recently-used". So the refresh stays — it just no longer decides
     * expiry, and `ageMs` is now `now - storedAt`, the age of the DATA.
     *
     * The refresh is BATCHED (at most once per `refreshMs` — a minute, or a
     * tenth of the TTL when that is shorter): a hit used to rewrite the whole
     * file, up to `maxBytes` (2 MB by default) per read. A read-only cache
     * therefore keeps a stale `usedAt` — accepted, because the alternative is a
     * write per read.
     *
     * The write is best-effort: a cache that cannot be written is still a
     * usable cache, so a failed write must not turn a HIT into a MISS.
     */
    get(key) {
      const content = read();
      const v = content.entries?.[key];
      if (!isUsable(v)) return null;
      const t = now();
      const age = t - v.storedAt;
      if (age > ttlMs) return null;
      if (t - v.usedAt >= refreshMs) {
        v.usedAt = t;
        write(content);
      }
      return { value: v.value, ageMs: age, storedAt: v.storedAt };
    },
    /** Store ONLY what succeeded. `value` is required and must not be null. */
    set(key, value, { count = null } = {}) {
      if (value === null || value === undefined) return false;
      const content = read();
      const t = now();
      content.entries[key] = { storedAt: t, usedAt: t, count, value };
      prune(content);
      const ok = write(content);
      // A value larger than `maxBytes` is dropped by the byte cap. Reporting
      // success for it is the same lie as `maxEntries: 0` — the caller believes
      // it has a warm cache that is permanently cold.
      return ok && Object.hasOwn(content.entries, key);
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
    /**
     * Drop ONLY the entries that can never be served again; return how many of
     * them had EXPIRED, or `null` when the file could not be written (nothing
     * was dropped, so a number would describe an intention, not an outcome).
     *
     * It used to return every entry `prune()` removed for any reason: measured
     * 24 Nov 2026, a file holding 6 fresh entries with `maxEntries: 3` returned
     * 3 while nothing had expired, and a read-only directory returned 1 while
     * the file was unchanged. It also used to enforce the entry/byte caps,
     * which is `set()`'s job — a method named `dropExpired` must not silently
     * evict fresh entries.
     */
    dropExpired() {
      const content = read();
      const limit = now() - ttlMs;
      const entries = content.entries ?? {};
      let expired = 0;
      let removed = 0;
      for (const [k, v] of Object.entries(entries)) {
        if (isUsable(v) && v.storedAt >= limit) continue;
        if (isUsable(v)) expired += 1;
        delete entries[k];
        removed += 1;
      }
      if (removed === 0) return 0;
      return write(content) ? expired : null;
    },
    status() {
      const content = read();
      const all = Object.entries(content.entries ?? {});
      const usable = all.filter(([, v]) => isUsable(v));
      const t = now();
      const limit = t - ttlMs;
      const valid = usable.filter(([, v]) => v.storedAt >= limit);
      return {
        file,
        exists: existsSync(file),
        writable,
        // The file exists but could not be understood. Reported, never acted on:
        // `get()` already treats it as empty and the next `set()` overwrites it.
        corrupt: content.corrupt === true,
        bytes: existsSync(file) ? statSync(file).size : 0,
        ttlMs,
        maxEntries: entriesCap,
        maxBytes: bytesCap,
        count: all.length,
        validCount: valid.length,
        // Entries on disk that `get()` can never serve (no numeric timestamps,
        // or a null value). Counted separately so "0 valid of 2 stored" is not
        // a mystery — `paper_status` prints this when it is not zero.
        unusable: all.length - usable.length,
        // Ages are measured from `storedAt` — the age of the DATA, which is what
        // the reply claims ("oldest N minutes ago"). Measuring from `usedAt`
        // made a cache read once per TTL report 20 minutes forever.
        oldestMs: valid.length ? t - Math.min(...valid.map(([, v]) => v.storedAt)) : null,
        newestMs: valid.length ? t - Math.max(...valid.map(([, v]) => v.storedAt)) : null,
      };
    },
  };
}

/** Default path of the cache file inside the library root. */
export function defaultCacheFile(root) {
  return join(root, 'cache-search.json');
}
