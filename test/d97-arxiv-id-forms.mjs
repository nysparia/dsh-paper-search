// test/d97-arxiv-id-forms.mjs — two arXiv id helpers rejected forms that arXiv
// and OpenAlex both resolve.
//
// ── L9: `arxivIdFromUrl` KEPT A TRAILING `/` AND DIED ON A `?` ─────────────
//
// Measured 25 Nov 2026:
//
//   https://arxiv.org/abs/1706.03762/            -> "1706.03762/"
//   https://arxiv.org/abs/1706.03762?context=cs  -> null
//
// `arxivWork('1706.03762/')` then asked for `id_list=1706.03762%2F`, which arXiv
// answers **HTTP 200 with totalResults=0** — a valid-looking empty answer for an
// id that resolves fine without the slash.
//
// ── L10: `isArxivId` DID NOT RECOGNISE OLD-STYLE IDS ──────────────────────
//
// Measured 25 Nov 2026:
//
//   "hep-th/9901001"       -> null
//   "arXiv:hep-th/9901001" -> null
//
// Pre-2007 ids are still resolvable by both platforms:
//
//   export.arxiv.org/api/query?id_list=hep-th/9901001
//     -> HTTP 200, 1 result ("String Junctions and Their Duals in Heterotic
//        String Theory")
//   api.openalex.org/works?filter=arxiv:hep-th/9901001
//     -> HTTP 200, count 1
//
// So `paper_detail('hep-th/9901001')` fell through to a TITLE search that could
// not find it.
//
// WHAT MUST STILL WORK. The new-style forms, the version suffix, the `.pdf`
// suffix, and a non-arXiv URL still returning null.

import { arxivIdFromUrl, isArxivId, parseIdentifier } from '../lib/sources.js';
import { check } from './harness.mjs';

// ── 1. L10: old-style ids are recognised ──────────────────────────────────
{
  check('a bare old-style id is recognised', isArxivId('hep-th/9901001')?.id === 'hep-th/9901001',
    JSON.stringify(isArxivId('hep-th/9901001')));
  check('an arXiv:-prefixed old-style id is recognised', isArxivId('arXiv:hep-th/9901001')?.id === 'hep-th/9901001',
    JSON.stringify(isArxivId('arXiv:hep-th/9901001')));
  check('a subject-class old-style id is recognised', isArxivId('math.GT/0309136')?.id === 'math.GT/0309136',
    JSON.stringify(isArxivId('math.GT/0309136')));
  check('a short-archive old-style id is recognised', isArxivId('cs/0112017')?.id === 'cs/0112017',
    JSON.stringify(isArxivId('cs/0112017')));
  check('an old-style id keeps its version suffix', isArxivId('hep-th/9901001v2')?.id === 'hep-th/9901001v2',
    JSON.stringify(isArxivId('hep-th/9901001v2')));
}

// ── 2. No regression: the new-style forms are unchanged ───────────────────
{
  check('a bare new-style id is recognised', isArxivId('1706.03762')?.id === '1706.03762',
    JSON.stringify(isArxivId('1706.03762')));
  check('a versioned new-style id keeps the version', isArxivId('arXiv:1706.03762v2')?.id === '1706.03762v2',
    JSON.stringify(isArxivId('arXiv:1706.03762v2')));
  check('a 5-digit new-style id is recognised', isArxivId('2106.12345')?.id === '2106.12345',
    JSON.stringify(isArxivId('2106.12345')));
}

// ── 3. L10 must not make the test always true ─────────────────────────────
{
  check('a title is not an id', isArxivId('Attention Is All You Need') === null,
    JSON.stringify(isArxivId('Attention Is All You Need')));
  check('a bare archive name is not an id', isArxivId('hep-th') === null, JSON.stringify(isArxivId('hep-th')));
  check('an old-style id with too few digits is not an id', isArxivId('hep-th/990100') === null,
    JSON.stringify(isArxivId('hep-th/990100')));
  check('an empty string is not an id', isArxivId('') === null, JSON.stringify(isArxivId('')));
}

// ── 4. L9: a trailing slash and a query string no longer break the URL ────
{
  check('a trailing slash is stripped', arxivIdFromUrl('https://arxiv.org/abs/1706.03762/') === '1706.03762',
    JSON.stringify(arxivIdFromUrl('https://arxiv.org/abs/1706.03762/')));
  check('a query string is ignored', arxivIdFromUrl('https://arxiv.org/abs/1706.03762?context=cs') === '1706.03762',
    JSON.stringify(arxivIdFromUrl('https://arxiv.org/abs/1706.03762?context=cs')));
  check('a fragment is ignored', arxivIdFromUrl('https://arxiv.org/abs/1706.03762#x') === '1706.03762',
    JSON.stringify(arxivIdFromUrl('https://arxiv.org/abs/1706.03762#x')));
  check('a slash AND a query string together', arxivIdFromUrl('https://arxiv.org/abs/1706.03762/?context=cs') === '1706.03762',
    JSON.stringify(arxivIdFromUrl('https://arxiv.org/abs/1706.03762/?context=cs')));
}

// ── 5. No regression: the shapes that already worked ──────────────────────
{
  check('a plain abs URL', arxivIdFromUrl('https://arxiv.org/abs/1706.03762') === '1706.03762',
    JSON.stringify(arxivIdFromUrl('https://arxiv.org/abs/1706.03762')));
  check('a versioned pdf URL drops the version', arxivIdFromUrl('https://arxiv.org/pdf/1706.03762v7.pdf') === '1706.03762',
    JSON.stringify(arxivIdFromUrl('https://arxiv.org/pdf/1706.03762v7.pdf')));
  check('an old-style abs URL', arxivIdFromUrl('https://arxiv.org/abs/hep-th/9901001') === 'hep-th/9901001',
    JSON.stringify(arxivIdFromUrl('https://arxiv.org/abs/hep-th/9901001')));
  check('a non-arXiv URL is null', arxivIdFromUrl('https://example.org/abs/1706.03762') === null,
    JSON.stringify(arxivIdFromUrl('https://example.org/abs/1706.03762')));
  check('an empty URL is null', arxivIdFromUrl('') === null, JSON.stringify(arxivIdFromUrl('')));
}

// ── 6. L10 end to end: `parseIdentifier` routes an old-style id to arXiv ──
{
  const bare = parseIdentifier('hep-th/9901001');
  check('a bare old-style id parses as an arXiv identifier',
    bare?.prefix === 'arxiv' && bare?.value === 'hep-th/9901001', JSON.stringify(bare));
  const prefixed = parseIdentifier('arXiv:hep-th/9901001');
  check('an arXiv:-prefixed old-style id parses too',
    prefixed?.prefix === 'arxiv' && prefixed?.value === 'hep-th/9901001', JSON.stringify(prefixed));
  const modern = parseIdentifier('arXiv:1706.03762v2');
  check('the new-style form is unchanged',
    modern?.prefix === 'arxiv' && modern?.value === '1706.03762v2', JSON.stringify(modern));
}

console.log('\nD97 arXiv id forms: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
