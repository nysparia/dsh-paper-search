// test/d95-doi-from-bibtex.mjs — a BibTeX placeholder was accepted as a DOI.
//
// THE DEFECT. `doiFromBibtex` returned whatever sat between the braces, and
// `normalizeDoi` only requires more than three characters, so an OpenReview
// record whose BibTeX writes `doi = {none}` produced `doi: none` in the reply —
// a value the source never claimed. Measured 24 Nov 2026 on 0.8.0:
//
//   doi = {none}  ->  "none"
//
// The value now has to pass the same `isDoi` shape test the rest of the file
// uses, so a placeholder becomes `null` ("not reported") instead of a DOI.
//
// WHAT MUST STILL WORK. A real DOI in braces, in quotes, and as a full
// `https://doi.org/…` URL is still found and normalized — that is what the
// function exists for, and the audit measured all three as correct.

import { searchSource } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();
const realFetch = globalThis.fetch;

/** Serve one OpenReview note whose BibTeX carries `bib`. */
function serveBibtex(bib) {
  const body = JSON.stringify({
    notes: [{
      id: 'abc123',
      forum: 'abc123',
      content: {
        title: { value: 'A Real Paper' },
        authors: { value: ['A. Author'] },
        _bibtex: { value: bib },
      },
    }],
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://api2.openreview.net/notes/search',
    headers: { get: () => null },
    text: async () => body,
  });
}

// ── A placeholder is not a DOI ────────────────────────────────────────────
{
  serveBibtex('@inproceedings{key, title={A Real Paper}, doi = {none}}');
  const h = await searchSource('openreview', 'literature', { rows: 5 });
  check('a BibTeX placeholder "none" is NOT a DOI', h.papers[0]?.doi === null,
    JSON.stringify(h.papers[0]?.doi));
  check('and the record is still returned', h.papers[0]?.title === 'A Real Paper',
    h.papers[0]?.title ?? '(none)');
}

{
  serveBibtex('@inproceedings{key, title={A Real Paper}, doi = {TBD}}');
  const h = await searchSource('openreview', 'literature', { rows: 5 });
  check('a BibTeX placeholder "TBD" is NOT a DOI', h.papers[0]?.doi === null,
    JSON.stringify(h.papers[0]?.doi));
}

// ── A real DOI is still found ─────────────────────────────────────────────
{
  serveBibtex('@inproceedings{key, title={A Real Paper}, doi = {10.1234/abc}}');
  const h = await searchSource('openreview', 'literature', { rows: 5 });
  check('a real DOI in braces is still found', h.papers[0]?.doi === '10.1234/abc',
    JSON.stringify(h.papers[0]?.doi));
}

{
  serveBibtex('@inproceedings{key, title={A Real Paper}, doi = "10.1234/abc"}');
  const h = await searchSource('openreview', 'literature', { rows: 5 });
  check('a real DOI in quotes is still found', h.papers[0]?.doi === '10.1234/abc',
    JSON.stringify(h.papers[0]?.doi));
}

{
  serveBibtex('@inproceedings{key, title={A Real Paper}, doi = {https://doi.org/10.1234/ABC}}');
  const h = await searchSource('openreview', 'literature', { rows: 5 });
  check('a full doi.org URL is still normalized to the bare DOI',
    h.papers[0]?.doi === '10.1234/abc', JSON.stringify(h.papers[0]?.doi));
}

{
  serveBibtex('@inproceedings{key, title={A Real Paper}}');
  const h = await searchSource('openreview', 'literature', { rows: 5 });
  check('no DOI at all is still null', h.papers[0]?.doi === null,
    JSON.stringify(h.papers[0]?.doi));
}

globalThis.fetch = realFetch;
done('d95 doi from bibtex');
