// D5 — `isDoi` accepts trailing punctuation, and the DOI keeps it.
//
// Measured on baseline 864a6e8:
//   isDoi('10.1038/nature14539.') -> true   normalizeDoi -> '10.1038/nature14539.'
//   isDoi('10.1038/nature14539,') -> true   normalizeDoi -> '10.1038/nature14539,'
//
// A DOI pasted from the end of a sentence therefore 404s in OpenAlex, and the
// reply says "DOI … not found in OpenAlex" — which reads as "this paper does
// not exist".
//
// THE TRAP: a DOI may legitimately END with `)`. The Lancet hydroxychloroquine
// DOI is `10.1016/S0140-6736(20)31180-6` and must survive; only a `)` that is
// UNBALANCED (more `)` than `(`) is punctuation.
//
// NOTE on case: `normalizeDoi` has always lowercased (it is the dedup key), so
// "unchanged" below means the parentheses and every other character survive —
// the lowercasing is pre-existing and is not part of this defect.

import { isDoi, normalizeDoi, parseIdentifier } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

const LANCET = '10.1016/S0140-6736(20)31180-6';
const LANCET_LC = '10.1016/s0140-6736(20)31180-6';

// ── the defect: trailing punctuation is stripped ─────────────────────────────
check('trailing "." is stripped',
  normalizeDoi('10.1038/nature14539.'), '10.1038/nature14539');

check('trailing "," is stripped',
  normalizeDoi('10.1038/nature14539,'), '10.1038/nature14539');

check('trailing ";" is stripped',
  normalizeDoi('10.1038/nature14539;'), '10.1038/nature14539');

check('trailing ":" is stripped',
  normalizeDoi('10.1038/nature14539:'), '10.1038/nature14539');

check('a run of trailing punctuation is stripped',
  normalizeDoi('10.1038/nature14539.).'), '10.1038/nature14539');

check('isDoi still accepts the punctuated form (it is a DOI, just dirty)',
  isDoi('10.1038/nature14539.'), true);

check('isDoi still accepts the clean form',
  isDoi('10.1038/nature14539'), true);

// ── the trap: a balanced trailing ")" is part of the DOI ────────────────────
check('the Lancet DOI survives unchanged',
  normalizeDoi(LANCET), LANCET_LC);

check('the Lancet DOI with a trailing "." normalizes to the same string',
  normalizeDoi(`${LANCET}.`), LANCET_LC);

check('the Lancet DOI with a trailing "," normalizes to the same string',
  normalizeDoi(`${LANCET},`), LANCET_LC);

check('isDoi accepts the Lancet DOI',
  isDoi(LANCET), true);

check('a DOI ending in a balanced ")" keeps it',
  normalizeDoi('10.1234/foo(bar)'), '10.1234/foo(bar)');

check('a DOI ending in a balanced ")" keeps it after a trailing "."',
  normalizeDoi('10.1234/foo(bar).'), '10.1234/foo(bar)');

check('an unbalanced ")" is stripped',
  normalizeDoi('10.1234/foo(bar))'), '10.1234/foo(bar)');

check('an unbalanced "(" is NOT stripped (only ")" is punctuation)',
  normalizeDoi('10.1234/foo(bar'), '10.1234/foo(bar');

// ── what must NOT change ────────────────────────────────────────────────────
check('a title is still not a DOI',
  isDoi('Attention is all you need'), false);

check('a bare number is still not a DOI',
  isDoi('37074525'), false);

check('the doi: prefix is still accepted',
  isDoi('doi: 10.1038/nature14539'), true);

check('the doi.org URL prefix is still stripped',
  normalizeDoi('https://doi.org/10.1038/nature14539'), '10.1038/nature14539');

check('the doi.org URL prefix plus trailing "." is stripped',
  normalizeDoi('https://doi.org/10.1038/nature14539.'), '10.1038/nature14539');

check('a DOI with nothing after the slash is not a DOI',
  isDoi('10.1038/.'), false);

// ── the identifier path uses the same normalization ─────────────────────────
check('parseIdentifier normalizes a punctuated DOI',
  parseIdentifier('10.1038/nature14539.'), { prefix: 'doi', value: '10.1038/nature14539' });

check('parseIdentifier keeps the Lancet DOI intact',
  parseIdentifier(LANCET), { prefix: 'doi', value: LANCET_LC });

done('D5 DOI punctuation');
