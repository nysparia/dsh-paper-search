// test/d104-openreview-fields.mjs — `openreview` lost the authors of a bare
// array field, and dropped an untitled note without saying so.
//
// ── L5: AN ARRAY IS AN OBJECT ──────────────────────────────────────────────
//
// `value()` was `c[k] && typeof c[k] === 'object' ? c[k].value : c[k]`. An ARRAY
// is an object, so a bare array field was read as a `{value}` wrapper and came
// back `undefined` — the authors were lost. Measured 25 Nov 2026 with the v1
// shape (plain strings, singular `invitation`): `authors=[]`. The v2 API always
// wraps in `{value}`, so this was latent; but the connector's own comment says
// both author shapes are real, and one of them could not be read.
//
// ── L6: AN UNTITLED NOTE WAS DROPPED WITH NO COUNT ─────────────────────────
//
// `.filter((p) => p.title)` is defensible — an untitled record is unusable — but
// the reply said "1 result" for a reply that carried two notes, so "1 result"
// and "1 result, 1 unparseable" were the same answer. Measured 25 Nov 2026 with
// two notes, one untitled: `papers=1 error=null`. A reply that has notes but
// yields NO paper is now an error (the same rule `iacr` and `parseArxiv`
// follow); a PARTIAL drop still has no channel in this connector's return type
// (a bare array), so only the total loss is reported.
//
// WHAT MUST STILL WORK. The v2 `{value}` shape, a genuinely empty reply, and a
// partial drop among parseable notes.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned OpenReview reply. */
function serve(notes) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ notes }),
  });
}

// ── 1. L5: the v1 shape — a BARE array of author strings ──────────────────
{
  serve([{
    id: 'n1',
    forum: 'n1',
    invitation: 'ICLR.cc/2024/Conference/-/Submission',
    content: {
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      abstract: 'An abstract.',
    },
  }]);
  const h = await searchSource('openreview', 'attention', { rows: 5 });
  check('a bare-array reply reports no error', h.error === null, h.error ?? 'null');
  check('a bare-array reply returns the note', h.papers.length === 1, String(h.papers.length));
  check('the title is read', h.papers[0]?.title === 'Attention Is All You Need', h.papers[0]?.title ?? '(none)');
  check('the BARE ARRAY of authors is read', (h.papers[0]?.authors ?? []).length === 2,
    JSON.stringify(h.papers[0]?.authors));
  check('and the names are right', h.papers[0]?.authors?.[0] === 'Ashish Vaswani',
    JSON.stringify(h.papers[0]?.authors));
}

// ── 2. No regression: the v2 `{value}` shape still works ──────────────────
{
  serve([{
    id: 'n2',
    forum: 'n2',
    invitations: ['ICLR.cc/2024/Conference/-/Submission'],
    content: {
      title: { value: 'A v2 Note' },
      authors: { value: ['Alice Example', 'Bob Example'] },
      abstract: { value: 'An abstract.' },
    },
  }]);
  const h = await searchSource('openreview', 'note', { rows: 5 });
  check('a {value} reply reports no error', h.error === null, h.error ?? 'null');
  check('the {value} title is read', h.papers[0]?.title === 'A v2 Note', h.papers[0]?.title ?? '(none)');
  check('the {value} authors are read', (h.papers[0]?.authors ?? []).length === 2,
    JSON.stringify(h.papers[0]?.authors));
  check('the submission track is still detected as an article', h.papers[0]?.type === 'article',
    JSON.stringify(h.papers[0]?.type));
}

// ── 3. L6: notes present but NONE parseable -> an error, not emptiness ────
{
  serve([
    { id: 'n3', forum: 'n3', content: { abstract: { value: 'no title here' } } },
    { id: 'n4', forum: 'n4', content: {} },
  ]);
  const h = await searchSource('openreview', 'anything', { rows: 5 });
  check('a reply with no parseable title IS an error', h.error !== null, h.error ?? 'null');
  check('and the message says the reply was not understood', /not understood/i.test(h.error ?? ''), h.error ?? '');
  check('and it returns no papers', h.papers.length === 0, String(h.papers.length));
}

// ── 4. No regression: a PARTIAL drop is not a failure ─────────────────────
{
  serve([
    { id: 'n5', forum: 'n5', content: { title: { value: 'A Titled Note' } } },
    { id: 'n6', forum: 'n6', content: { abstract: { value: 'no title here' } } },
  ]);
  const h = await searchSource('openreview', 'note', { rows: 5 });
  check('one untitled note among titled ones is not an error', h.error === null, h.error ?? 'null');
  check('and the titled note is returned', h.papers.length === 1, String(h.papers.length));
}

// ── 5. No regression: a genuinely empty reply is an empty answer ──────────
{
  serve([]);
  const h = await searchSource('openreview', 'nothing', { rows: 5 });
  check('an empty reply reports no error', h.error === null, h.error ?? 'null');
  check('an empty reply returns no papers', h.papers.length === 0, String(h.papers.length));
}

globalThis.fetch = realFetch;
console.log('\nD95 OpenReview fields: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
