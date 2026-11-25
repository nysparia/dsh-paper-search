// d67 — a PEER-REVIEW REPORT is not a REVIEW ARTICLE.
//
// THE DEFECT. `canonicalKind` folded each platform's `type` vocabulary onto the
// three kinds this tool offers, and it tested `t.includes('review')` first. That
// is right for `review-article` (which contains both words) and wrong for
// `peer-review`, which is the REFEREE REPORT itself — Crossref deposits those as
// first-class records, and this repo has already seen their titles
// ("Peer Review Report For: …", see the `titleKey` comment in lib/sources.js).
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580): `canonicalKind('peer-review')`
// returned 'review', so `kind: 'review'` returned referee reports mixed in with
// review articles — the opposite of what a caller asking for reviews wants.
//
// A peer-review report is not one of the three kinds this tool offers, so it
// maps to `null`, the same answer as any other vocabulary the tool does not
// know. `filterAndSort` counts those separately as `kindUnrecognized` and says
// so in the reply, rather than pretending they "did not match".

import { canonicalKind, filterAndSort } from '../lib/index.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

// ── 1. The mapping ──────────────────────────────────────────────────────────
{
  check('peer-review is NOT a review', canonicalKind('peer-review') === null, String(canonicalKind('peer-review')));
  check('"Peer Review" (spaced) is NOT a review', canonicalKind('Peer Review') === null, String(canonicalKind('Peer Review')));
  check('review-article IS a review', canonicalKind('review-article') === 'review', String(canonicalKind('review-article')));
  check('review IS a review', canonicalKind('review') === 'review', String(canonicalKind('review')));
  check('journal-article IS an article', canonicalKind('journal-article') === 'article', String(canonicalKind('journal-article')));
  check('posted-content IS a preprint', canonicalKind('posted-content') === 'preprint', String(canonicalKind('posted-content')));
  check('an unknown vocabulary is null', canonicalKind('paratext') === null, String(canonicalKind('paratext')));
}

// ── 2. The filter, end to end ───────────────────────────────────────────────
{
  const papers = [
    { title: 'A real review', type: 'review-article', citedBy: 5 },
    { title: 'A referee report', type: 'peer-review', citedBy: 0 },
    { title: 'Original research', type: 'journal-article', citedBy: 9 },
  ];
  const r = filterAndSort(papers, { kind: ['review'] });
  check('kind:"review" returns ONLY the review article',
    r.papers.length === 1 && r.papers[0].title === 'A real review',
    r.papers.map((p) => p.title).join(' | '));
  check('the referee report is counted as UNRECOGNIZED, not as a mismatch',
    r.dropped.kindUnrecognized === 1 && r.dropped.kindMismatch === 1,
    JSON.stringify(r.dropped));
}

done('D67 a peer-review report is not a review article');
