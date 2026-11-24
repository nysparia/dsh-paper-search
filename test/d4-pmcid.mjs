// D4 — a bare `PMC123` is not parsed, though the tool description promises it.
//
// Measured on baseline 864a6e8:
//   parseIdentifier('PMC8371605')       -> null   <- treated as a TITLE, then searched
//   parseIdentifier('pmcid:PMC8371605') -> { prefix: 'pmcid', value: 'PMC8371605' }
//
// A bare `PMC…` is unambiguous, unlike a bare number — `sources.js:591-594`
// documents why guessing digits as PMIDs is deliberately refused, and that
// decision is correct. So only the PMC form is added here.

import { parseIdentifier } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

// ── the defect ───────────────────────────────────────────────────────────────
check('bare PMC8371605 parses as a pmcid',
  parseIdentifier('PMC8371605'), { prefix: 'pmcid', value: 'PMC8371605' });

check('bare PMC id is case-insensitive',
  parseIdentifier('pmc8371605'), { prefix: 'pmcid', value: 'PMC8371605' });

check('bare PMC id with surrounding whitespace parses',
  parseIdentifier('  PMC10113978  '), { prefix: 'pmcid', value: 'PMC10113978' });

// ── what must NOT change ─────────────────────────────────────────────────────
check('a bare number is still NOT guessed as a PMID',
  parseIdentifier('37074525'), null);

check('a bare year is still NOT guessed as a PMID',
  parseIdentifier('2024'), null);

check('the explicit pmcid prefix still works',
  parseIdentifier('pmcid:PMC8371605'), { prefix: 'pmcid', value: 'PMC8371605' });

check('the explicit pmcid prefix still accepts bare digits',
  parseIdentifier('pmcid:8371605'), { prefix: 'pmcid', value: 'PMC8371605' });

check('the explicit pmid prefix still works',
  parseIdentifier('pmid:37074525'), { prefix: 'pmid', value: '37074525' });

check('a bare DOI still parses',
  parseIdentifier('10.1038/nature14539'), { prefix: 'doi', value: '10.1038/nature14539' });

check('a bare arXiv id still parses',
  parseIdentifier('1706.03762'), { prefix: 'arxiv', value: '1706.03762' });

check('a bare OpenAlex id still parses',
  parseIdentifier('W3177828909'), { prefix: 'openalex_id', value: 'W3177828909' });

check('a title is still not an identifier',
  parseIdentifier('Attention is all you need'), null);

check('PMC followed by nothing is not an identifier',
  parseIdentifier('PMC'), null);

done('D4 bare PMCID');
