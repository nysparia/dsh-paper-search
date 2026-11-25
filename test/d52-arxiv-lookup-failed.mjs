// test/d52-arxiv-lookup-failed.mjs — D52 (audit H4): a FAILED arXiv lookup was
// reported as "no open-access copy found for this work".
//
// THE DEFECT. `prepareFullText` recorded the failure in `result.arxivNote` and
// then returned the same `problem` string it returns for a genuine absence:
//
//   catch (e) { result.arxivNote = `arXiv search failed: ${e?.message ?? e}`; }
//   …
//   if (candidates.length === 0) { result.problem = 'no open-access copy found for this work'; }
//
// and `lib/index.js` printed `h.arxivNote` only on the SUCCESS path. Measured
// 24 Nov 2026 with `findArxiv` throwing `ENOTFOUND`:
//
//   --- user-visible reply ---
//   FAILED: no open-access copy found for this work
//   reply mentions the arXiv failure: false
//
// "There is no open-access copy" is a definite negative about the world. The
// truth was "the arXiv lookup failed and the OpenAlex reply named no location" —
// "we could not check", which is a different statement and must read differently.
//
// THE FIX. When `arxivNote` is set and no candidate was found, the problem says
// the lookup FAILED and names the error; `lib/index.js` also prints the note on
// the failure path. A genuine absence keeps its old wording.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { prepareFullText } from '../lib/fulltext.js';
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();
const here = dirname(fileURLToPath(import.meta.url));
const converterPath = join(here, '_fake-converter.mjs');
const converter = { name: 'fake', path: converterPath, from: 'test' };

const DOI = '10.1038/nature14539';
const work = { doi: DOI, title: 'A paper with no listed OA location', publication_year: 2015 };

const root = join(tmpdir(), `dsh-d52-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });

// ── 1. The lookup FAILED ───────────────────────────────────────────────────
const mock = installFetch(() => ({ status: 404, body: 'not mocked' }));
const failed = await prepareFullText({
  work, identifier: DOI, converter, root,
  findArxiv: async () => { const e = new Error('getaddrinfo ENOTFOUND export.arxiv.org'); e.code = 'ENOTFOUND'; throw e; },
});
mock.restore();

check('the failure is reported', typeof failed.problem === 'string', String(failed.problem));
check('the problem says the arXiv lookup FAILED',
  /arXiv lookup failed|arXiv search failed/i.test(failed.problem ?? ''),
  failed.problem ?? '(none)');
check('the problem names the actual error',
  /ENOTFOUND/.test(failed.problem ?? ''), failed.problem ?? '(none)');
check('the problem does NOT read as a plain "no open-access copy"',
  !/^no open-access copy found for this work$/.test(failed.problem ?? ''),
  failed.problem ?? '(none)');
check('the problem says this is "could not check", not "there is nothing"',
  /could not check/i.test(failed.problem ?? ''), failed.problem ?? '(none)');

// ── 2. A genuine absence keeps its own, different wording ──────────────────
const mock2 = installFetch(() => ({ status: 404, body: 'not mocked' }));
const absent = await prepareFullText({ work, identifier: DOI, converter, root, findArxiv: async () => null });
mock2.restore();

check('a genuine absence still says "no open-access copy found for this work"',
  absent.problem === 'no open-access copy found for this work', absent.problem ?? '(none)');
check('a genuine absence does not mention a failure',
  !/failed/i.test(absent.problem ?? ''), absent.problem ?? '(none)');
check('a genuine absence sets no arxivNote', !absent.arxivNote, absent.arxivNote ?? '(none)');

// ── 3. Through the registered tool: the reply must mention the failure ─────
const root2 = join(tmpdir(), `dsh-d52-tool-${process.pid}`);
rmSync(root2, { recursive: true, force: true });
mkdirSync(join(root2, 'md'), { recursive: true });

const mock3 = installFetch((url) => {
  if (url.includes('api.openalex.org/works/doi:')) {
    return {
      body: {
        id: 'https://openalex.org/W2000',
        doi: `https://doi.org/${DOI}`,
        title: 'A paper with no listed OA location',
        publication_year: 2015,
        cited_by_count: 1,
        open_access: { is_oa: false, oa_status: 'closed' },
        locations: [],
      },
    };
  }
  // The arXiv search fails at the network level.
  if (url.includes('export.arxiv.org')) throw new Error('getaddrinfo ENOTFOUND export.arxiv.org');
  return { status: 404, body: 'not mocked' };
});
const tools = loadTools({ cache: false, libraryRoot: root2, anydocPath: converterPath });
const reply = await tools.get('paper_fulltext').execute({ identifier: DOI });
mock3.restore();

check('the tool reply mentions the arXiv failure', /arXiv/i.test(reply) && /ENOTFOUND|failed/i.test(reply),
  reply.split('\n').filter((l) => /arXiv|FAILED/i.test(l)).join(' | ') || 'no line mentions it');
check('the tool reply does not present the absence as a fact about the paper',
  !/^FAILED: no open-access copy found for this work$/m.test(reply),
  reply.split('\n').filter((l) => /FAILED/.test(l)).join(' | ') || 'no FAILED line');

rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
done('D52 failed arXiv lookup reported as "no open-access copy"');
