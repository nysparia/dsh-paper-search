// test/d42-converter-empty-output.mjs — D42 (audit L21): a converter that exits
// 0 and writes nothing reported the reason as "0".
//
// THE DEFECT. `convertToMarkdown` builds its failure reason from the exit code:
//
//   const reason = code === 'timeout' ? `timeout > …`
//     : typeof code === 'number' && code !== 0 ? `exit code ${code}`
//       : String(code);                       // <- code === 0 lands here
//
// The `code === 0 && size > 0` success case returns above, so the only way to
// reach that last branch with a number is **exit 0 with no output** — the one
// case where the exit code says "fine" and the output says "nothing". The user
// was told:
//
//   conversion failed through silent: 0
//
// A bare `0` where the reason belongs. Measured 24 Nov 2026 with a converter
// that exits 0 without touching `-o`: `{ ok: false, message: "0" }`.
//
// WHY IT HAPPENS AT ALL, and why the message must say so: `-o <path>` is used by
// anydoc and by newer markitdown. A converter that does not know `-o` writes its
// output to stdout, which this function sends to a FILE DESCRIPTOR — so it exits
// 0 having written nothing to the path we asked for. That is a real, common
// misconfiguration, and "0" tells the reader nothing about it.
//
// The fix must NAME the case, and must not disturb the other three reasons:
// timeout, a non-zero exit code, and a spawn failure.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { convertToMarkdown } from '../lib/fulltext.js';
import { reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();
const here = dirname(fileURLToPath(import.meta.url));

const root = join(tmpdir(), `dsh-d42-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const pdf = join(root, 'paper.pdf');
writeFileSync(pdf, fakePdf());

/** Write a throwaway converter script and return its path. */
function converterScript(name, body) {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// ── 1. THE DEFECT: exit 0, nothing written ─────────────────────────────────
const silent = converterScript('silent.mjs', 'process.exit(0);');
const out1 = join(root, 'out1.md');
const r1 = await convertToMarkdown(pdf, out1, { name: 'silent', path: silent, from: 'test' });

check('exit 0 with no output is a FAILURE', r1.ok === false, JSON.stringify(r1));
check('the reason is not the bare exit code "0"', r1.message !== '0', JSON.stringify(r1.message));
check('the reason NAMES the empty-output case',
  /no output|wrote nothing|empty/i.test(r1.message),
  r1.message);
check('the reason mentions the likely cause ("-o")',
  /-o/.test(r1.message),
  r1.message);
check('the reason still carries the exit code, so the two facts are both visible',
  /\b0\b/.test(r1.message),
  r1.message);

// ── 2. The other reasons must keep their own, distinct wording ─────────────
//
// A fix that turned every failure into "no output" would be a new defect: the
// exit code is the first thing to look at when a converter fails.
const failing = converterScript('failing.mjs', 'process.exit(3);');
const r2 = await convertToMarkdown(pdf, join(root, 'out2.md'), { name: 'failing', path: failing, from: 'test' });
check('a non-zero exit code is still reported as "exit code N"',
  r2.ok === false && /exit code 3/.test(r2.message),
  r2.message);
check('a non-zero exit code is NOT reported as an empty output',
  !/no output|wrote nothing/i.test(r2.message),
  r2.message);

// A converter that writes SOMETHING and exits non-zero: the exit code wins,
// because the file it left is not trustworthy.
const partial = converterScript('partial.mjs',
  'import { writeFileSync } from "node:fs";\n'
  + 'const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1];\n'
  + 'writeFileSync(o, "# half a conversion\\n"); process.exit(4);');
const r3 = await convertToMarkdown(pdf, join(root, 'out3.md'), { name: 'partial', path: partial, from: 'test' });
check('a non-zero exit code with partial output is still a failure',
  r3.ok === false && /exit code 4/.test(r3.message),
  r3.message);

// A converter that does not exist at all: the spawn failure keeps its wording.
const r4 = await convertToMarkdown(pdf, join(root, 'out4.md'),
  { name: 'ghost', path: join(root, 'does-not-exist'), from: 'test' });
check('a missing converter is reported as a spawn failure',
  r4.ok === false && /spawn-failed/.test(r4.message),
  r4.message);

// A timeout keeps its own wording too. The bound is passed in so the test does
// not wait the real 180 s.
const slow = converterScript('slow.mjs', 'setTimeout(() => process.exit(0), 30000);');
const r5 = await convertToMarkdown(pdf, join(root, 'out5.md'),
  { name: 'slow', path: slow, from: 'test' }, { timeoutMs: 300 });
check('a timeout is still reported as a timeout',
  r5.ok === false && /timeout >/.test(r5.message),
  r5.message);

// ── 3. The success path is untouched ───────────────────────────────────────
const good = converterScript('good.mjs',
  'import { writeFileSync } from "node:fs";\n'
  + 'const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1];\n'
  + 'writeFileSync(o, "# Converted\\n\\nBody.\\n");');
const r6 = await convertToMarkdown(pdf, join(root, 'out6.md'), { name: 'good', path: good, from: 'test' });
check('a converter that writes output still succeeds', r6.ok === true, JSON.stringify(r6));
check('the success result reports the byte count', r6.bytes > 0, String(r6.bytes));

// ── 4. The message reaches the user through `prepareFullText` ──────────────
//
// The audit quotes the USER-VISIBLE string, so the assertion that matters is the
// one on the reply, not on the internal object.
const { prepareFullText } = await import('../lib/fulltext.js');
const { installFetch } = await import('./harness.mjs');
const libRoot = join(root, 'lib');
mkdirSync(join(libRoot, 'md'), { recursive: true });
const mock = installFetch((url) => {
  if (url.includes('example.org/paper.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});
const h = await prepareFullText({
  work: {
    doi: '10.1038/nature14539',
    title: 'A paper',
    publication_year: 2015,
    open_access: { is_oa: true, oa_status: 'green' },
    locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Test' } }],
  },
  identifier: '10.1038/nature14539',
  converter: { name: 'silent', path: silent, from: 'test' },
  root: libRoot,
  findArxiv: async () => null,
});
mock.restore();

check('prepareFullText reports the failure', typeof h.problem === 'string', String(h.problem));
check('the user-visible problem does not end in "silent: 0"',
  !/silent:\s*0\s*$/.test(h.problem ?? ''),
  h.problem ?? '(none)');
check('the user-visible problem names the empty output',
  /no output|wrote nothing/i.test(h.problem ?? ''),
  h.problem ?? '(none)');

rmSync(root, { recursive: true, force: true });
done('D42 converter exit 0 with no output reported as "0"');
