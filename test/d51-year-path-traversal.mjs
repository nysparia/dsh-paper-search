// test/d51-year-path-traversal.mjs — D51 (audit H3): `publication_year` was
// interpolated raw into the file name, so a third-party reply chose where this
// plugin wrote.
//
// THE DEFECT. `fileSlug` sanitized the title and the DOI and then did
//
//   const year = work?.publication_year ?? 'x';
//   return `${readable || 'paper'}-${year}-${shortHash(...)}`;
//
// `publication_year` comes from the OpenAlex reply and was never sanitized.
// Measured 24 Nov 2026 with `publication_year: "../../../../../../tmp/x/OUTSIDE"`:
//
//   slug  = "a-paper-../../../../../../tmp/x/OUTSIDE-64fbc864"
//   pdf   = /tmp/…/OUTSIDE-64fbc864.pdf
//   md    = /tmp/…/OUTSIDE-64fbc864.md
//   inside md/ ? false
//   problem: null
//
// Both files were written OUTSIDE `<root>/md/` and the call reported success.
// The same input also produced a NUL byte in the name, and a 300-character year
// produced a 315-byte name — `ENAMETOOLONG` from `openSync` instead of a named
// problem.
//
// THE FIX. A year can legitimately be four digits; anything else becomes the
// existing `x` fallback. `prepareFullText` additionally refuses to write when the
// resolved `.md`/`.pdf` is not inside the library folder — a naming bug must not
// be the only thing standing between a reply and the rest of the disk.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { fileSlug, prepareFullText } from '../lib/fulltext.js';
import { installFetch, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

// ── 1. The slug function, directly ─────────────────────────────────────────
const HOSTILE = [
  '../../../../../../tmp/x/OUTSIDE',
  '../../evil',
  'a/b',
  '2020/../..',
  '\u0000',
  'x'.repeat(300),
];
for (const year of HOSTILE) {
  const slug = fileSlug({ title: 'A paper', publication_year: year });
  const label = JSON.stringify(year).slice(0, 40);
  check(`year ${label} produces a name with no separator`, !slug.includes('/') && !slug.includes('\\'), slug);
  check(`year ${label} produces a name with no NUL`, !slug.includes('\u0000'), JSON.stringify(slug));
  check(`year ${label} produces a name under 255 bytes`, Buffer.byteLength(slug) <= 255, `${Buffer.byteLength(slug)} bytes`);
  check(`year ${label} falls back to the "x" marker`, /-x-[0-9a-f]{8}$/.test(slug), slug);
}

// A legitimate year must survive untouched — the fix must not throw the good
// case away with the bad one.
check('a real 4-digit year is kept', /-2020-[0-9a-f]{8}$/.test(fileSlug({ title: 'A paper', publication_year: 2020 })),
  fileSlug({ title: 'A paper', publication_year: 2020 }));
check('a real 4-digit year given as a string is kept',
  /-2015-[0-9a-f]{8}$/.test(fileSlug({ title: 'A paper', publication_year: '2015' })),
  fileSlug({ title: 'A paper', publication_year: '2015' }));
check('a missing year still falls back to "x"',
  /-x-[0-9a-f]{8}$/.test(fileSlug({ title: 'A paper' })), fileSlug({ title: 'A paper' }));
// Surrounding whitespace is not a hostile year — it is the same year.
check('a year with surrounding whitespace is still that year',
  /-2020-[0-9a-f]{8}$/.test(fileSlug({ title: 'A paper', publication_year: ' 2020\n' })),
  fileSlug({ title: 'A paper', publication_year: ' 2020\n' }));

// ── 2. End to end: nothing may be written outside the library folder ───────
const root = join(tmpdir(), `dsh-d51-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });
// `../../OUTSIDE` is the shortest traversal that escapes `<root>/md/`: with the
// raw year in the name, `join(dir, 'a-paper-../../OUTSIDE-<hash>.pdf')` resolves
// to `<root>/OUTSIDE-<hash>.pdf`.
const work = {
  title: 'A paper',
  publication_year: '../../OUTSIDE',
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Test' } }],
};

const mock = installFetch((url) => {
  if (url.includes('example.org/paper.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});
const h = await prepareFullText({
  work, identifier: 'a-paper', converter: { name: 'fake', path: join(root, 'nope'), from: 'test' }, root,
  findArxiv: async () => null,
});
mock.restore();

const dir = resolve(join(root, 'md'));
const inside = (p) => resolve(p).startsWith(dir + '/');
check('the reported .md path is inside the library folder', inside(h.md), h.md);
check('the reported .pdf path is inside the library folder', inside(h.pdf), h.pdf);
check('the PDF really was written inside the library folder', existsSync(h.pdf), h.pdf);
const entries = readdirSync(root).sort();
check('the library root contains nothing but the md/ folder', entries.join(',') === 'md', entries.join(',') || '(empty)');

rmSync(root, { recursive: true, force: true });
done('D51 publication_year path traversal');
