// test/d13-slug-collision.mjs — D13: `paper_fulltext` can return a DIFFERENT
// paper's full text and report it as a cache hit.
//
// `fileSlug` (`lib/fulltext.js:203-209`) built the cache filename with
// `doi.replace(/[^a-z0-9.]+/gi, '_')`, so every non-alphanumeric character
// except `.` collapsed to the same `_`. Measured on the baseline:
//
//   10.1234/a-b  \
//   10.1234/a_b   \
//   10.1234/a b    >  all -> doi-10.1234_a_b     (5 distinct DOIs, ONE file)
//   10.1234/a+b   /
//   10.1234/a/b  /
//
// and the title path collapsed `"Deep Learning: A Review"`,
// `"Deep Learning - A Review"` and `"Deep Learning, A Review"` to the single
// name `deep-learning-a-review-2020`.
//
// The consequence is the worst in the audit: `prepareFullText` sees a `.md` at
// that name, reports `fromCache: true` / `"already converted"`, and hands back
// ANOTHER paper's body — which the agent then reads, quotes and cites.
//
// The fix must be COLLISION-FREE while staying human-readable: the readable
// part is kept and a short hash of the EXACT identifier is appended. Two
// assertions below are therefore in tension on purpose — distinctness AND
// readability — because a fix that satisfies only one of them is not the fix
// the spec asks for.
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

// ── 1. The slug function, directly ──────────────────────────────────────────

const COLLIDING_DOIS = [
  '10.1234/a-b',
  '10.1234/a_b',
  '10.1234/a b',
  '10.1234/a+b',
  '10.1234/a/b',
];
const doiSlugs = COLLIDING_DOIS.map((doi) => fileSlug({ doi }));
check('the five colliding DOIs produce five DISTINCT slugs',
  new Set(doiSlugs).size === COLLIDING_DOIS.length,
  doiSlugs.join(' | '));

check('every DOI slug still carries the readable part (human-readable)',
  doiSlugs.every((s) => s.startsWith('doi-10.1234_a_b')),
  doiSlugs.join(' | '));

check('every DOI slug ends with a short hex hash of the exact DOI',
  doiSlugs.every((s) => /-[0-9a-f]{8}$/.test(s)),
  doiSlugs.join(' | '));

const COLLIDING_TITLES = [
  'Deep Learning: A Review',
  'Deep Learning - A Review',
  'Deep Learning, A Review',
];
const titleSlugs = COLLIDING_TITLES.map((title) => fileSlug({ title, publication_year: 2020 }));
check('the three colliding titles produce three DISTINCT slugs',
  new Set(titleSlugs).size === COLLIDING_TITLES.length,
  titleSlugs.join(' | '));

check('every title slug still carries the readable part (human-readable)',
  titleSlugs.every((s) => s.startsWith('deep-learning-a-review-2020')),
  titleSlugs.join(' | '));

check('every title slug ends with a short hex hash of the exact title + year',
  titleSlugs.every((s) => /-[0-9a-f]{8}$/.test(s)),
  titleSlugs.join(' | '));

// The hash must be over the EXACT identifier, not over the already-collapsed
// readable part — otherwise the three titles above hash to the same value and
// the collision survives the fix.
check('the title hash is not computed from the collapsed readable part',
  new Set(titleSlugs.map((s) => s.slice(-8))).size === COLLIDING_TITLES.length,
  titleSlugs.map((s) => s.slice(-8)).join(' | '));

// Normalization that already existed must not be lost: the same DOI written
// three ways is the same paper and must stay ONE file.
const sameDoi = [
  fileSlug({ doi: '10.1038/NATURE14539' }),
  fileSlug({ doi: 'https://doi.org/10.1038/nature14539' }),
  fileSlug({ doi: 'doi:10.1038/nature14539' }),
];
check('the same DOI in three spellings still maps to ONE file',
  new Set(sameDoi).size === 1,
  sameDoi.join(' | '));

check('the same title in a different year maps to a different file',
  fileSlug({ title: 'Deep Learning: A Review', publication_year: 2020 })
  !== fileSlug({ title: 'Deep Learning: A Review', publication_year: 2021 }));

// The deliberate limit of the normalization: a title that differs ONLY in
// whitespace is the same title, so it stays one file. Pinned here so a later
// change cannot quietly turn "same paper" into "two downloads", and so the
// distinction from the punctuation cases above is explicit.
check('a title differing only in whitespace stays ONE file (same paper)',
  fileSlug({ title: 'Deep Learning A Review', publication_year: 2020 })
  === fileSlug({ title: 'Deep Learning   A Review', publication_year: 2020 }));

check('the slug is safe as a file name (no separators, no shell characters)',
  [...doiSlugs, ...titleSlugs].every((s) => /^[A-Za-z0-9._-]+$/.test(s) && !s.includes('..')),
  [...doiSlugs, ...titleSlugs].filter((s) => !/^[A-Za-z0-9._-]+$/.test(s)).join(' | ') || 'all clean');

check('a work with neither DOI nor title still yields a usable slug',
  /^paper-x-[0-9a-f]{8}$/.test(fileSlug({})),
  fileSlug({}));

// ── 2. prepareFullText, end to end (the case measured in the spec) ──────────

const PAPER_A = '10.1016/j.cell.2020.01-001';
const PAPER_B = '10.1016/j.cell.2020.01_001';
const PAPER_A_CONTENT = '# PAPER A CONTENT — this is the WRONG paper\n';

const root = join(tmpdir(), `dsh-d13-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });

// Paper A was converted earlier: its `.md` is on disk under A's slug.
const slugA = fileSlug({ doi: PAPER_A });
writeFileSync(join(root, 'md', `${slugA}.md`), PAPER_A_CONTENT);

const mock = installFetch((url) => {
  if (url.includes('example.org/b.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});

const workB = {
  doi: PAPER_B,
  title: 'A different paper that happens to share a slug',
  publication_year: 2020,
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: 'https://example.org/b.pdf', source: { display_name: 'Test' } }],
};

const hB = await prepareFullText({
  work: workB, identifier: PAPER_B, converter, root, findArxiv: async () => null,
});

check('paper B is NOT served from the cache', hB.fromCache === false,
  `fromCache=${hB.fromCache} used=${JSON.stringify(hB.used)}`);
check('paper B does not get paper A\'s file',
  hB.md !== join(root, 'md', `${slugA}.md`),
  `${hB.md} vs ${join(root, 'md', `${slugA}.md`)}`);
const contentB = existsSync(hB.md) ? readFileSync(hB.md, 'utf8') : '';
check('paper B\'s Markdown does not contain paper A\'s content',
  !contentB.includes('PAPER A CONTENT'),
  contentB.split('\n')[0] || '(no file)');
check('paper B really was downloaded and converted',
  hB.problem === null && contentB.length > 0,
  hB.problem ?? `${contentB.length} chars`);

// The fix must not be "disable the cache": paper A must still be a hit.
const hA = await prepareFullText({
  work: { doi: PAPER_A, title: 'Paper A', publication_year: 2020 },
  identifier: PAPER_A, converter, root, findArxiv: async () => null,
});
check('paper A is still served from its own cache (the cache still works)',
  hA.fromCache === true && hA.used?.note === 'already converted',
  `fromCache=${hA.fromCache} used=${JSON.stringify(hA.used)}`);
check('paper A still gets paper A\'s content',
  readFileSync(hA.md, 'utf8').includes('PAPER A CONTENT'));

mock.restore();

// ── 3. The same case through the registered tool ────────────────────────────
//
// The spec measures `prepareFullText`; this section proves the defect is gone
// on the path the agent actually calls, including the reply text that used to
// say "this file ALREADY EXISTED from before".

const root2 = join(tmpdir(), `dsh-d13-tool-${process.pid}`);
rmSync(root2, { recursive: true, force: true });
mkdirSync(join(root2, 'md'), { recursive: true });
writeFileSync(join(root2, 'md', `${fileSlug({ doi: PAPER_A })}.md`), PAPER_A_CONTENT);

const mock2 = installFetch((url) => {
  if (url.includes('api.openalex.org/works/doi:')) {
    const doi = decodeURIComponent(url.split('/works/doi:')[1].split('?')[0]);
    return {
      body: {
        id: 'https://openalex.org/W999',
        doi: `https://doi.org/${doi}`,
        title: 'A different paper that happens to share a slug',
        publication_year: 2020,
        cited_by_count: 1,
        open_access: { is_oa: true, oa_status: 'green' },
        locations: [{ is_oa: true, pdf_url: 'https://example.org/b.pdf', source: { display_name: 'Test' } }],
      },
    };
  }
  if (url.includes('example.org/b.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});

const tools = await loadTools({ cache: false, libraryRoot: root2, anydocPath: converterPath });
const reply = await tools.get('paper_fulltext').execute({ identifier: PAPER_B });
mock2.restore();

check('paper_fulltext for paper B does not return paper A\'s content',
  !reply.includes('PAPER A CONTENT'),
  reply.split('\n').filter((l) => l.includes('PAPER A')).join(' | ') || 'clean');
check('paper_fulltext for paper B does not claim the file already existed',
  !/ALREADY EXISTED/i.test(reply),
  reply.split('\n').filter((l) => /ALREADY EXISTED/i.test(l)).join(' | ') || 'clean');
check('paper_fulltext for paper B returns its own converted body',
  /Converted paper/.test(reply),
  reply.split('\n').slice(-4).join(' | '));

rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
done('D13 collision-free fulltext slug');
