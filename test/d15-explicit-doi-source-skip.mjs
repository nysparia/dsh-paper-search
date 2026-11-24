// test/d15-explicit-doi-source-skip.mjs — D15: an explicitly-named DOI-only
// source was sent a keyword and reported "OK, 0 results".
//
// `runSearch` skipped a DOI-input source when the query was not a DOI — but only
// when the source was NOT named explicitly:
//
//   if (!queryIsDoi && findSource(id)?.input === 'doi' && !choice.explicit) { skipped.push(id); continue; }
//
// With `sources: "unpaywall"` and a keyword query, `explicit` is true, so the
// source ran. `unpaywall()` calls `normalizeDoi(query)`, which accepts almost any
// text, and requested:
//
//   https://api.unpaywall.org/v2/digital%20literacy?email=…
//
// Measured reply on the round-1 baseline:
//
//   query: digital literacy
//   1 sources searched · 1 answered · 0 unique papers after dedup
//     OK     Unpaywall          api/doi   0 results  (1 ms)
//   NO results passed the filter.
//
// The source is reported as having ANSWERED. It did not — it was asked a question
// it cannot answer, and the reply then advised "retry once, then try other
// sources", which is the wrong advice for a request that was malformed.
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();

// ── keyword query, explicit DOI-only source ──────────────────────────────────
const keywordMock = installFetch((url) => {
  if (url.includes('api.unpaywall.org')) return { body: { title: 'should never be requested', is_oa: true } };
  return { body: {} };
});
const tools = loadTools({ cache: false, OPENALEX_EMAIL: 'someone@example.org' });
const keywordReply = await tools.get('paper_search').execute({ query: 'digital literacy', sources: 'unpaywall' });
keywordMock.restore();

check('the DOI-only source is NOT called with a keyword',
  !keywordMock.calls.some((c) => c.url.includes('api.unpaywall.org')),
  keywordMock.calls.map((c) => c.url).join(' | ') || 'no request at all');
check('no "OK … 0 results" line for Unpaywall',
  !/OK\s+Unpaywall/.test(keywordReply),
  keywordReply.split('\n').filter((l) => /Unpaywall/.test(l)).join(' | ') || 'no line mentions Unpaywall');
check('the reply names the skipped source',
  /unpaywall/i.test(keywordReply),
  keywordReply.split('\n').filter((l) => /unpaywall/i.test(l)).join(' | '));
check('the reply states the reason — the source searches by DOI',
  /not a DOI/.test(keywordReply) && /DOI, not by keyword/.test(keywordReply),
  keywordReply.split('\n').filter((l) => /not a DOI/.test(l)).join(' | '));
check('the reply does not claim the source answered',
  !/1 answered/.test(keywordReply),
  keywordReply.split('\n').filter((l) => /answered/.test(l)).join(' | '));
check('the reply does not advise "retry once, then try other sources" when nothing ran',
  !/retry once, then try other sources/.test(keywordReply),
  keywordReply.split('\n').filter((l) => /retry|no literature/i.test(l)).join(' | '));
check('the reply says plainly that nothing was searched',
  /no source was actually searched|NOTHING was searched/i.test(keywordReply),
  keywordReply.split('\n').filter((l) => /searched/i.test(l)).join(' | '));

// ── the same source with a real DOI still runs ───────────────────────────────
const doiMock = installFetch((url) => {
  if (url.includes('api.unpaywall.org')) {
    return { body: { title: 'Unpaywall paper', doi: '10.1038/nature14539', is_oa: true, year: 2015, journal_name: 'Nature' } };
  }
  return { body: {} };
});
const doiReply = await tools.get('paper_search').execute({ query: '10.1038/nature14539', sources: 'unpaywall' });
doiMock.restore();

check('a DOI query still reaches the DOI-only source',
  doiMock.calls.some((c) => c.url.includes('api.unpaywall.org')),
  doiMock.calls.map((c) => c.url).join(' | ') || 'no request at all');
check('a DOI query reports the source as answering',
  /OK\s+Unpaywall/.test(doiReply),
  doiReply.split('\n').filter((l) => /Unpaywall/.test(l)).join(' | '));
check('a DOI query is not skipped',
  !/not a DOI/.test(doiReply),
  doiReply.split('\n').filter((l) => /not a DOI/.test(l)).join(' | '));

// ── mixed selection: the keyword source runs, the DOI source is skipped ──────
const mixedMock = installFetch((url) => {
  if (url.includes('api.unpaywall.org')) return { body: { title: 'should never be requested', is_oa: true } };
  if (url.includes('api.crossref.org')) {
    return { body: { message: { items: [{ title: ['A Crossref paper'], DOI: '10.1/crossref', issued: { 'date-parts': [[2020]] } }] } } };
  }
  return { body: {} };
});
const mixedReply = await tools.get('paper_search').execute({ query: 'digital literacy', sources: 'crossref,unpaywall' });
mixedMock.restore();

check('the keyword source still runs in a mixed selection',
  /A Crossref paper/.test(mixedReply),
  mixedReply.split('\n').filter((l) => /Crossref/.test(l)).join(' | '));
check('the DOI-only source is skipped in a mixed selection',
  !mixedMock.calls.some((c) => c.url.includes('api.unpaywall.org')),
  mixedMock.calls.map((c) => c.url).join(' | '));
check('the mixed reply still explains the skip',
  /not a DOI/.test(mixedReply),
  mixedReply.split('\n').filter((l) => /not a DOI/.test(l)).join(' | '));

// ── the source stays in the registry ────────────────────────────────────────
const status = await tools.get('paper_status').execute({});
check('Unpaywall is still a registered source',
  /Unpaywall\s+api\/doi\s+registered/.test(status),
  status.split('\n').filter((l) => /Unpaywall/.test(l)).join(' | '));

done('D15 explicit DOI-only source sent a keyword');
