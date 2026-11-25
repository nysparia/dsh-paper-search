// d91 — a DOI that is not a DOI must not be printed as one.
//
// THE DEFECT. `makePaper` did `const doi = normalizeDoi(p.doi)`, and
// `normalizeDoi` is a NORMALIZER, not a validator — its own comment says it
// "accepts ALMOST any text". So a source that returned a malformed identifier
// had it printed in the `doi:` slot and turned into a `https://doi.org/…` link.
//
// Measured 24 Nov 2026 on 0.8.0 with a Crossref reply carrying `DOI: 'not a doi'`:
//
//   1. A
//      doi: not a doi
//
// and the record's URL became `https://doi.org/not a doi`. The record then claims
// an identifier it does not have, and the link is dead. A reader who copies the
// DOI gets nothing; a reader who trusts the record believes the paper is
// registered when it is not.
//
// `isDoi` is the validator the rest of the file already uses to decide whether a
// QUERY is a DOI. The same test now decides whether a REPLY's DOI is one. A
// rejected DOI becomes `null`, which the reply already renders correctly (no
// `doi:` line, and the URL falls back to whatever the source gave).

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** Run one Crossref search over the given items and return the reply. */
async function replyFor(items) {
  const tools = loadTools();
  const h = installFetch((url) => (new URL(url).host === 'api.crossref.org'
    ? { body: { message: { items } } }
    : { body: {} }));
  const reply = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', max_results: 10 });
  h.restore();
  return reply;
}

// ── 1. A malformed DOI is not printed ──────────────────────────────────────
{
  const r = await replyFor([{ DOI: 'not a doi', title: ['A'], URL: 'https://example.org/a' }]);
  check('a malformed DOI is NOT printed in the doi: slot', !/doi: not a doi/.test(r),
    r.split('\n').filter((l) => /doi:|url:/.test(l)).join(' | ') || '(no doi/url line)');
  check('the record falls back to the URL the source gave', /url: https:\/\/example\.org\/a/.test(r),
    r.split('\n').filter((l) => /doi:|url:/.test(l)).join(' | '));
}

// ── 2. A real DOI is still printed, in every spelling ──────────────────────
{
  for (const [raw, expected] of [
    ['10.1234/ok', '10.1234/ok'],
    ['https://doi.org/10.1234/url', '10.1234/url'],
    ['10.1016/S0140-6736(20)30183-5', '10.1016/s0140-6736(20)30183-5'],
    ['10.1234/ok.', '10.1234/ok'],
  ]) {
    const r = await replyFor([{ DOI: raw, title: ['T'] }]);
    check(`a real DOI ${JSON.stringify(raw)} is printed as ${expected}`,
      r.includes(`doi: ${expected}`), r.split('\n').find((l) => /doi:/.test(l)) ?? 'SILENT');
  }
}

// ── 3. An empty DOI is not printed ─────────────────────────────────────────
{
  const r = await replyFor([{ DOI: '', title: ['C'], URL: 'https://example.org/c' }]);
  check('an empty DOI prints no doi: line', !/doi:/.test(r),
    r.split('\n').filter((l) => /doi:|url:/.test(l)).join(' | '));
}

done('D91 a DOI must be a DOI');
