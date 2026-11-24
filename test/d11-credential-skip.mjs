// test/d11-credential-skip.mjs — D11: a source that NEEDS a credential was
// reported as FAILED on every search.
//
// Measured on baseline 864a6e8, a bare `paper_search` with no credentials:
//
//   FAILED CORE               api     CORE_API_KEY is required — without a key
//                                       CORE answers HTTP 429 with an empty body
//
// CORE is in `DEFAULT_IDS` and its `credit` is 'REQUIRED — answers 429 without a
// key'. Without a key it throws before making any request, so the reply told the
// model a source "failed" when in truth it was never configured. `pmc` and `ios`
// were moved off by default for this kind of cost; CORE must NOT be removed from
// `DEFAULT_IDS` — with a key it has to run by default.
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();

// Every source answers an empty but VALID reply, so nothing fails for a real
// reason and the only thing left to observe is the credential handling.
const mock = installFetch((url) => {
  if (url.includes('api.core.ac.uk')) return { status: 429, body: '' };
  if (url.includes('api.openalex.org')) return { body: { results: [], meta: { count: 0 } } };
  if (url.includes('api.crossref.org')) return { body: { message: { items: [] } } };
  if (url.includes('api.semanticscholar.org')) return { body: { data: [] } };
  if (url.includes('doaj.org')) return { body: { results: [] } };
  if (url.includes('ebi.ac.uk')) return { body: { resultList: { result: [] } } };
  if (url.includes('eutils.ncbi.nlm.nih.gov')) return { body: { esearchresult: { idlist: [] } } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  if (url.includes('zenodo.org')) return { body: { hits: { hits: [] } } };
  if (url.includes('archives-ouvertes.fr')) return { body: { response: { docs: [] } } };
  if (url.includes('api2.openreview.net')) return { body: { notes: [] } };
  if (url.includes('eprint.iacr.org')) return { body: '<html></html>' };
  if (url.includes('garuda') || url.includes('sinta') || url.includes('onesearch')) return { body: '<html></html>' };
  return { body: {} };
});

const tools = await loadTools();
const reply = await tools.get('paper_search').execute({ query: 'literature', sources: 'core,openalex' });
mock.restore();

check('no FAILED line for CORE', !/FAILED\s+CORE/.test(reply), reply.split('\n').filter((l) => /CORE/.test(l)).join(' | '));
check('the reply says CORE was skipped for lack of a key',
  /CORE/i.test(reply) && /(no credential|not configured|skipped)/i.test(reply),
  reply.split('\n').filter((l) => /CORE/i.test(l)).join(' | ') || 'no line mentions CORE');
check('the skip reason names the missing credential', /CORE_API_KEY/.test(reply));

// With a key, CORE must still run by default — it is NOT removed from DEFAULT_IDS.
const withKey = await loadTools({ cache: false, CORE_API_KEY: 'CORE-KEY-1' });
const mock2 = installFetch((url) => {
  if (url.includes('api.core.ac.uk')) {
    return { body: { results: [{ title: 'A CORE paper', yearPublished: 2021, doi: '10.1/core', downloadUrl: 'https://core.ac.uk/x.pdf' }] } };
  }
  if (url.includes('api.openalex.org')) return { body: { results: [], meta: { count: 0 } } };
  return { body: {} };
});
const reply2 = await withKey.get('paper_search').execute({ query: 'literature', sources: 'core' });
mock2.restore();
check('with a key CORE really runs', /A CORE paper/.test(reply2), reply2.split('\n').filter((l) => /CORE/.test(l)).join(' | '));
check('with a key there is no skip note for CORE', !/no credential/i.test(reply2));

// `paper_status` must KEEP reporting the missing credential — that is its job.
const status = await tools.get('paper_status').execute({});
check('paper_status still reports the missing CORE credential',
  /CORE_API_KEY\s+EMPTY/.test(status), status.split('\n').filter((l) => /CORE_API_KEY/.test(l)).join(' | '));

// A source may accept ANY ONE of several credentials: `unpaywall()` takes
// `politeEmail()`, which falls back from UNPAYWALL_EMAIL to OPENALEX_EMAIL.
// Checking only the first name would skip a source that is fully configured.
const mock3 = installFetch((url) => {
  if (url.includes('api.unpaywall.org')) return { body: { title: 'Unpaywall paper', doi: '10.1038/nature14539', is_oa: true } };
  return { body: {} };
});
const withEmail = await loadTools({ cache: false, OPENALEX_EMAIL: 'someone@example.org' });
const reply3 = await withEmail.get('paper_search').execute({ query: '10.1038/nature14539', sources: 'unpaywall' });
mock3.restore();
check('unpaywall runs when only OPENALEX_EMAIL is set', /Unpaywall paper/.test(reply3),
  reply3.split('\n').filter((l) => /npaywall/i.test(l)).join(' | '));

// And when NO credential exists, the call must still answer — not throw. A
// thrown error is indistinguishable from a broken tool.
const mock4 = installFetch(() => ({ body: {} }));
const noEmail = await loadTools({ cache: false });
let threw = null;
let reply4 = '';
try {
  reply4 = await noEmail.get('paper_search').execute({ query: '10.1038/nature14539', sources: 'unpaywall' });
} catch (e) { threw = e; }
mock4.restore();
check('an all-skipped search answers instead of throwing', threw === null, threw ? String(threw.message) : '');
check('the all-skipped reply names the missing credential', /UNPAYWALL_EMAIL/.test(reply4),
  reply4.split('\n').filter((l) => /npaywall/i.test(l)).join(' | '));

done('D11 credential-required source reported as FAILED');
