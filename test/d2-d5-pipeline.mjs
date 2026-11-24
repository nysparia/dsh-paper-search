// End-to-end regression for D2 and D5 through the REAL search pipeline.
//
// The unit tests next door call `authorList` / `normalizeDoi` directly. That is
// not enough for D2: the defect was an ORDERING bug (split before decode), and
// ordering only shows up when the whole chain runs — `searchSource` ->
// `fromOpenAlexWork` -> `makePaper` -> `authorList`/`normalizeDoi` -> `dedup`.
// A unit test would have passed even if `makePaper` re-broke the name later.
//
// `fetch` is mocked, so this makes no network request.

import { searchSource, dedup } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

const realFetch = globalThis.fetch;

function mockFetch(payload) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  });
}

function restore() {
  globalThis.fetch = realFetch;
}

// ── D2 through the pipeline: an entity-encoded author stays ONE author ───────
mockFetch({
  results: [{
    id: 'https://openalex.org/W123',
    title: 'A paper about O&#x27;Brien',
    publication_year: 2024,
    doi: 'https://doi.org/10.1038/nature14539.',
    authorships: [
      { author: { display_name: 'O&#x27;Brien, Sean' } },
      { author: { display_name: 'caf&#233;' } },
    ],
    primary_location: { source: { display_name: 'Nature' } },
    cited_by_count: 5,
    type: 'article',
  }],
});

const hit = await searchSource('openalex', 'test', { rows: 1, email: null });
restore();

check('the search itself succeeded', hit.error, null);
const paper = hit.papers[0];
check('the title decodes through the pipeline',
  paper?.title, "A paper about O'Brien");
check('the entity-encoded author is ONE author, not two',
  paper?.authors, ["O'Brien, Sean", 'café']);
check('the decimal entity decodes through the pipeline',
  paper?.authors?.[1], 'café');

// ── D5 through the pipeline: the DOI is clean, so dedup can merge ────────────
check('the trailing "." is gone from the DOI',
  paper?.doi, '10.1038/nature14539');

// NOT part of D5, and deliberately left as it is: `fromOpenAlexWork` passes the
// source's raw `w.doi` as `url`, and `makePaper` only rebuilds the URL when that
// is empty (`url: p.url || …`). So the `url` field keeps the source's own
// spelling, trailing dot included. That is pre-existing behaviour on the
// baseline too, and changing it is outside this defect's scope — recorded here
// so the difference between `doi` (normalized) and `url` (as reported) is not
// mistaken for a regression.
check('the url field still carries the source\'s raw DOI (pre-existing, out of scope)',
  paper?.url, 'https://doi.org/10.1038/nature14539.');

// Two sources returning the SAME paper, one with a dirty DOI. `makePaper`
// normalizes before `dedup` sees it, so they must merge into one record.
const merged = dedup([
  { doi: '10.1038/nature14539', title: 'A paper', source: 'openalex' },
  { doi: '10.1038/nature14539', title: 'A paper', source: 'crossref' },
]);
check('the same paper from two sources merges into one record',
  merged.length, 1);
check('both sources are recorded on the survivor',
  merged[0]?.sources, ['openalex', 'crossref']);

done('D2/D5 pipeline');
