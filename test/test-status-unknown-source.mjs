// test/test-status-unknown-source.mjs — D7: `paper_status` must report an
// unknown `sources` id instead of silently widening to every source.
//
// Baseline 864a6e8, lib/index.js:605:
//   const ids = sourceChoice.explicit && sourceChoice.valid.length ? sourceChoice.valid : SOURCE_IDS;
// With `sources: 'bogus'`, `explicit` is true but `valid` is empty, so it fell
// back to ALL sources and said nothing. Measured: 0 lines mentioning "bogus",
// and "note: 23 of 23 sources checked above". The caller asked for one source,
// got all 23, and was told 23 were checked.
//
// `paper_search` already reports unknown ids (lib/index.js:427) with the wording
//   WARNING: unknown source (ignored): <ids>
// and this fix follows it.
//
// Run: node test/test-status-unknown-source.mjs

import { check, loadTools } from './harness.mjs';

const tools = loadTools();
const status = tools.get('paper_status');
check('paper_status is registered', !!status);

// ── 1. an unknown id is named, and the list is NOT widened ──────────────────
const bogus = await status.execute({ sources: 'bogus' });
check('the reply names the unknown id "bogus"', /bogus/.test(bogus),
  bogus.split('\n').filter((l) => /bogus/i.test(l)).join(' | ') || 'no line mentions it');
check('the reply uses the paper_search wording',
  /unknown source \(ignored\): bogus/.test(bogus),
  bogus.split('\n').filter((l) => /unknown source/i.test(l)).join(' | ') || 'no such line');
// The count line must not claim 23 sources were checked when none were.
check('the reply does NOT claim all 23 sources were checked',
  !/23 of 23 sources checked/.test(bogus),
  bogus.split('\n').filter((l) => /sources checked above/.test(l)).join(' | '));

// ── 2. a valid id still narrows to exactly one ──────────────────────────────
const doaj = await status.execute({ sources: 'doaj' });
check('sources: "doaj" narrows to one source', /1 of 23 sources checked above/.test(doaj),
  doaj.split('\n').filter((l) => /sources checked above/.test(l)).join(' | '));
check('sources: "doaj" does not warn about an unknown source', !/unknown source/i.test(doaj));

// ── 3. a mixed list keeps the valid id and reports the invalid one ──────────
const mixed = await status.execute({ sources: 'doaj,bogus' });
check('a mixed list still checks the valid id', /1 of 23 sources checked above/.test(mixed),
  mixed.split('\n').filter((l) => /sources checked above/.test(l)).join(' | '));
check('a mixed list reports the unknown id', /unknown source \(ignored\): bogus/.test(mixed),
  mixed.split('\n').filter((l) => /unknown source/i.test(l)).join(' | ') || 'no such line');

// ── 4. a bare call is unchanged: the doctor still covers every source ───────
const bare = await status.execute({});
check('a bare call still checks all 23 sources', /23 of 23 sources checked above/.test(bare),
  bare.split('\n').filter((l) => /sources checked above/.test(l)).join(' | '));
check('a bare call does not warn about an unknown source', !/unknown source/i.test(bare));

console.log(process.exitCode ? '\nFAILED' : '\nOK');
