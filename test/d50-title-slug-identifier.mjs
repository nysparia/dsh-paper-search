// test/d50-title-slug-identifier.mjs — D50 (audit H2): two different papers with
// the same title and year shared one slug, and the second was answered with the
// first one's body.
//
// THE DEFECT. `fileSlug` hashed `title + year` only, and read `identifier` ONLY
// when the title was empty:
//
//   const rawTitle = String(work?.title ?? identifier ?? '');
//   return `${readable || 'paper'}-${year}-${shortHash(`${normalizedTitle}\u0000${year}`)}`;
//
// So for any work that HAS a title the identifier was discarded. Measured
// 24 Nov 2026: two works titled "Editorial", year 2020, no DOI, different OA
// URLs both produced `editorial-2020-34e6e11a`, and asking for B returned
//
//   B fromCache: true
//   B used: {"from":"local file","note":"already converted"}
//   B md CONTENT SERVED: "# PAPER A — the first paper\n"
//
// This is the exact defect the hash was added to remove, surviving on the title
// path. The agent read, quoted and cited the wrong paper.
//
// THE FIX. The identifier is folded into the title-path hash, normalized the
// same way the DOI path normalizes it — so the same paper written several ways
// still lands on ONE file, and a title-only call with no identifier at all is
// still stable across calls.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fileSlug, prepareFullText } from '../lib/fulltext.js';
import { installFetch, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

// ── 1. The slug function, directly ─────────────────────────────────────────
const A = { title: 'Editorial', publication_year: 2020 };
const slugA = fileSlug(A, '10.1000/a');
const slugB = fileSlug(A, '10.1000/b');
check('two works with the same title+year but different identifiers get DIFFERENT slugs',
  slugA !== slugB, `${slugA} vs ${slugB}`);
check('the readable part is still there (a human can tell which file is which)',
  slugA.startsWith('editorial-2020') && slugB.startsWith('editorial-2020'),
  `${slugA} | ${slugB}`);

// The same paper written several ways must stay ONE file — the constraint the
// DOI path already honours.
const spellings = [
  fileSlug(A, '10.1000/a'),
  fileSlug(A, 'https://doi.org/10.1000/a'),
  fileSlug(A, 'doi:10.1000/a'),
  fileSlug(A, 'DOI: 10.1000/A'),
];
check('the same identifier in four spellings still maps to ONE file',
  new Set(spellings).size === 1, spellings.join(' | '));

// A title-only call has no identifier to fold in, and must not drift between
// calls (the identifier contributes the empty string).
check('a title-only call is stable across calls',
  fileSlug(A) === fileSlug(A), fileSlug(A));
check('a title-only call still differs from a call that names an identifier',
  fileSlug(A) !== fileSlug(A, '10.1000/a'), `${fileSlug(A)} vs ${fileSlug(A, '10.1000/a')}`);

// ── 2. End to end: paper B must not be answered with paper A's body ────────
const PAPER_A_CONTENT = '# PAPER A — the first paper\n';
const root = join(tmpdir(), `dsh-d50-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });

const converterA = join(root, 'converter-a.mjs');
writeFileSync(converterA, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n'
  + `const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1];\nwriteFileSync(o, ${JSON.stringify(PAPER_A_CONTENT)});\n`);
chmodSync(converterA, 0o755);

const workA = {
  title: 'Editorial',
  publication_year: 2020,
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: 'https://example.org/a.pdf', source: { display_name: 'Journal A' } }],
};
const workB = {
  title: 'Editorial',
  publication_year: 2020,
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: 'https://example.org/b.pdf', source: { display_name: 'Journal B' } }],
};

const mock = installFetch((url) => {
  if (url.includes('example.org/a.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('example.org/b.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});

const firstA = await prepareFullText({
  work: workA, identifier: '10.1000/a', converter: { name: 'a', path: converterA, from: 'test' }, root, findArxiv: async () => null,
});
check('paper A was really converted first', firstA.problem === null && existsSync(firstA.md),
  firstA.problem ?? firstA.md);

// A DIFFERENT converter for B, so "B got A's body" cannot be an artefact of the
// fixture writing the same text twice.
const converterB = join(root, 'converter-b.mjs');
writeFileSync(converterB, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n'
  + 'const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1];\nwriteFileSync(o, "# PAPER B — the second paper\\n");\n');
chmodSync(converterB, 0o755);

const hB = await prepareFullText({
  work: workB, identifier: '10.1000/b', converter: { name: 'b', path: converterB, from: 'test' }, root, findArxiv: async () => null,
});
mock.restore();

check('paper B is NOT served from the cache', hB.fromCache === false,
  `fromCache=${hB.fromCache} used=${JSON.stringify(hB.used)}`);
check('paper B does not get paper A\'s file', hB.md !== firstA.md, `${hB.md} vs ${firstA.md}`);
check('paper B\'s Markdown does not contain paper A\'s content',
  !readFileSync(hB.md, 'utf8').includes('PAPER A'), readFileSync(hB.md, 'utf8').split('\n')[0] || '(no file)');
check('paper B\'s Markdown is its own body',
  readFileSync(hB.md, 'utf8').includes('PAPER B'), readFileSync(hB.md, 'utf8').split('\n')[0] || '(no file)');
check('paper B really was downloaded and converted', hB.problem === null && hB.used?.from === 'openalex',
  hB.problem ?? JSON.stringify(hB.used));

// And the cache still works for A — the fix must not be "disable the cache".
const hA = await prepareFullText({
  work: workA, identifier: '10.1000/a', converter: { name: 'a', path: converterA, from: 'test' }, root, findArxiv: async () => null,
});
check('paper A is still served from its own cache',
  hA.fromCache === true && readFileSync(hA.md, 'utf8').includes('PAPER A'),
  `fromCache=${hA.fromCache}`);

rmSync(root, { recursive: true, force: true });
done('D50 title+year slug collision across identifiers');
