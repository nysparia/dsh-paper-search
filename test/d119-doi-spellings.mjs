// test/d119-doi-spellings.mjs — five spellings of one DOI did not normalize
// together, so one paper became two records after `dedup`.
//
// THE DEFECT. Measured 25 Nov 2026 on the baseline:
//
//   www.doi.org URL        | false | "https://www.doi.org/10.1038/nature14539"  DIFFERENT KEY
//   angle brackets         | false | "<10.1038/nature14539>"                    DIFFERENT KEY
//   trailing slash         | true  | "10.1038/nature14539/"                     DIFFERENT KEY
//   surrounding quotes     | false | "\"10.1038/nature14539\""                  DIFFERENT KEY
//   trailing question mark | true  | "10.1038/nature14539?"                     DIFFERENT KEY
//
// All five are shapes a DOI picks up when it is pasted from running text or from
// a citation manager. Two spellings of one DOI that do not normalize together
// become two records after `dedup`.
//
// THE TRAP. The Lancet hydroxychloroquine DOI is
// `10.1016/S0140-6736(20)31180-6` — it ends in a BALANCED `)`, which is part of
// the DOI. `test/d5-doi-punctuation.mjs` pins that, and this fix must not break
// it. A DOI may also contain `>` inside (the old SICI form), so a bare trailing
// `>` is only punctuation when the string also OPENED with `<`.

import { isDoi, normalizeDoi } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

const DOI = '10.1038/nature14539';
const LANCET = '10.1016/S0140-6736(20)31180-6';
const LANCET_LC = '10.1016/s0140-6736(20)31180-6';

// ── 1. THE DEFECT: the five strays collapse onto the clean key ────────────
check('a www.doi.org URL normalizes to the bare DOI',
  normalizeDoi('https://www.doi.org/10.1038/nature14539'), DOI);
check('a www.doi.org URL without a scheme normalizes too',
  normalizeDoi('www.doi.org/10.1038/nature14539'), DOI);
check('angle brackets are stripped',
  normalizeDoi('<10.1038/nature14539>'), DOI);
check('surrounding quotes are stripped',
  normalizeDoi('"10.1038/nature14539"'), DOI);
check('a trailing slash is stripped',
  normalizeDoi('10.1038/nature14539/'), DOI);
check('a trailing question mark is stripped',
  normalizeDoi('10.1038/nature14539?'), DOI);

// ── 2. All five agree with each other ─────────────────────────────────────
{
  const spellings = [
    DOI,
    'https://www.doi.org/10.1038/nature14539',
    '<10.1038/nature14539>',
    '"10.1038/nature14539"',
    '10.1038/nature14539/',
    '10.1038/nature14539?',
    'https://doi.org/10.1038/nature14539',
    'doi: 10.1038/nature14539',
    '10.1038/NATURE14539',
    '10.1038/nature14539.',
  ];
  const keys = new Set(spellings.map((s) => normalizeDoi(s)));
  check('every spelling produces one key', keys.size, 1);
  check('the key is the bare lowercased DOI', [...keys][0], DOI);
}

// ── 3. The Lancet DOI still survives ──────────────────────────────────────
check('the Lancet DOI is unchanged', normalizeDoi(LANCET), LANCET_LC);
check('the Lancet DOI with a trailing slash is unchanged',
  normalizeDoi(`${LANCET}/`), LANCET_LC);
check('the Lancet DOI in angle brackets is unchanged',
  normalizeDoi(`<${LANCET}>`), LANCET_LC);
check('the Lancet DOI in quotes is unchanged',
  normalizeDoi(`"${LANCET}"`), LANCET_LC);
check('the Lancet DOI with a trailing period is unchanged',
  normalizeDoi(`${LANCET}.`), LANCET_LC);

// ── 4. A `>` that is part of the DOI is not stripped ──────────────────────
// The old SICI form carries `<` and `>` INSIDE the suffix. Only a PAIRED
// wrapper is removed, so a DOI that merely ends in `>` keeps it.
{
  const sici = '10.1002/(SICI)1097-4636(199706)35:4<423::AID-JBM5>3.0.CO;2-M';
  check('a SICI DOI is unchanged', normalizeDoi(sici), sici.toLowerCase());
  check('a DOI ending in a bare ">" keeps it', normalizeDoi('10.1234/foo>'), '10.1234/foo>');
}

// ── 5. What must NOT become a DOI ─────────────────────────────────────────
check('a title is still not a DOI', isDoi('Attention is all you need'), false);
check('a bare number is still not a DOI', isDoi('37074525'), false);
check('a DOI with nothing after the slash is still not a DOI', isDoi('10.1038/.'), false);
check('a DOI with only a trailing slash is still not a DOI', isDoi('10.1038/'), false);
check('an empty string is still null', normalizeDoi(''), null);
check('null is still null', normalizeDoi(null), null);

// ── 6. The cleaned forms are still recognized as DOIs ─────────────────────
check('isDoi accepts the angle-bracket form', isDoi('<10.1038/nature14539>'), true);
check('isDoi accepts the quoted form', isDoi('"10.1038/nature14539"'), true);
check('isDoi accepts the trailing-slash form', isDoi('10.1038/nature14539/'), true);
check('isDoi accepts the www.doi.org form', isDoi('https://www.doi.org/10.1038/nature14539'), true);
check('isDoi accepts the Lancet DOI', isDoi(LANCET), true);

done('D119 DOI spellings');
