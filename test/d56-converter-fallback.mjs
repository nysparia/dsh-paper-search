// test/d56-converter-fallback.mjs — D68 (audit M4): `findConverter` checked that
// a path EXISTS, not that it runs, and there was no fallback.
//
// THE DEFECT. `for (const c of list) if (existsSync(c.path)) return c;` — that
// answers a different question. Measured 24 Nov 2026:
//
//   config points at a directory:          {"name":"anydoc","path":"…/work-p7"}
//   config points at a NON-executable file: {"name":"anydoc","path":"…/not-executable"}
//   config points at a binary that exits 127: {"name":"anydoc","path":"…/broken-anydoc"}
//
// and with a broken `anydoc` plus a working `markitdown`:
//
//   conversion result with the broken anydoc: {"ok":false,"message":"exit code 127"}
//   was markitdown ever tried?: "no — convertToMarkdown takes ONE converter"
//
// The user saw `converter : anydoc (plugin config)` and then
// `conversion failed through anydoc: exit code 127` on a machine that had a
// working converter. The header comment calls markitdown "the fallback"; it was
// only lower in a list.
//
// THE FIX. A candidate must be a regular file the OS will execute, and
// `prepareFullText` walks the list — falling through when a converter cannot
// spawn or exits 126/127, and NOT when it ran and rejected the PDF (that reason
// is the real one and must not be hidden).
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { findConverter, findConverters, prepareFullText } from '../lib/fulltext.js';
import { installFetch, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();
const here = dirname(fileURLToPath(import.meta.url));

const root = join(tmpdir(), `dsh-d68-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function script(name, body) {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const working = script('working.mjs',
  'import { writeFileSync } from "node:fs";\n'
  + 'const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1];\n'
  + 'writeFileSync(o, "# Converted by the working converter\\n");');
const broken = script('broken.mjs', 'process.exit(127);');
const rejects = script('rejects.mjs', 'process.exit(3);');
const notExecutable = join(root, 'not-executable');
writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
chmodSync(notExecutable, 0o644);
const aDirectory = join(root, 'a-directory');
mkdirSync(aDirectory, { recursive: true });

// ── 1. `findConverter` must not return something that cannot run ───────────
check('a DIRECTORY is not returned as the converter',
  findConverter({ anydocPath: aDirectory })?.path !== aDirectory,
  JSON.stringify(findConverter({ anydocPath: aDirectory })));
check('a NON-EXECUTABLE file is not returned as the converter',
  findConverter({ anydocPath: notExecutable })?.path !== notExecutable,
  JSON.stringify(findConverter({ anydocPath: notExecutable })));
check('a runnable file IS returned as the converter',
  findConverter({ anydocPath: working })?.path === working,
  JSON.stringify(findConverter({ anydocPath: working })));

// ── 2. `findConverters` returns the runnable ones, in preference order ─────
//
// The list may also contain a REAL anydoc/markitdown installed on this machine
// (found through PATH), so the assertion is about what must NOT be in it and
// what must be — not about its exact length.
{
  const list = findConverters({ anydocPath: aDirectory, markitdownPath: notExecutable });
  check('the list contains neither the directory nor the non-executable file',
    list.every((c) => c.path !== aDirectory && c.path !== notExecutable),
    JSON.stringify(list));
  const withWorking = findConverters({ anydocPath: aDirectory, markitdownPath: working });
  check('the list keeps the working converter',
    withWorking.some((c) => c.path === working), JSON.stringify(withWorking));
  check('the working markitdown comes after any anydoc (preference order)',
    withWorking.findIndex((c) => c.path === working) >= withWorking.filter((c) => c.name === 'anydoc').length - 1,
    JSON.stringify(withWorking.map((c) => c.name)));
}

// ── 3. The conversion path falls through to the next converter ─────────────
/** A fresh library folder — each section needs its own, or the previous one is a cache hit. */
function freshRoot(name) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'md'), { recursive: true });
  return dir;
}
const work = {
  doi: '10.1038/nature14539',
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

{
  const libRoot = freshRoot('fallthrough');
  const mock = servePdf();
  const h = await prepareFullText({
    work, identifier: work.doi, root: libRoot, findArxiv: async () => null,
    converters: [
      { name: 'anydoc', path: broken, from: 'test' },
      { name: 'markitdown', path: working, from: 'test' },
    ],
  });
  mock.restore();
  check('a broken anydoc does not cost the whole call', h.problem === null, h.problem ?? '(none)');
  check('the working converter is the one that ran',
    h.converter?.name === 'markitdown', JSON.stringify(h.converter));
  check('the body really came from the working converter',
    /Converted by the working converter/.test(readFileSync(h.md, 'utf8')),
    readFileSync(h.md, 'utf8').split('\n')[0] || '(no file)');
}

// ── 4. With only a broken converter, the reason is still named ─────────────
{
  const libRoot = freshRoot('only-broken');
  const mock = servePdf();
  const h = await prepareFullText({
    work, identifier: work.doi, root: libRoot, findArxiv: async () => null,
    converters: [{ name: 'anydoc', path: broken, from: 'test' }],
  });
  mock.restore();
  check('a single broken converter is still reported', typeof h.problem === 'string', h.problem ?? '(none)');
  check('the problem names the exit code', /exit code 127/.test(h.problem ?? ''), h.problem ?? '(none)');
}

// ── 5. A converter that RAN and rejected the PDF is not replaced ───────────
//
// Falling through here would hide the real reason behind a second converter's
// unrelated failure.
{
  const libRoot = freshRoot('rejects');
  const mock = servePdf();
  const h = await prepareFullText({
    work, identifier: work.doi, root: libRoot, findArxiv: async () => null,
    converters: [
      { name: 'anydoc', path: rejects, from: 'test' },
      { name: 'markitdown', path: working, from: 'test' },
    ],
  });
  mock.restore();
  check('a converter that ran and failed keeps its own reason',
    /exit code 3/.test(h.problem ?? ''), h.problem ?? '(none)');
  check('the second converter was NOT tried after a real conversion failure',
    !/markitdown/.test(h.problem ?? ''), h.problem ?? '(none)');
}

rmSync(root, { recursive: true, force: true });
done('D56 findConverter existence-only check and missing fallback');
