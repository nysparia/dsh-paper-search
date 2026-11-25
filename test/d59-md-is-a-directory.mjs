// test/d59-md-is-a-directory.mjs — D59 (audit M7): a `<slug>.md` that is a
// DIRECTORY made the tool throw `EISDIR`.
//
// THE DEFECT. `convertToMarkdown` calls `openSync(md, 'w')`, which throws
// `EISDIR` when the name is a directory, and `prepareFullText` had no `try`
// around the conversion. Measured 24 Nov 2026 through the registered tool:
//
//   tool result: "THREW EISDIR: EISDIR: illegal operation on a directory,
//                 open '…/lib/md/doi-10.1038_nature14539-2fbc9ecc.md'"
//
// The doc comment says `prepareFullText` "NEVER throws for a foreseeable
// failure". A directory in the library folder is foreseeable — the cache-hit
// branch already `statSync`es it and gets `size: 0`, so it falls through to the
// download and then throws.
//
// THE FIX. A non-regular-file `.md` is a cache MISS with a stated reason, and the
// conversion is wrapped so a failure comes back as `{ problem }`.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { fileSlug, prepareFullText } from '../lib/fulltext.js';
import { installFetch, loadTools, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();
const here = dirname(fileURLToPath(import.meta.url));
const converterPath = join(here, '_fake-converter.mjs');
const converter = { name: 'fake', path: converterPath, from: 'test' };

const DOI = '10.1038/nature14539';
const work = {
  doi: DOI,
  title: 'A paper',
  publication_year: 2015,
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Test' } }],
};

function servePdf() {
  return installFetch((url) => {
    if (url.includes('example.org/paper.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
    if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
    return { status: 404, body: 'not mocked' };
  });
}

// ── 1. `prepareFullText` must REPORT, not throw ────────────────────────────
const root = join(tmpdir(), `dsh-d59-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });
const mdPath = join(root, 'md', `${fileSlug({ doi: DOI })}.md`);
mkdirSync(mdPath, { recursive: true });

const mock = servePdf();
let threw = null;
let h = null;
try {
  h = await prepareFullText({ work, identifier: DOI, converter, root, findArxiv: async () => null });
} catch (e) {
  threw = e;
}
mock.restore();

check('prepareFullText does NOT throw when <slug>.md is a directory', threw === null,
  threw ? `THREW ${threw.message}` : 'returned normally');
check('it returns a problem instead', typeof h?.problem === 'string', h?.problem ?? '(none)');
check('the problem names the path that is in the way', (h?.problem ?? '').includes(mdPath),
  h?.problem ?? '(none)');
check('the problem says what is wrong with it (not a regular file / cannot write)',
  /not a regular file|cannot write|EISDIR|directory/i.test(h?.problem ?? ''), h?.problem ?? '(none)');
check('the directory is still there (nothing was deleted)', existsSync(mdPath), mdPath);

// ── 2. Through the registered tool: a FAILED reply, not a thrown error ─────
const root2 = join(tmpdir(), `dsh-d59-tool-${process.pid}`);
rmSync(root2, { recursive: true, force: true });
mkdirSync(join(root2, 'md'), { recursive: true });
mkdirSync(join(root2, 'md', `${fileSlug({ doi: DOI })}.md`), { recursive: true });

const mock2 = installFetch((url) => {
  if (url.includes('api.openalex.org/works/doi:')) {
    return {
      body: {
        id: 'https://openalex.org/W3000',
        doi: `https://doi.org/${DOI}`,
        title: 'A paper',
        publication_year: 2015,
        cited_by_count: 1,
        open_access: { is_oa: true, oa_status: 'green' },
        locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Test' } }],
      },
    };
  }
  if (url.includes('example.org/paper.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});
const tools = loadTools({ cache: false, libraryRoot: root2, anydocPath: converterPath });
let reply = null;
let toolThrew = null;
try {
  reply = await tools.get('paper_fulltext').execute({ identifier: DOI });
} catch (e) {
  toolThrew = e;
}
mock2.restore();

check('the tool does NOT throw EISDIR', toolThrew === null,
  toolThrew ? `THREW ${toolThrew.message}` : 'returned a reply');
check('the tool returns a FAILED reply', /FAILED/.test(reply ?? ''),
  (reply ?? '').split('\n').filter((l) => /FAILED/.test(l)).join(' | ') || 'no FAILED line');
check('the reply does not contain a raw EISDIR stack line',
  !/THREW EISDIR/.test(reply ?? ''), (reply ?? '').split('\n')[0] || '(empty)');

rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
done('D59 <slug>.md as a directory threw EISDIR');
