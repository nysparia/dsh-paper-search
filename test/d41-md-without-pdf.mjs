// test/d41-md-without-pdf.mjs — D41 (audit L16): a `.md` with no companion PDF
// was served as a VERIFIED cache hit.
//
// THE DEFECT. `prepareFullText` decides "already converted" by looking for
// `<slug>.md`, and then validates it against `<slug>.pdf` — but only when that
// PDF exists:
//
//   const previous = existsSync(result.pdf)
//     ? checkPdf(result.pdf)
//     : { ok: true, reason: 'no PDF in cache' };   // <- ok: true
//
// So a `.md` with no PDF beside it was returned with `fromCache: true`,
// `used.from = 'local file'`, note `'already converted'`. The report then printed
// both of these, one line apart:
//
//   pdf      : /…/doi-10.1038_nature14539-1a2b3c4d.pdf (not stored)
//   PDF source : local file — already converted
//
// which claims a local PDF that never existed, and serves content nothing has
// checked. Measured 24 Nov 2026: a `.md` written by hand into the library folder
// was returned verbatim as a cache hit.
//
// WHY IT MATTERS MORE THAN A COSMETIC LINE. The `.md` in that state is what an
// interrupted run leaves behind, and what an older plugin version left. Its body
// is unverifiable — there is nothing to check it against — and the agent reads,
// quotes and cites whatever is in it. A wrong answer is worse than a download,
// so the fix takes the MISS.
//
// The fix must NOT be "stop caching": a `.md` WITH a valid PDF is still a hit,
// and that is asserted below so the cheap path is not lost.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const ORPHAN_CONTENT = '# ORPHAN CONTENT — nothing verified this\n';

/** A work whose OA location the mock can serve. */
function workFor(doi) {
  return {
    doi,
    title: 'Human-level control through deep reinforcement learning',
    publication_year: 2015,
    open_access: { is_oa: true, oa_status: 'green' },
    locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Nature' } }],
  };
}

function servePdf() {
  return installFetch((url) => {
    if (url.includes('example.org/paper.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
    if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
    return { status: 404, body: 'not mocked' };
  });
}

// ── 1. The defect, directly through `prepareFullText` ───────────────────────
const root = join(tmpdir(), `dsh-d41-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });

const slug = fileSlug({ doi: DOI });
const mdPath = join(root, 'md', `${slug}.md`);
const pdfPath = join(root, 'md', `${slug}.pdf`);
// A `.md` and NO PDF — the exact state the defect trusted.
writeFileSync(mdPath, ORPHAN_CONTENT);
check('the fixture really has no PDF', !existsSync(pdfPath), pdfPath);

const mock = servePdf();
const h = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root, findArxiv: async () => null });
mock.restore();

check('an orphaned .md is NOT reported as a cache hit', h.fromCache === false,
  `fromCache=${h.fromCache} used=${JSON.stringify(h.used)}`);
check('the orphaned content is not served',
  !readFileSync(h.md, 'utf8').includes('ORPHAN CONTENT'),
  readFileSync(h.md, 'utf8').split('\n')[0] || '(no file)');
check('the paper really was downloaded and converted',
  h.problem === null && existsSync(pdfPath) && readFileSync(h.md, 'utf8').length > 0,
  h.problem ?? `${readFileSync(h.md, 'utf8').length} chars`);
check('the reply explains that the cache was dropped',
  /cache dropped/i.test(h.cacheNote ?? ''),
  h.cacheNote ?? '(no cacheNote)');
check('the note names the real reason — no companion PDF, so unverifiable',
  /no companion PDF|unverif/i.test(h.cacheNote ?? ''),
  h.cacheNote ?? '(no cacheNote)');
check('the note does NOT claim the PDF was "not valid" (it was absent)',
  !/not valid/i.test(h.cacheNote ?? ''),
  h.cacheNote ?? '(no cacheNote)');

// ── 2. The cheap path must survive: a .md WITH a valid PDF is still a hit ───
const root2 = join(tmpdir(), `dsh-d41-hit-${process.pid}`);
rmSync(root2, { recursive: true, force: true });
mkdirSync(join(root2, 'md'), { recursive: true });
const slug2 = fileSlug({ doi: DOI });
writeFileSync(join(root2, 'md', `${slug2}.md`), '# VERIFIED CONTENT\n');
writeFileSync(join(root2, 'md', `${slug2}.pdf`), fakePdf());

const mock2 = servePdf();
const hit = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root: root2, findArxiv: async () => null });
mock2.restore();
check('a .md WITH a valid PDF is still served from the cache',
  hit.fromCache === true && hit.used?.note === 'already converted',
  `fromCache=${hit.fromCache} used=${JSON.stringify(hit.used)}`);
check('the verified content is what comes back',
  readFileSync(hit.md, 'utf8').includes('VERIFIED CONTENT'));
check('a real cache hit sets no cacheNote', !hit.cacheNote, hit.cacheNote ?? '(none)');

// ── 3. A DAMAGED PDF keeps its own, different wording ──────────────────────
//
// The two reasons are different facts. A missing PDF is "unverifiable"; a PDF
// that is present but is not a PDF is "not valid". Collapsing them into one
// message would be a third wrong statement about the same folder.
const root3 = join(tmpdir(), `dsh-d41-bad-${process.pid}`);
rmSync(root3, { recursive: true, force: true });
mkdirSync(join(root3, 'md'), { recursive: true });
const slug3 = fileSlug({ doi: DOI });
writeFileSync(join(root3, 'md', `${slug3}.md`), '# STALE\n');
writeFileSync(join(root3, 'md', `${slug3}.pdf`), '<!doctype html><html>404</html>');

const mock3 = servePdf();
const bad = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root: root3, findArxiv: async () => null });
mock3.restore();
check('a damaged PDF is still dropped and re-downloaded', bad.fromCache === false,
  `fromCache=${bad.fromCache}`);
check('a damaged PDF still says "not valid"', /not valid/i.test(bad.cacheNote ?? ''),
  bad.cacheNote ?? '(no cacheNote)');

// ── 4. Through the registered tool: the report must not claim a local PDF ──
//
// This is the line the audit quotes. `pdf : … (not stored)` and
// `PDF source : local file — already converted` must never appear together.
const root4 = join(tmpdir(), `dsh-d41-tool-${process.pid}`);
rmSync(root4, { recursive: true, force: true });
mkdirSync(join(root4, 'md'), { recursive: true });
writeFileSync(join(root4, 'md', `${fileSlug({ doi: DOI })}.md`), ORPHAN_CONTENT);

const mock4 = installFetch((url) => {
  if (url.includes('api.openalex.org/works/doi:')) {
    return {
      body: {
        id: 'https://openalex.org/W1000',
        doi: `https://doi.org/${DOI}`,
        title: 'Human-level control through deep reinforcement learning',
        publication_year: 2015,
        cited_by_count: 9000,
        open_access: { is_oa: true, oa_status: 'green' },
        locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Nature' } }],
      },
    };
  }
  if (url.includes('example.org/paper.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});
const tools = loadTools({ cache: false, libraryRoot: root4, anydocPath: converterPath });
const reply = await tools.get('paper_fulltext').execute({ identifier: DOI });
mock4.restore();

check('the tool does not return the orphaned content', !reply.includes('ORPHAN CONTENT'),
  reply.split('\n').filter((l) => l.includes('ORPHAN')).join(' | ') || 'clean');
check('the tool does not claim the file ALREADY EXISTED', !/ALREADY EXISTED/i.test(reply),
  reply.split('\n').filter((l) => /ALREADY EXISTED/i.test(l)).join(' | ') || 'clean');
check('the tool does not claim "local file — already converted"', !/local file/i.test(reply),
  reply.split('\n').filter((l) => /local file/i.test(l)).join(' | ') || 'clean');
check('the tool reports a real PDF source', /PDF source\s*:\s*openalex/i.test(reply),
  reply.split('\n').filter((l) => /PDF source/.test(l)).join(' | '));
check('the tool says why the earlier conversion was dropped', /cache dropped/i.test(reply),
  reply.split('\n').filter((l) => /cache/i.test(l)).join(' | ') || 'no line mentions the cache');
check('the tool returns a converted body', /Converted paper/.test(reply),
  reply.split('\n').slice(-3).join(' | '));

rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
rmSync(root3, { recursive: true, force: true });
rmSync(root4, { recursive: true, force: true });
done('D41 .md without a companion PDF served as a verified hit');
