// test/d95-pubmed-kind.mjs — `pubmed`, `pmc` and `europepmc` never mapped the
// work type, so `kind` kept everything and the reply misstated the platform.
//
// THE DEFECT. None of the three connectors passed a `type` to `makePaper`, so
// every record had `type: null`. `filterAndSort` keeps a null type (deliberately
// — "not stated" is not "not an article") and counts it as `kindUnknown`, and
// the reply then said:
//
//   Kind filter: review — 0 did not match · 3 still shown (the source does not
//   state its kind).
//
// Both sources DO state it. Measured live 25 Nov 2026:
//
//   PubMed esummary, PMID 30102808 (a review) -> "pubtype":["Journal Article","Review"]
//   PubMed esummary, PMID 39575807             -> "pubtype":["Journal Article"]
//   Europe PMC, DOI 10.1111/joim.12822         -> "pubType":"review; journal article"
//   Europe PMC, PPR1358976                     -> "pubType":"preprint"
//
// ── WHY NOT `pubtype[0]` ────────────────────────────────────────────────────
//
// The audit's suggested mapping was `(r.pubtype ?? [])[0]`. That is wrong for
// exactly the case the finding is about: PubMed puts the GENERIC entry first, so
// `["Journal Article","Review"]`[0] is "Journal Article", which folds to
// `article` — a review would still be dropped by `kind: 'review'` and the reply
// would still be wrong, just differently. The connector therefore folds the
// whole list through `canonicalKind` and lets a SPECIFIC kind (review/preprint)
// win over the generic one.
//
// WHAT MUST STILL WORK. A record whose platform states no type keeps `type:
// null` and is still KEPT by the filter — the null rule is not weakened.

import { searchSource } from '../lib/sources.js';
import { filterAndSort } from '../lib/index.js';
import { check, done } from './_harness.mjs';

const realFetch = globalThis.fetch;

/** Route esearch/esummary separately. */
function serveEutils(records) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/esearch.fcgi')
      ? { esearchresult: { count: String(records.length), idlist: records.map((r) => r.uid) } }
      : { result: Object.fromEntries(records.map((r) => [r.uid, r])) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
}

/** Serve one canned Europe PMC reply. */
function serveEuropePmc(results) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ resultList: { result: results } }),
  });
}

const REVIEW = {
  uid: '30102808',
  title: 'eDoctor: machine learning and the future of medicine.',
  authors: [{ name: 'Handelman GS' }],
  pubdate: '2018 Dec',
  pubtype: ['Journal Article', 'Review'],
  articleids: [{ idtype: 'doi', value: '10.1111/joim.12822' }],
};
const ARTICLE = {
  uid: '39575807',
  title: 'Securing a Generative AI-Powered Healthcare Chatbot.',
  authors: [{ name: 'Feretzakis G' }],
  pubdate: '2024 Nov 22',
  pubtype: ['Journal Article'],
  articleids: [{ idtype: 'doi', value: '10.3233/SHTI241091' }],
};
const PREPRINT = {
  uid: '99999999',
  title: 'A preprint about inertial motion capture.',
  authors: [{ name: 'Doe J' }],
  pubdate: '2025 Jan',
  pubtype: ['Preprint'],
  articleids: [],
};

// ── 1. pubmed: the type is MAPPED at all ──────────────────────────────────
// `makePaper` lowercases `type`, so the record carries the platform's own words.
{
  serveEutils([REVIEW, ARTICLE, PREPRINT]);
  const h = await searchSource('pubmed', 'x', { rows: 3 });
  const byTitle = (t) => h.papers.find((p) => (p.title ?? '').startsWith(t));
  check('pubmed: a review states a type', byTitle('eDoctor')?.type, 'review');
  check('pubmed: an original article states a type', byTitle('Securing')?.type, 'journal article');
  check('pubmed: a preprint states a type', byTitle('A preprint')?.type, 'preprint');
}

// ── 2. pubmed: `kind: 'review'` now keeps the review and drops the rest ───
// This is the user-visible consequence, and it is what proves the review was
// not folded onto the generic "Journal Article" entry that comes first.
{
  serveEutils([REVIEW, ARTICLE, PREPRINT]);
  const h = await searchSource('pubmed', 'x', { rows: 3 });
  const f = filterAndSort(h.papers, { kind: ['review'] });
  check('pubmed: kind=review keeps exactly 1 of 3', f.papers.length, 1);
  check('pubmed: the kept record is the review', (f.papers[0]?.title ?? '').startsWith('eDoctor'), true);
  check('pubmed: nothing is counted as "kind unknown"', f.dropped.kindUnknown, 0);
}

// ── 3. pubmed: `kind: 'preprint'` keeps the preprint ──────────────────────
{
  serveEutils([REVIEW, ARTICLE, PREPRINT]);
  const h = await searchSource('pubmed', 'x', { rows: 3 });
  const f = filterAndSort(h.papers, { kind: ['preprint'] });
  check('pubmed: kind=preprint keeps exactly 1 of 3', f.papers.length, 1);
  check('pubmed: the kept record is the preprint', (f.papers[0]?.title ?? '').startsWith('A preprint'), true);
}

// ── 4. pmc: the same mapping ──────────────────────────────────────────────
{
  serveEutils([REVIEW, ARTICLE]);
  const h = await searchSource('pmc', 'x', { rows: 2 });
  const f = filterAndSort(h.papers, { kind: ['review'] });
  check('pmc: kind=review keeps exactly 1 of 2', f.papers.length, 1);
  check('pmc: the kept record is the review', (f.papers[0]?.title ?? '').startsWith('eDoctor'), true);
  check('pmc: nothing is counted as "kind unknown"', f.dropped.kindUnknown, 0);
}

// ── 5. europepmc: `pubType` is a `;`-joined string ────────────────────────
{
  serveEuropePmc([
    { id: '30102808', title: 'A review of inertial motion capture', pubYear: '2018', pubType: 'review; journal article' },
    { id: '2', title: 'An original article on inertial motion capture', pubYear: '2020', pubType: 'journal article' },
    { id: 'PPR1358976', title: 'A preprint about inertial motion capture', pubYear: '2025', pubType: 'preprint' },
  ]);
  const h = await searchSource('europepmc', 'x', { rows: 3 });
  check('europepmc: every record states a type', h.papers.map((p) => p.type),
    ['review; journal article', 'journal article', 'preprint']);

  const reviews = filterAndSort(h.papers, { kind: ['review'] });
  check('europepmc: kind=review keeps exactly 1 of 3', reviews.papers.length, 1);
  check('europepmc: the kept record is the review', (reviews.papers[0]?.title ?? '').startsWith('A review'), true);
  check('europepmc: nothing is counted as "kind unknown"', reviews.dropped.kindUnknown, 0);

  const preprints = filterAndSort(h.papers, { kind: ['preprint'] });
  check('europepmc: kind=preprint keeps exactly 1 of 3', preprints.papers.length, 1);
  check('europepmc: the kept record is the preprint', (preprints.papers[0]?.title ?? '').startsWith('A preprint'), true);
}

// ── 6. A record with NO stated type keeps null and is still kept ──────────
// The null rule in `filterAndSort` is deliberate and must not be weakened by
// this fix: a source that states nothing is not a source that says "not a
// review".
{
  serveEuropePmc([{ id: '3', title: 'A record with no pubType', pubYear: '2021' }]);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  check('an unstated type is null', h.papers[0]?.type, null);
  const f = filterAndSort(h.papers, { kind: ['review'] });
  check('an unstated type is still kept by the filter', f.papers.length, 1);
  check('an unstated type is counted as kindUnknown', f.dropped.kindUnknown, 1);
}

// ── 7. `canonicalKind` is still exported from lib/index.js ────────────────
// It moved to `sources.js` so the connectors could reach it; the public name
// must not move with it, and there must not be two copies of the mapping.
{
  const index = await import('../lib/index.js');
  const sources = await import('../lib/sources.js');
  check('lib/index.js still exports canonicalKind', typeof index.canonicalKind, 'function');
  check('lib/sources.js exports it too', typeof sources.canonicalKind, 'function');
  check('the re-export is the same binding', index.canonicalKind === sources.canonicalKind, true);
  check('the mapping still folds the platform vocabulary', index.canonicalKind('Journal Article'), 'article');
  check('a review-article is still a review', index.canonicalKind('review-article'), 'review');
  check('a peer-review report is still not a review', index.canonicalKind('peer-review'), null);
}

globalThis.fetch = realFetch;
done('D95 pubmed kind');
