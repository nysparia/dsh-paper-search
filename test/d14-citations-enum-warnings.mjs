// test/d14-citations-enum-warnings.mjs — D14: `paper_citations` silently coerced
// invalid enum values.
//
// `paper_search` warns when `sort` is unrecognized (`lib/index.js`, the
// `WARNING: sort "…" is not recognized` line in `formatResult`). `paper_citations`
// did not — it substituted a default for all three of its enum-ish parameters.
// Measured on the round-1 baseline:
//
//   paper_citations({ identifier: 'W1', sort: 'banana' })
//     -> "showing 0 (most cited first)"          no warning at all
//   paper_citations({ identifier: 'W1', direction: 'sideways' })
//     -> "direction: citing — …"                 silently became "citing"
//   paper_citations({ identifier: 'W1', analysis: 'banana' })
//     -> runs the ordinary list                  silently ignored
//
// The dangerous one is `direction`: a caller who types the wrong word gets the
// OPPOSITE direction, and the reply then says "Nothing cites it yet", which reads
// as a finding about the paper rather than a mistake in the call.
//
// The fix is a WARNING line, not an error: over-supplying is common and a round
// trip is expensive.
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();

const SEED = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1038/nature14539',
  title: 'Seed paper',
  publication_year: 2015,
  cited_by_count: 100,
};

/** OpenAlex with an empty citation graph — the reply shape is what matters here. */
function mockOpenAlex() {
  return installFetch((url) => {
    if (url.includes('api.openalex.org/works/doi:')) return { body: SEED };
    if (url.includes('api.openalex.org/works')) return { body: { results: [], meta: { count: 0 } } };
    return { status: 404, body: 'not mocked' };
  });
}

const tools = loadTools();
const call = async (args) => {
  const mock = mockOpenAlex();
  try {
    return await tools.get('paper_citations').execute({ identifier: '10.1038/nature14539', ...args });
  } finally {
    mock.restore();
  }
};

// ── sort ─────────────────────────────────────────────────────────────────────
const sortReply = await call({ sort: 'banana' });
check('sort "banana" produces a WARNING naming the value',
  /WARNING: sort "banana"/.test(sortReply),
  sortReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | ') || 'no WARNING line');
check('the sort warning names the valid choices',
  /Choices: citations, newest/.test(sortReply),
  sortReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('the sort warning says which value was really used',
  /"citations" was used/.test(sortReply),
  sortReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('an invalid sort is still NOT an error — the default order is used',
  /most cited first/.test(sortReply),
  sortReply.split('\n').filter((l) => /showing/.test(l)).join(' | '));

// ── direction ────────────────────────────────────────────────────────────────
const dirReply = await call({ direction: 'sideways' });
check('direction "sideways" produces a WARNING naming the value',
  /WARNING: direction "sideways"/.test(dirReply),
  dirReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | ') || 'no WARNING line');
check('the direction warning names the valid choices',
  /Choices: citing, references/.test(dirReply),
  dirReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('the direction warning says which value was really used',
  /"citing" was used/.test(dirReply),
  dirReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('an invalid direction still runs the default direction',
  /direction: citing — papers that CITE/.test(dirReply),
  dirReply.split('\n').filter((l) => /direction:/.test(l)).join(' | '));

// ── analysis ─────────────────────────────────────────────────────────────────
const anaReply = await call({ analysis: 'banana' });
check('analysis "banana" produces a WARNING naming the value',
  /WARNING: analysis "banana"/.test(anaReply),
  anaReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | ') || 'no WARNING line');
check('the analysis warning names the valid choices',
  /Choices: list, map/.test(anaReply),
  anaReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('the analysis warning says which value was really used',
  /"list" was used/.test(anaReply),
  anaReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('an invalid analysis still runs the ordinary list',
  /direction: citing — papers that CITE/.test(anaReply),
  anaReply.split('\n').filter((l) => /direction:/.test(l)).join(' | '));

// ── valid values must stay silent ────────────────────────────────────────────
const okReply = await call({ sort: 'newest', direction: 'references', analysis: 'list' });
check('valid values produce NO warning',
  !/WARNING:/.test(okReply),
  okReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('a valid sort really takes effect', /newest first/.test(okReply),
  okReply.split('\n').filter((l) => /showing/.test(l)).join(' | '));

// The documented synonyms are VALID, not typos — warning on them would train the
// reader to ignore the warning.
const aliasReply = await call({ direction: 'backward' });
check('the documented synonym "backward" produces no warning',
  !/WARNING:/.test(aliasReply),
  aliasReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | '));
check('the synonym "backward" still means references',
  /direction: references/.test(aliasReply),
  aliasReply.split('\n').filter((l) => /direction:/.test(l)).join(' | '));

// ── the map path returns early, so it must carry the warning too ─────────────
const mapReply = await call({ analysis: 'map', direction: 'sideways', max_candidates: 5 });
check('the citation-map path also reports the direction warning',
  /WARNING: direction "sideways"/.test(mapReply),
  mapReply.split('\n').filter((l) => /WARNING/.test(l)).join(' | ') || 'no WARNING line');
check('the citation-map path really ran',
  /citation structure map/.test(mapReply),
  mapReply.split('\n').slice(0, 6).join(' | '));

done('D14 paper_citations silently coerced invalid enum values');
