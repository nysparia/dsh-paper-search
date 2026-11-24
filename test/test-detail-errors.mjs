// test/test-detail-errors.mjs — D3: `paper_detail` must THROW on argument
// errors, not return a string.
//
// DSH maps a thrown error to ToolExecutionFailure (isError: true) and a returned
// string to ToolExecutionSuccess (isError: false). Baseline 864a6e8 returned
// strings at lib/index.js:1034 and :1037, so a rejected call was
// indistinguishable from a real answer — and inconsistent with `paper_fulltext`
// and `paper_citations`, which both throw.
//
// The single-door path inherits the same bug: `mergeIntoOne` derives
// `required[mode]` from each tool's `parameters.required`, and `detailTool`
// declares `required: []` on purpose (identifier/identifiers are alternatives),
// so `paper({ mode: 'detail' })` reached the same returned string.
//
// Run: node test/test-detail-errors.mjs

import { check, loadTools, mockFetch, outcome } from './harness.mjs';

const tools = loadTools();
const detail = tools.get('paper_detail');
const single = tools.get('paper');
check('paper_detail is registered', !!detail);
check('the single door is NOT registered in five-tool mode', !single);

// ── 1. no identifier at all ─────────────────────────────────────────────────
const empty = await outcome(() => detail.execute({}));
check('paper_detail({}) THROWS', empty.threw, empty.threw ? empty.message : 'returned a string');
check('the message is an `invalid arguments:` rejection',
  empty.threw && /^invalid arguments:/.test(empty.message), empty.message ?? '');
// The message content must survive: it is the only place the caller learns which
// formats are accepted.
// The tokens the message actually uses — `PMC123`, not `PMCID`: the point is
// that the accepted FORMATS are still named, so the assertion follows the
// wording rather than inventing a spelling the tool never used.
for (const format of ['DOI', 'PMID', 'PMC123', 'arXiv', 'OpenAlex', 'title']) {
  check(`the message still names the ${format} format`,
    empty.threw && empty.message.includes(format), empty.message ?? '');
}

// ── 2. too many identifiers ─────────────────────────────────────────────────
const many = await outcome(() => detail.execute({ identifiers: Array.from({ length: 51 }, (_, i) => `10.1000/x${i}`) }));
check('paper_detail with 51 identifiers THROWS', many.threw, many.threw ? many.message : 'returned a string');
check('the too-many message is an `invalid arguments:` rejection',
  many.threw && /^invalid arguments:/.test(many.message), many.message ?? '');
check('the too-many message still states the limit and the count',
  many.threw && many.message.includes('50') && many.message.includes('51'), many.message ?? '');

// ── 3. the siblings already throw — the fix must not change them ────────────
const fulltext = await outcome(() => tools.get('paper_fulltext').execute({}));
check('paper_fulltext({}) still THROWS', fulltext.threw, fulltext.threw ? fulltext.message : 'returned a string');
const citations = await outcome(() => tools.get('paper_citations').execute({}));
check('paper_citations({}) still THROWS', citations.threw, citations.threw ? citations.message : 'returned a string');

// ── 4. the single door inherits the fix ─────────────────────────────────────
const one = loadTools({ tools: 'one' });
const door = one.get('paper');
check('the single door is registered in one-tool mode', !!door);
const viaDoor = await outcome(() => door.execute({ mode: 'detail' }));
check('paper({ mode: "detail" }) THROWS', viaDoor.threw, viaDoor.threw ? viaDoor.message : 'returned a string');
check('the single-door message is an `invalid arguments:` rejection',
  viaDoor.threw && /^invalid arguments:/.test(viaDoor.message), viaDoor.message ?? '');
const badMode = await outcome(() => door.execute({ mode: 'banana' }));
check('paper({ mode: "banana" }) still THROWS', badMode.threw, badMode.threw ? badMode.message : 'returned a string');

// ── 5. `required` must stay empty, or `identifiers` becomes unusable ────────
check('detailTool still declares required: []',
  Array.isArray(detail.parameters.required) && detail.parameters.required.length === 0,
  JSON.stringify(detail.parameters.required));

// ── 6. a VALID call must still succeed — the fix must not over-throw ────────
// A thrown error is now the only failure signal, so a fix that throws too
// eagerly would turn every real lookup into a failure. Mocked OpenAlex reply.
//
// A DOI is resolved through the BATCH resolver (`/works?filter=doi:…`), which
// issues two requests per chunk — one plain, one with `is_retracted:true`. The
// mock answers the plain one and leaves the retracted one empty, which is what
// OpenAlex does for a non-retracted work.
const mock = mockFetch((url) => {
  if (!url.includes('api.openalex.org/works')) return '{}';
  // Match the FILTER, not the whole URL: `is_retracted` is also one of the
  // `select` fields, so a substring test on the URL would empty both requests.
  if (url.includes('is_retracted%3Atrue')) return JSON.stringify({ results: [] });
  return JSON.stringify({
    results: [{
      id: 'https://openalex.org/W1',
      title: 'A real paper',
      publication_year: 2020,
      doi: 'https://doi.org/10.1038/nature14539',
      cited_by_count: 5,
      type: 'article',
      authorships: [{ author: { display_name: 'A. Author' } }],
    }],
  });
});
let ok = null;
try {
  ok = await outcome(() => detail.execute({ identifier: '10.1038/nature14539' }));
} finally {
  mock.restore();
}
check('a valid paper_detail call still RETURNS a string', ok && !ok.threw,
  ok?.threw ? ok.message : 'returned');
check('the valid reply contains the paper', typeof ok?.value === 'string' && ok.value.includes('A real paper'),
  typeof ok?.value === 'string' ? ok.value.split('\n')[0] : String(ok?.value));

console.log(process.exitCode ? '\nFAILED' : '\nOK');
