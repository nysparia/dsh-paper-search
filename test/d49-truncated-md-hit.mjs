// test/d49-truncated-md-hit.mjs — D49 (audit H1): a truncated or whitespace-only
// `.md` was served as a VERIFIED cache hit.
//
// THE DEFECT. The cache-hit test was `statSync(md).size > 0`. The Markdown itself
// was never inspected, so any non-empty file passed. Measured 24 Nov 2026: a
// 29-byte file holding `"# Human-level control\n\nWe pre"` — cut mid-word —
// beside a valid PDF came back as
//
//   fromCache: true
//   used: {"from":"local file","note":"already converted"}
//   fetches made: 0
//
// and `lib/index.js` then sent that body to the model as the paper's full
// content. The agent read, quoted and cited one page of a forty-page paper.
//
// It was reachable without hand-editing: `convertToMarkdown` accepted ANY
// non-empty output, so a converter that exits 0 after page 1 cached a partial
// body and the next call served it as "already converted".
//
// THE FIX. A hit now requires the completion marker written after a successful
// conversion (`<slug>.md.json`: the `.md`'s byte count + sha256, and the PDF's
// size + mtime). A `.md` with no marker — the state an older plugin version
// leaves behind — is a MISS with a stated reason. `convertToMarkdown` also
// refuses whitespace-only output.
//
// The cheap path must survive: a `.md` this plugin really converted is still a
// hit, and that is asserted below so the fix cannot be "stop caching".
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { convertToMarkdown, fileSlug, prepareFullText } from '../lib/fulltext.js';
import { installFetch, loadTools, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();
const here = dirname(fileURLToPath(import.meta.url));
const converterPath = join(here, '_fake-converter.mjs');
const converter = { name: 'fake', path: converterPath, from: 'test' };

const DOI = '10.1038/nature14539';
const TRUNCATED = '# Human-level control\n\nWe pre';

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

/** A fresh library folder with one hand-written `.md` and a valid PDF beside it. */
function fixture(label, mdContent) {
  const root = join(tmpdir(), `dsh-d49-${label}-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'md'), { recursive: true });
  const slug = fileSlug({ doi: DOI });
  writeFileSync(join(root, 'md', `${slug}.md`), mdContent);
  writeFileSync(join(root, 'md', `${slug}.pdf`), fakePdf());
  return { root, md: join(root, 'md', `${slug}.md`), pdf: join(root, 'md', `${slug}.pdf`) };
}

// ── 1. THE DEFECT: a truncated `.md` beside a valid PDF ────────────────────
{
  const f = fixture('truncated', TRUNCATED);
  check('the fixture really is the 29-byte truncated file from the audit',
    statSync(f.md).size === 29, `${statSync(f.md).size} bytes`);

  const mock = servePdf();
  const h = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root: f.root, findArxiv: async () => null });
  mock.restore();

  check('a truncated .md is NOT reported as a cache hit', h.fromCache === false,
    `fromCache=${h.fromCache} used=${JSON.stringify(h.used)}`);
  check('the truncated body is not served',
    !readFileSync(h.md, 'utf8').includes('We pre'),
    readFileSync(h.md, 'utf8').split('\n')[0] || '(no file)');
  check('the reply explains why the cache was dropped', /cache dropped/i.test(h.cacheNote ?? ''),
    h.cacheNote ?? '(no cacheNote)');
  check('the note names the real reason — no completion marker, so unverifiable',
    /completion marker|older plugin version/i.test(h.cacheNote ?? ''),
    h.cacheNote ?? '(no cacheNote)');
  check('the paper really was downloaded and converted',
    h.problem === null && existsSync(f.pdf) && readFileSync(h.md, 'utf8').length > 0,
    h.problem ?? `${readFileSync(h.md, 'utf8').length} chars`);
  rmSync(f.root, { recursive: true, force: true });
}

// ── 2. A one-byte and a whitespace-only `.md` are the same case ────────────
for (const [label, content] of [['one-byte', '\n'], ['whitespace', '   \n\n']]) {
  const f = fixture(label, content);
  const mock = servePdf();
  const h = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root: f.root, findArxiv: async () => null });
  mock.restore();
  check(`a ${label} .md is NOT reported as a cache hit`, h.fromCache === false,
    `fromCache=${h.fromCache} used=${JSON.stringify(h.used)}`);
  rmSync(f.root, { recursive: true, force: true });
}

// ── 3. A marker that does not match the file on disk is a MISS ─────────────
//
// The marker is what makes the hit honest, so it must be checked, not merely
// present: a `.md` truncated AFTER a successful conversion, and a `.md` edited
// in place (same size, different bytes), are both unverifiable.
{
  const root = join(tmpdir(), `dsh-d49-marker-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'md'), { recursive: true });
  const mock = servePdf();
  const first = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root, findArxiv: async () => null });
  mock.restore();
  check('a real conversion writes the completion marker',
    first.problem === null && existsSync(`${first.md}.json`), `${first.md}.json`);

  // Truncate it: the recorded byte count no longer matches.
  writeFileSync(first.md, readFileSync(first.md, 'utf8').slice(0, 10));
  const mock2 = servePdf();
  const truncated = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root, findArxiv: async () => null });
  mock2.restore();
  check('a .md truncated AFTER conversion is not a hit', truncated.fromCache === false,
    `fromCache=${truncated.fromCache}`);
  check('the note says the size no longer matches the completed conversion',
    /truncated|bytes but the completed conversion/i.test(truncated.cacheNote ?? ''),
    truncated.cacheNote ?? '(no cacheNote)');

  // Edit it in place, keeping the byte count: only the hash can catch this.
  const body = readFileSync(truncated.md, 'utf8');
  writeFileSync(truncated.md, body.replace(/Converted/, 'Tampered!'));
  check('the tampered file kept its byte count (so only the hash can catch it)',
    statSync(truncated.md).size === Buffer.byteLength(body), `${statSync(truncated.md).size} bytes`);
  const mock3 = servePdf();
  const edited = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root, findArxiv: async () => null });
  mock3.restore();
  check('a .md edited after conversion is not a hit', edited.fromCache === false,
    `fromCache=${edited.fromCache}`);
  check('the note says the hash no longer matches',
    /hash/i.test(edited.cacheNote ?? ''), edited.cacheNote ?? '(no cacheNote)');
  rmSync(root, { recursive: true, force: true });
}

// ── 4. The cheap path survives: a real conversion is still a hit ───────────
{
  const root = join(tmpdir(), `dsh-d49-hit-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'md'), { recursive: true });
  const mock = servePdf();
  const first = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root, findArxiv: async () => null });
  const second = await prepareFullText({ work: workFor(DOI), identifier: DOI, converter, root, findArxiv: async () => null });
  mock.restore();
  check('a .md this plugin converted is still served from the cache',
    first.fromCache === false && second.fromCache === true && second.used?.note === 'already converted',
    `first=${first.fromCache} second=${second.fromCache} used=${JSON.stringify(second.used)}`);
  check('a real cache hit sets no cacheNote', !second.cacheNote, second.cacheNote ?? '(none)');
  rmSync(root, { recursive: true, force: true });
}

// ── 5. The converter itself must not accept whitespace as a conversion ─────
{
  const root = join(tmpdir(), `dsh-d49-conv-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const pdf = join(root, 'paper.pdf');
  writeFileSync(pdf, fakePdf());
  const blank = join(root, 'blank.mjs');
  writeFileSync(blank, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n'
    + 'const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1];\n'
    + 'writeFileSync(o, "   \\n\\n");\n');
  chmodSync(blank, 0o755);
  const r = await convertToMarkdown(pdf, join(root, 'out.md'), { name: 'blank', path: blank, from: 'test' });
  check('a converter that writes only whitespace is a FAILURE', r.ok === false, JSON.stringify(r));
  check('the reason names the whitespace-only output',
    /whitespace/i.test(r.message), r.message);
  check('no .md is left behind for the next call to trust',
    !existsSync(join(root, 'out.md')), join(root, 'out.md'));
  rmSync(root, { recursive: true, force: true });
}

// ── 6. Through the registered tool: the reply must not claim a conversion ──
{
  const root = join(tmpdir(), `dsh-d49-tool-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'md'), { recursive: true });
  writeFileSync(join(root, 'md', `${fileSlug({ doi: DOI })}.md`), TRUNCATED);

  const mock = installFetch((url) => {
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
  const tools = loadTools({ cache: false, libraryRoot: root, anydocPath: converterPath });
  const reply = await tools.get('paper_fulltext').execute({ identifier: DOI });
  mock.restore();

  check('the tool does not serve the truncated body', !reply.includes('We pre'),
    reply.split('\n').filter((l) => l.includes('We pre')).join(' | ') || 'clean');
  check('the tool does not claim the file ALREADY EXISTED', !/ALREADY EXISTED/i.test(reply),
    reply.split('\n').filter((l) => /ALREADY EXISTED/i.test(l)).join(' | ') || 'clean');
  check('the tool says why the earlier conversion was dropped', /cache dropped/i.test(reply),
    reply.split('\n').filter((l) => /cache/i.test(l)).join(' | ') || 'no line mentions the cache');
  rmSync(root, { recursive: true, force: true });
}

done('D49 truncated .md served as a verified cache hit');
