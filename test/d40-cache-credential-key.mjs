// test/d40-cache-credential-key.mjs — D40 (audit L15): the cache key ignores the
// credential, so a keyed answer was served to an unkeyed caller.
//
// THE DEFECT. `lib/cache.js` states its own principle 3 — "Keyed sources MUST be
// skipped" — and `isCacheable` implemented it as "skip sources whose `credit`
// contains REQUIRED". That is a different set: `REQUIRED` marks the sources that
// cannot work WITHOUT a key (CORE, Unpaywall), while the sources that USE one
// when present declare `credit` as 'raises rate limit' / 'optional' /
// 'recommended (polite pool)' and were cached. Measured 24 Nov 2026:
//
//   paper_search({query, sources:'semantic'})  WITH SEMANTIC_SCHOLAR_API_KEY
//     -> 2 results, stored under cacheKey('semantic', query, …)
//   paper_search({query, sources:'semantic'})  WITHOUT the key
//     -> the same 2 results, served from cache, reported as a fresh search
//
// The unkeyed call would have been rate-limited to 1 result, so the cache handed
// it an answer it could not have obtained. The key cannot fix this by being part
// of the key: principle 2 forbids secrets on disk, and the cache file is written
// by our own hand. So the source is skipped instead — the simpler of the two
// fixes the audit allows, and the one principle 3 already asks for.
//
// WHAT THIS TEST PINS, in order of importance:
//   1. the behaviour — a keyed source is not cacheable, an unkeyed one still is;
//   2. the LIST — every id in `KEYED_SOURCE_IDS` must still exist in `SOURCES`,
//      or the guard silently protects nothing after a rename;
//   3. the COST — `openalex` is a default source, so this fix removes the cache
//      hit from the most common search. That is stated in the reply, not hidden.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { cacheKey, createCache, isCacheable } from '../lib/cache.js';
// `KEYED_SOURCE_IDS` is imported through the namespace, not by name: on the
// unmodified code the export does not exist, and a named import would turn that
// into a module SyntaxError that aborts the file before a single assertion runs.
// A test that fails by not loading proves nothing about the behaviour; this one
// must fail on the assertions below.
import * as cacheModule from '../lib/cache.js';
import { SOURCES, findSource } from '../lib/sources.js';
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();
const KEYED_SOURCE_IDS = cacheModule.KEYED_SOURCE_IDS ?? new Set();

// ── 1. The rule, per source ─────────────────────────────────────────────────

// A source that merely USES a key when one is present stays CACHEABLE: the key
// carries a `keyed` bit instead, so a keyed answer and an unkeyed answer occupy
// different entries. Disabling the cache for these was the first fix and it cost
// 9 of the 21 default sources their cache hit, `openalex` among them.
for (const id of ['semantic', 'doaj', 'openalex', 'ssrn', 'biorxiv', 'medrxiv', 'chemrxiv']) {
  const source = findSource(id);
  check(`${id} IS cacheable (the key carries the credential bit instead)`,
    source !== null && isCacheable(source) === true,
    source === null ? 'source not found' : `isCacheable=${isCacheable(source)} credit=${JSON.stringify(source.credit)}`);
}
// `core` cannot work WITHOUT its key, so it is skipped on the REQUIRED rule.
check('core is NOT cacheable (it cannot work without a key)', isCacheable(findSource('core')) === false);

// The other half of the rule: a source that reads NO key must still be cached,
// or the "fix" is just "disable the cache".
for (const id of ['crossref', 'pubmed', 'arxiv', 'europepmc', 'zenodo', 'hal', 'iacr', 'openreview', 'ieee', 'pmc']) {
  const source = findSource(id);
  check(`${id} IS still cacheable (it reads no key)`,
    source !== null && isCacheable(source) === true,
    source === null ? 'source not found' : `isCacheable=${isCacheable(source)}`);
}

// `unpaywall` is skipped for two independent reasons (REQUIRED email + DOI
// input); it must not become cacheable if either rule is ever relaxed.
check('unpaywall is still not cacheable', isCacheable(findSource('unpaywall')) === false);

// ── 2. The list cannot rot ──────────────────────────────────────────────────
//
// A guard keyed on an id that no longer exists protects nothing, and nothing
// would say so. This is the assertion that turns a rename into a test failure.
check('the keyed-source list is exported (the guard is inspectable)',
  cacheModule.KEYED_SOURCE_IDS instanceof Set,
  String(cacheModule.KEYED_SOURCE_IDS));
const known = new Set(SOURCES.map((s) => s.id));
const stale = [...KEYED_SOURCE_IDS].filter((id) => !known.has(id));
check('every id in KEYED_SOURCE_IDS still exists in SOURCES',
  stale.length === 0,
  stale.length ? `stale: ${stale.join(', ')}` : `${KEYED_SOURCE_IDS.size} ids, all present`);

// And the converse: a source that DECLARES a credential requirement must be
// skipped even if its `credit` wording changes. `needs` is the structural form
// of the same fact, checked independently of the prose.
check('a source declaring `needs` is not cacheable regardless of its credit wording',
  isCacheable({ id: 'invented', credit: 'optional', needs: 'SOME_KEY' }) === false);
check('a source with no key, no `needs` and no DOI input IS cacheable',
  isCacheable({ id: 'invented', credit: 'optional' }) === true);

// ── 3. The defect end to end: keyed answer must not reach an unkeyed caller ──
//
// This is the measured scenario. The cache is REAL (a temp file), the network is
// mocked, and the two calls differ ONLY in whether the key is configured.
const root = join(tmpdir(), `dsh-d40-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const file = join(root, 'cache-search.json');

const KEYED_ANSWER = [
  { title: 'Keyed result one', year: 2020, source: 'semantic' },
  { title: 'Keyed result two', year: 2021, source: 'semantic' },
];
const UNKEYED_ANSWER = [{ title: 'Unkeyed result one', year: 2020, source: 'semantic' }];

/** Serve Semantic Scholar: 2 results with a key, 1 without — as the rate limit does. */
function serveSemantic() {
  return installFetch((url, init) => {
    if (url.includes('api.semanticscholar.org')) {
      const keyed = Boolean(init?.headers?.['x-api-key']);
      const data = keyed ? KEYED_ANSWER : UNKEYED_ANSWER;
      return { body: { data: data.map((d) => ({ title: d.title, year: d.year, authors: [], externalIds: {} })) } };
    }
    return { body: {} };
  });
}

// Call 1: WITH the key. Its answer is stored — if the source were cacheable.
const mock1 = serveSemantic();
const withKey = loadTools({ cache: true, libraryRoot: root, cacheFile: file, SEMANTIC_SCHOLAR_API_KEY: 'S2-KEY-1' });
const reply1 = await withKey.get('paper_search').execute({ query: 'graph neural networks', sources: 'semantic' });
mock1.restore();
check('the keyed call really got the keyed answer (2 results)',
  /Keyed result one/.test(reply1) && /Keyed result two/.test(reply1),
  reply1.split('\n').filter((l) => /result/i.test(l)).slice(0, 3).join(' | '));

// Call 2: WITHOUT the key, same query. It must NOT be served the keyed answer.
const mock2 = serveSemantic();
const noKey = loadTools({ cache: true, libraryRoot: root, cacheFile: file });
const reply2 = await noKey.get('paper_search').execute({ query: 'graph neural networks', sources: 'semantic' });
mock2.restore();

check('the unkeyed call is NOT served the keyed answer',
  !/Keyed result one/.test(reply2),
  reply2.split('\n').filter((l) => /Keyed result/.test(l)).join(' | ') || 'clean');
check('the unkeyed call really searched and got its own answer',
  /Unkeyed result one/.test(reply2),
  reply2.split('\n').filter((l) => /result/i.test(l)).slice(0, 3).join(' | '));
check('the unkeyed call does not claim a cache hit',
  !/served from CACHE/i.test(reply2),
  reply2.split('\n').filter((l) => /CACHE/i.test(l)).join(' | ') || 'clean');

// The keyed answer IS stored — under a key that carries `keyed: true` — and the
// unkeyed caller cannot reach it. That is the whole point of the bit: the cache
// keeps working for a keyed source without ever crossing the two answers.
const cache = createCache({ file });
check('the keyed answer was stored (the cache still works for a keyed source)',
  cache.status().count > 0,
  `count=${cache.status().count}`);
check('the keyed and unkeyed answers occupy DIFFERENT entries',
  cacheKey('semantic', 'graph neural networks', { rows: 5, keyed: true })
  !== cacheKey('semantic', 'graph neural networks', { rows: 5, keyed: false }));

// ── 4. The fix must not be "disable the cache" ─────────────────────────────
//
// The cheap path has to survive for a source that reads no key, or the "fix" is
// just a slower plugin. Crossref is the case: no key, still cacheable.
const root2 = join(tmpdir(), `dsh-d40-hit-${process.pid}`);
rmSync(root2, { recursive: true, force: true });
mkdirSync(root2, { recursive: true });
const file2 = join(root2, 'cache-search.json');

let crossrefCalls = 0;
function serveCrossref() {
  return installFetch((url) => {
    if (url.includes('api.crossref.org')) {
      crossrefCalls++;
      return { body: { message: { items: [{ title: ['A Crossref paper'], DOI: '10.1/x', author: [], issued: { 'date-parts': [[2020]] } }] } } };
    }
    return { body: {} };
  });
}

const mockA = serveCrossref();
const first = loadTools({ cache: true, libraryRoot: root2, cacheFile: file2 });
const replyA = await first.get('paper_search').execute({ query: 'a cacheable query', sources: 'crossref' });
mockA.restore();
check('the first crossref search really hit the network', crossrefCalls === 1, `${crossrefCalls} call(s)`);
check('the first crossref search is not a cache hit', !/served from CACHE/i.test(replyA),
  replyA.split('\n').filter((l) => /CACHE/i.test(l)).join(' | ') || 'clean');

const mockB = serveCrossref();
const second = loadTools({ cache: true, libraryRoot: root2, cacheFile: file2 });
const replyB = await second.get('paper_search').execute({ query: 'a cacheable query', sources: 'crossref' });
mockB.restore();
check('the repeat crossref search made NO network call', crossrefCalls === 1, `${crossrefCalls} call(s)`);
check('the repeat crossref search IS served from the cache', /served from CACHE/i.test(replyB),
  replyB.split('\n').filter((l) => /CACHE/i.test(l)).join(' | ') || 'no cache line');
check('the cached answer is the same answer', /A Crossref paper/.test(replyB),
  replyB.split('\n').filter((l) => /Crossref paper/.test(l)).join(' | '));

// And `force_refresh` still bypasses it — the escape hatch is unchanged.
const mockC = serveCrossref();
const third = loadTools({ cache: true, libraryRoot: root2, cacheFile: file2 });
const replyC = await third.get('paper_search').execute({ query: 'a cacheable query', sources: 'crossref', force_refresh: true });
mockC.restore();
check('force_refresh still bypasses the cache', crossrefCalls === 2, `${crossrefCalls} call(s)`);
check('force_refresh is reported', /force_refresh active/i.test(replyC),
  replyC.split('\n').filter((l) => /force_refresh/i.test(l)).join(' | ') || 'no line');

// ── 5. The default sources keep their cache ─────────────────────────────────
//
// The first fix disabled the cache for every keyed source, which cost 9 of the
// 21 default sources their cache hit — `openalex` among them, the plugin's
// biggest measured win. The bit must not bring that cost back.
{
  const { DEFAULT_IDS } = await import('../lib/sources.js');
  // `core` (REQUIRED key) and `unpaywall` (DOI input) were ALREADY uncacheable
  // before this fix, for reasons that have nothing to do with the credential
  // bit. Everything else must still be cached.
  const ALREADY_SKIPPED = new Set(['core', 'unpaywall']);
  const lost = DEFAULT_IDS.filter((id) => !ALREADY_SKIPPED.has(id) && !isCacheable(findSource(id)));
  check('no default source lost its cache to this fix',
    lost.length === 0,
    lost.length ? `lost: ${lost.join(', ')}` : `${DEFAULT_IDS.length - ALREADY_SKIPPED.size} default sources still cacheable`);
}

// ── 5. The key itself never reaches the cache file ──────────────────────────
//
// Principle 2. The fix must not have been "put the key in the key".
const key = 'S2-SECRET-DO-NOT-STORE';
const mock4 = serveSemantic();
const secret = loadTools({ cache: true, libraryRoot: root, cacheFile: file, SEMANTIC_SCHOLAR_API_KEY: key });
await secret.get('paper_search').execute({ query: 'secret probe', sources: 'semantic' });
mock4.restore();
const raw = (() => { try { return readFileSync(file, 'utf8'); } catch { return ''; } })();
check('the API key does not appear in the cache file',
  !raw.includes(key),
  raw.includes(key) ? 'KEY FOUND IN CACHE FILE' : 'clean');

// A key built for a keyed source is still a normal hash — the key is not in it.
check('cacheKey does not accept or embed a credential',
  cacheKey('semantic', 'q', { rows: 5 }) === cacheKey('semantic', 'q', { rows: 5 })
  && !cacheKey('semantic', 'q', { rows: 5 }).includes(key),
  cacheKey('semantic', 'q', { rows: 5 }));

rmSync(root, { recursive: true, force: true });
done('D40 cache key ignored the credential');
