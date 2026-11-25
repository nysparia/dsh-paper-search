// test/d110-semantic-open-access.mjs — `semantic` claimed open access for a
// paper Semantic Scholar marks CLOSED.
//
// THE DEFECT. `openAccess: !!d.openAccessPdf`. Semantic Scholar returns
// `openAccessPdf` as a NON-NULL object with an EMPTY url for a closed paper, so
// `!!` was `true` and the record was labelled open access.
//
// Measured live 25 Nov 2026 on `/graph/v1/paper/search/match`:
//
//   {"title":"GENERATIVE ADVERSARIAL NETS","isOpenAccess":false,
//    "openAccessPdf":{"url":"","status":null,"license":null}}
//
// The consequence is user-visible and is the Zenodo/HAL defect (`d28`) in the
// opposite direction: the search list printed "· open access" for a paywalled
// paper, and `open_access_only: true` KEPT it. A reader filtering for open
// access was handed a paper the platform says is closed.
//
// WHAT MUST STILL WORK. A paper the platform marks open must still be open, and
// a reply that omits `isOpenAccess` must fall back to the URL — never to the
// object.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Semantic Scholar reply and record the request URL. */
function serve(data) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data }),
    };
  };
  return seen;
}

// ── 1. The platform's own boolean is REQUESTED ────────────────────────────
{
  const seen = serve([]);
  await searchSource('semantic', 'x', { rows: 1 });
  const fields = new URL(seen[0]).searchParams.get('fields') ?? '';
  check('semantic requests isOpenAccess', fields.split(',').includes('isOpenAccess'), fields);
}

// ── 2. THE DEFECT: closed paper, empty-url object ─────────────────────────
{
  serve([{
    title: 'GENERATIVE ADVERSARIAL NETS',
    year: 2014,
    isOpenAccess: false,
    openAccessPdf: { url: '', status: null, license: null },
  }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('a closed paper is NOT open access', h.papers[0]?.openAccess === false,
    JSON.stringify(h.papers[0]?.openAccess));
}

// ── 3. `open_access_only` must DROP it ────────────────────────────────────
// This is the consequence the audit measured: the closed paper survived the
// filter. The filter lives in `lib/index.js`; the record it reads is here.
{
  serve([{
    title: 'GENERATIVE ADVERSARIAL NETS',
    year: 2014,
    isOpenAccess: false,
    openAccessPdf: { url: '', status: null, license: null },
  }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  const kept = h.papers.filter((p) => p.openAccess === true);
  check('open_access_only keeps 0 of 1', kept.length === 0, `${kept.length} kept`);
}

// ── 4. An open paper is still open ────────────────────────────────────────
{
  serve([{
    title: 'Attention is all you need',
    year: 2017,
    isOpenAccess: true,
    openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762', status: 'GREEN', license: null },
  }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('an open paper is open access', h.papers[0]?.openAccess === true,
    JSON.stringify(h.papers[0]?.openAccess));
}

// ── 5. No `isOpenAccess` in the reply: fall back to the URL ───────────────
{
  serve([{ title: 'A paper with a real PDF url', year: 2020, openAccessPdf: { url: 'https://example.org/x.pdf' } }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('a real url without isOpenAccess is open access', h.papers[0]?.openAccess === true,
    JSON.stringify(h.papers[0]?.openAccess));
}

{
  serve([{ title: 'A paper with an empty url and no boolean', year: 2020, openAccessPdf: { url: '' } }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('an empty url without isOpenAccess is NOT open access', h.papers[0]?.openAccess === false,
    JSON.stringify(h.papers[0]?.openAccess));
}

{
  serve([{ title: 'A paper with no openAccessPdf at all', year: 2020 }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('a missing openAccessPdf is NOT open access', h.papers[0]?.openAccess === false,
    JSON.stringify(h.papers[0]?.openAccess));
}

globalThis.fetch = realFetch;
console.log('\nD93 semantic open access: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
