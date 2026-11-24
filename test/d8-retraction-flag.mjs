// test/d8-retraction-flag.mjs — D8: search results never carried the retraction flag.
//
// Measured on baseline 864a6e8 with a mocked OpenAlex reply for the retracted
// Lancet hydroxychloroquine paper:
//
//   paper keys: title, authors, year, source, doi, url, journal, abstract,
//               openAccess, citedBy, type
//   isRetracted present: false
//
// `paper_detail` warns about retraction; `paper_search` did not. The codebase
// calls this the worst possible failure mode (`lib/sources.js:604-634`): a
// retracted paper is exactly the paper a reader most needs to be warned about.
// The fix must FLAG it, never filter it out.
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();

const RETRACTED = {
  id: 'https://openalex.org/W3027680906',
  doi: 'https://doi.org/10.1016/S0140-6736(20)31180-6',
  title: 'Hydroxychloroquine or chloroquine with or without a macrolide for treatment of COVID-19: a multinational registry analysis',
  publication_year: 2020,
  type: 'article',
  cited_by_count: 1200,
  is_retracted: true,
  open_access: { is_oa: false },
  primary_location: { source: { display_name: 'The Lancet' } },
  authorships: [{ author: { display_name: 'Mandeep R. Mehra' } }],
  abstract_inverted_index: { Background: [0], hydroxychloroquine: [1] },
};

const NORMAL = {
  id: 'https://openalex.org/W2000000001',
  doi: 'https://doi.org/10.1038/nature14539',
  title: 'Human-level control through deep reinforcement learning',
  publication_year: 2015,
  type: 'article',
  cited_by_count: 9000,
  is_retracted: false,
  open_access: { is_oa: true },
  primary_location: { source: { display_name: 'Nature' } },
  authorships: [{ author: { display_name: 'Volodymyr Mnih' } }],
};

const mock = installFetch((url) => {
  if (url.includes('api.openalex.org/works')) return { body: { results: [RETRACTED, NORMAL], meta: { count: 2 } } };
  return { status: 404, body: 'not mocked' };
});

const tools = await loadTools();
const reply = await tools.get('paper_search').execute({ query: 'hydroxychloroquine', sources: 'openalex' });
mock.restore();

check('the retracted paper is NOT filtered out of the reply', /Hydroxychloroquine or chloroquine/i.test(reply));
check('the reply carries a retraction warning', /RETRACTED/i.test(reply), reply.split('\n').filter((l) => /RETRACT/i.test(l)).join(' | ') || 'no line mentions retraction');
check('the warning sits on the retracted paper, not the clean one',
  /RETRACTED[\s\S]*Hydroxychloroquine|Hydroxychloroquine[\s\S]*RETRACTED/i.test(reply));
check('the non-retracted paper is not flagged',
  !/Human-level control[\s\S]{0,200}RETRACTED/i.test(reply));

// The flag must survive dedup: when two databases return the same DOI and only
// one of them flags it, the merged record is flagged. Dropping it there would
// hide the warning exactly when the sources disagree about the same paper.
const { dedup } = await import('../lib/sources.js');
const merged = dedup([
  { title: 'Same paper', doi: '10.1/x', source: 'openalex', isRetracted: true, authors: [] },
  { title: 'Same paper', doi: '10.1/x', source: 'crossref', isRetracted: false, authors: [] },
]);
check('dedup keeps the retraction flag', merged.length === 1 && merged[0].isRetracted === true,
  JSON.stringify(merged.map((p) => ({ doi: p.doi, isRetracted: p.isRetracted }))));

done('D8 retraction flag in search results');
