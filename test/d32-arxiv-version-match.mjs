// test/d32-arxiv-version-match.mjs — a versioned arXiv id never matches its own
// work, so `paper_detail` reports a found paper as NOT FOUND.
//
// THE DEFECT. `isArxivId` keeps the version suffix — its own doc comment shows
// `arXiv:1706.03762v2` as an accepted input — but OpenAlex stores `ids.arxiv`
// WITHOUT it (`https://arxiv.org/abs/1706.03762`). The equality test in
// `identifierMatches` therefore could never succeed for a versioned id.
//
// `resolveWorks` uses that test to decide what is missing, so the work was
// returned AND listed as absent:
//
//   1. FIRST paper the caller asked for
//      arXiv: 1706.03762 · OpenAlex: W1
//
//   NOT FOUND in OpenAlex (2):
//     · arXiv:1706.03762v2
//     · arXiv:9999.99999
//   These are genuinely absent from OpenAlex — …
//
// The same broken test drives the caller-order restoration in `lib/index.js`, so
// a batch containing a versioned id also came back in the wrong order.
//
// Measured live 24 Nov 2026: OpenAlex ACCEPTS `filter=arxiv:1706.03762v2` and
// returns the work — only the match test was wrong, the lookup itself succeeds.
//
// WHAT MUST STILL WORK. A genuinely absent id must still be reported as absent,
// and the other four prefixes must keep matching exactly.

import { parseIdentifier, identifierMatches, resolveWorks } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

// ── 1. The defect, directly ───────────────────────────────────────────────
{
  const p = parseIdentifier('arXiv:1706.03762v2');
  check('parseIdentifier keeps the version for display', p?.value === '1706.03762v2', JSON.stringify(p));
  const work = { id: 'https://openalex.org/W1', ids: { arxiv: 'https://arxiv.org/abs/1706.03762' } };
  check('a versioned id matches the unversioned OpenAlex id',
    identifierMatches(work, p.prefix, p.value) === true,
    String(identifierMatches(work, p.prefix, p.value)));
}

// ── 2. The unversioned form still matches (no regression) ─────────────────
{
  const work = { id: 'https://openalex.org/W1', ids: { arxiv: 'https://arxiv.org/abs/1706.03762' } };
  check('an unversioned id still matches', identifierMatches(work, 'arxiv', '1706.03762') === true,
    String(identifierMatches(work, 'arxiv', '1706.03762')));
}

// ── 3. A work whose ids.arxiv carries a version still matches a bare id ───
{
  const work = { id: 'https://openalex.org/W2', ids: { arxiv: 'https://arxiv.org/abs/1706.03762v7' } };
  check('a versioned OpenAlex id matches a bare input',
    identifierMatches(work, 'arxiv', '1706.03762') === true,
    String(identifierMatches(work, 'arxiv', '1706.03762')));
  check('a versioned OpenAlex id matches a versioned input',
    identifierMatches(work, 'arxiv', '1706.03762v2') === true,
    String(identifierMatches(work, 'arxiv', '1706.03762v2')));
}

// ── 4. A DIFFERENT arXiv id must still not match ──────────────────────────
// The fix must not make the test always true.
{
  const work = { id: 'https://openalex.org/W1', ids: { arxiv: 'https://arxiv.org/abs/1706.03762' } };
  check('a different arXiv id does not match', identifierMatches(work, 'arxiv', '2106.12345') === false,
    String(identifierMatches(work, 'arxiv', '2106.12345')));
  check('a different versioned arXiv id does not match',
    identifierMatches(work, 'arxiv', '2106.12345v3') === false,
    String(identifierMatches(work, 'arxiv', '2106.12345v3')));
  check('a work with no arXiv id does not match', identifierMatches({ id: 'W3' }, 'arxiv', '1706.03762') === false,
    String(identifierMatches({ id: 'W3' }, 'arxiv', '1706.03762')));
}

// ── 5. The other four prefixes are unchanged ──────────────────────────────
{
  const work = {
    id: 'https://openalex.org/W1',
    doi: 'https://doi.org/10.1038/nature14539',
    ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/26017442', pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4739640' },
  };
  check('openalex_id still matches', identifierMatches(work, 'openalex_id', 'W1') === true, 'false');
  check('doi still matches', identifierMatches(work, 'doi', '10.1038/nature14539') === true, 'false');
  check('pmid still matches', identifierMatches(work, 'pmid', '26017442') === true, 'false');
  check('pmcid still matches', identifierMatches(work, 'pmcid', 'PMC4739640') === true, 'false');
  check('a wrong doi still does not match', identifierMatches(work, 'doi', '10.1038/other') === false, 'true');
}

// ── 6. End to end: a versioned id is NOT listed as missing ────────────────
// `resolveWorks` issues two requests per chunk (plain + is_retracted:true). The
// mock answers the plain one with the work and the retracted one with nothing,
// which is what OpenAlex does for a non-retracted work.
{
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('is_retracted%3Atrue')
      ? { results: [] }
      : {
        results: [{
          id: 'https://openalex.org/W1',
          title: 'Attention Is All You Need',
          publication_year: 2017,
          ids: { arxiv: 'https://arxiv.org/abs/1706.03762' },
        }],
      };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const r = await resolveWorks(['arXiv:1706.03762v2'], {});
  check('the work is found', r.works.length === 1, String(r.works.length));
  check('a versioned id is NOT reported as unresolved', r.unresolved.length === 0,
    JSON.stringify(r.unresolved));
}

// ── 7. A genuinely absent id IS still reported ────────────────────────────
{
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ results: [] }),
  });
  const r = await resolveWorks(['arXiv:9999.99999'], {});
  check('a genuinely absent id is reported as unresolved', r.unresolved.length === 1,
    JSON.stringify(r.unresolved));
  check('and it names the input', r.unresolved[0] === 'arXiv:9999.99999', JSON.stringify(r.unresolved));
}

globalThis.fetch = realFetch;
console.log('\nD32 arXiv version match: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
