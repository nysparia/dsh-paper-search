// test/d76-cache-keyed-source-list.mjs — D76 (audit M5): `KEYED_SOURCE_IDS`
// was dead code, and the comment claimed a wiring that did not exist.
//
// THE DEFECT. `lib/cache.js` exported `KEYED_SOURCE_IDS` (8 ids) and its
// comment said "This list is what `runSearch` consults to decide that bit".
// `grep -rn KEYED_SOURCE_IDS lib/` returned ONLY the definition. `runSearch`
// built the bit from a SECOND hardcoded set, `OPENALEX_KEYED_IDS` (5 ids), plus
// three inline `id ===` checks. The behaviour was correct, but the two lists
// could drift and nothing would notice: a source added to the exported set
// would change nothing, while `test/d40-cache-credential-key.mjs` went on
// passing.
//
// WHAT THIS TEST PINS:
//   1. the bit is driven by the EXPORTED set — removing an id from it changes
//      the cache key the live path computes (this is the assertion that fails
//      on a private copy, because a copy does not see the removal);
//   2. the per-source credential fields still work: `semantic` reads
//      `semanticApiKey`, `openalex` reads `apiKey`;
//   3. with the set intact, a keyed answer is still NOT served to an unkeyed
//      caller (the fix did not disable the bit).
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as cacheModule from '../lib/cache.js';
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();

// Namespace import: on the unfixed code the export exists, but the test must
// fail on its ASSERTIONS, not on a module SyntaxError.
const KEYED_SOURCE_IDS = cacheModule.KEYED_SOURCE_IDS ?? new Set();

const root = join(tmpdir(), `dsh-d86-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const KEYED_ANSWER = [
  { title: 'Keyed result one', year: 2020 },
  { title: 'Keyed result two', year: 2021 },
];
const UNKEYED_ANSWER = [{ title: 'Unkeyed result one', year: 2020 }];

/** Semantic Scholar: 2 results with a key, 1 without — as the rate limit does. */
const serveSemantic = () => installFetch((url, init) => {
  if (url.includes('api.semanticscholar.org')) {
    const keyed = Boolean(init?.headers?.['x-api-key']);
    const data = keyed ? KEYED_ANSWER : UNKEYED_ANSWER;
    return { body: { data: data.map((d) => ({ title: d.title, year: d.year, authors: [], externalIds: {} })) } };
  }
  return { body: {} };
});

/** OpenAlex: 2 results with `api_key`, 1 without. */
const serveOpenAlex = () => installFetch((url) => {
  if (url.includes('api.openalex.org/works')) {
    const keyed = new URL(url).searchParams.has('api_key');
    const titles = keyed ? ['Keyed OA one', 'Keyed OA two'] : ['Unkeyed OA one'];
    return { body: { results: titles.map((title, i) => ({ id: `https://openalex.org/W${i}`, title, publication_year: 2020 })) } };
  }
  return { body: {} };
});

/** Run one search through the real tool and return the reply text. */
async function search({ file, source, config = {} }) {
  const mock = source === 'semantic' ? serveSemantic() : serveOpenAlex();
  const tools = loadTools({ cache: true, libraryRoot: root, cacheFile: file, ...config });
  const reply = await tools.get('paper_search').execute({ query: 'a keyed query', sources: source });
  mock.restore();
  return reply;
}

// ── 1. With the set intact, the bit still separates the two answers ─────────
{
  const file = join(root, 'intact.json');
  const keyed = await search({ file, source: 'semantic', config: { SEMANTIC_SCHOLAR_API_KEY: 'S2-KEY' } });
  check('the keyed call got the keyed answer', /Keyed result one/.test(keyed),
    keyed.split('\n').filter((l) => /result/i.test(l)).slice(0, 2).join(' | '));
  const unkeyed = await search({ file, source: 'semantic' });
  check('with the set intact, the unkeyed call is NOT served the keyed answer',
    !/Keyed result one/.test(unkeyed),
    unkeyed.split('\n').filter((l) => /Keyed result/.test(l)).join(' | ') || 'clean');
  check('...and it really searched', /Unkeyed result one/.test(unkeyed));
}

// ── 2. Remove the id from the EXPORTED set: the live path must notice ───────
//
// If `runSearch` kept a private copy of the list, deleting the id here would
// change nothing and the unkeyed call would still MISS. It is the same Set
// object the plugin imported, so the removal must reach the bit.
{
  const file = join(root, 'semantic-removed.json');
  const had = KEYED_SOURCE_IDS.delete('semantic');
  check('the exported set really contained `semantic`', had === true);
  const keyed = await search({ file, source: 'semantic', config: { SEMANTIC_SCHOLAR_API_KEY: 'S2-KEY' } });
  check('with `semantic` removed from the set, the keyed call still searches', /Keyed result one/.test(keyed));
  const unkeyed = await search({ file, source: 'semantic' });
  check('the bit is driven by the EXPORTED set: the unkeyed call now hits the keyed entry',
    /Keyed result one/.test(unkeyed),
    unkeyed.split('\n').filter((l) => /result/i.test(l)).slice(0, 2).join(' | '));
  check('...and it says so (served from CACHE)', /served from CACHE/i.test(unkeyed),
    unkeyed.split('\n').filter((l) => /CACHE/i.test(l)).join(' | ') || 'no cache line');
  KEYED_SOURCE_IDS.add('semantic');
}

// ── 3. The same wiring for a source that reads a DIFFERENT credential field ─
//
// `openalex` reads `options.apiKey`; `semantic` reads `options.semanticApiKey`.
// Both must be driven by the same set, or the "single source of truth" is only
// true for one of them.
{
  const file = join(root, 'openalex-removed.json');
  const had = KEYED_SOURCE_IDS.delete('openalex');
  check('the exported set really contained `openalex`', had === true);
  const keyed = await search({ file, source: 'openalex', config: { OPENALEX_API_KEY: 'OA-KEY' } });
  check('with `openalex` removed from the set, the keyed call still searches', /Keyed OA one/.test(keyed),
    keyed.split('\n').filter((l) => /result/i.test(l)).slice(0, 2).join(' | '));
  const unkeyed = await search({ file, source: 'openalex' });
  check('the bit is driven by the EXPORTED set for `openalex` too (apiKey field)',
    /Keyed OA one/.test(unkeyed),
    unkeyed.split('\n').filter((l) => /result/i.test(l)).slice(0, 2).join(' | '));
  KEYED_SOURCE_IDS.add('openalex');
}

check('the set is restored for the rest of the suite', KEYED_SOURCE_IDS.has('semantic') && KEYED_SOURCE_IDS.has('openalex'));

rmSync(root, { recursive: true, force: true });
done('D76 KEYED_SOURCE_IDS was dead code');
