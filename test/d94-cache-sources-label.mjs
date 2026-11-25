// d94 — `paper_status` said keyed sources are NOT cached, which is the opposite
// of what the code does.
//
// THE DEFECT. The line read:
//
//   sources that ARE CACHED: 21 · SKIPPED (keyed/DOI): core, unpaywall
//
// "SKIPPED (keyed/DOI)" tells a reader that a source which reads a credential is
// not cached. It is: the cache key carries ONE BIT saying a credential was sent,
// so a keyed answer and an unkeyed answer occupy different entries and a keyed
// answer is never served to an unkeyed caller. That is the whole point of the
// bit, and the line contradicted it.
//
// The two sources that ARE skipped are skipped for different reasons, and the
// label named neither: `core` cannot work without a key (so its answer is one
// caller's), and `unpaywall` takes a DOI rather than a query.
//
// Measured 24 Nov 2026 on 0.8.0.

import { loadTools, reporter } from './harness.mjs';
import { SOURCES } from '../lib/sources.js';
import { isCacheable, KEYED_SOURCE_IDS } from '../lib/cache.js';

const { check, done } = reporter();

const tools = loadTools({ cache: true, cacheFile: '/tmp/dsh-d94-cache.json' });
const reply = await tools.get('paper_status').execute({});
const line = reply.split('\n').find((l) => /sources that ARE CACHED/.test(l)) ?? '';

// ── 1. The label no longer claims keyed sources are skipped ────────────────
{
  check('the line exists', line.length > 0, line || 'SILENT');
  check('it does NOT say "SKIPPED (keyed/DOI)"', !/SKIPPED \(keyed\/DOI\)/.test(line), line);
  check('it says a keyed source IS cached', /a keyed source IS cached/.test(reply),
    reply.split('\n').find((l) => /keyed source/.test(l)) ?? 'SILENT');
}

// ── 2. The two skipped sources are named WITH their reason ─────────────────
{
  const skipped = SOURCES.filter((s) => !isCacheable(s)).map((s) => s.id);
  check('the skipped set is exactly core and unpaywall', skipped.sort().join(',') === 'core,unpaywall',
    skipped.join(','));
  check('core is named with its reason', /core \(needs a key\)/.test(line), line);
  check('unpaywall is named with its reason', /unpaywall \((needs a key|DOI input)\)/.test(line), line);
}

// ── 3. The count matches the code ──────────────────────────────────────────
{
  const cached = SOURCES.filter(isCacheable).length;
  check(`the count is ${cached} of ${SOURCES.length}`, new RegExp(`ARE CACHED: ${cached} of ${SOURCES.length}`).test(line), line);
}

// ── 4. Every keyed source really is cacheable ──────────────────────────────
//
// The claim the line now makes has to be true of every id in the set, not just
// of the ones that happen to be default sources.
{
  const notCached = [...KEYED_SOURCE_IDS].filter((id) => {
    const s = SOURCES.find((x) => x.id === id);
    return s && !isCacheable(s);
  });
  check('every keyed source that exists is cacheable, except one that cannot work without a key',
    notCached.every((id) => id === 'core'), notCached.join(',') || '(none)');
}

done('D94 the cache sources label');
