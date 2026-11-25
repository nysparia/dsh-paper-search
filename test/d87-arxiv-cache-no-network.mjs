// d87 — a cached arXiv full text must not need the network.
//
// THE DEFECT. `fileSlug` derived a paper's file name from its TITLE, so a direct
// `paper_fulltext({identifier:'1706.03762'})` had to fetch the metadata from
// `export.arxiv.org` BEFORE it could work out which file to look for. The cache
// check therefore came after a network round trip, and a call whose Markdown was
// already on disk still paid for it.
//
// Measured 24 Nov 2026 on 0.8.0 against the live arXiv API:
//
//   first  call : 11,824 ms   (download + convert)
//   repeat call :  5,416 ms   of which `arxivWork()` was 5,630 ms
//
// and the reply said "already converted — not downloaded again", which was true
// and also the only thing the caller learned for five seconds.
//
// THE FIX. An arXiv id is its own identifier, so the file name is derived from
// the id and the cache can be consulted with no network at all. The title is
// recorded in the completion marker, so the header still names the paper without
// the lookup that was skipped.
//
// This test asserts the NETWORK is not touched, not the elapsed time — a timing
// assertion would be flaky on a loaded machine, while "zero requests" is exact.

import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { completedFullText, fileSlug, prepareFullText } from '../lib/fulltext.js';
import { installFetch, loadTools, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d87-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });

const ARXIV = '1706.03762';
const TITLE = 'Attention Is All You Need';

// ── 1. The file name comes from the id, not the title ───────────────────────
{
  const withTitle = fileSlug({ title: TITLE, publication_year: 2017 }, ARXIV);
  const withoutTitle = fileSlug({ title: null, publication_year: null }, ARXIV);
  check('the arXiv slug does not depend on the title', withTitle === withoutTitle,
    `${withTitle} vs ${withoutTitle}`);
  check('the arXiv slug names the id', withTitle.startsWith('arxiv-1706.03762-'), withTitle);
  check('a title-only call still gets a title-based slug',
    fileSlug({ title: 'Some Paper', publication_year: 2020 }, 'Some Paper').startsWith('some-paper-2020-'),
    fileSlug({ title: 'Some Paper', publication_year: 2020 }, 'Some Paper'));
}

// ── 2. A real cache entry is found with NO network ──────────────────────────
//
// The entry is produced by running the conversion once, so the marker is the one
// this plugin writes rather than a hand-made file.
const converterPath = join(root, 'conv.mjs');
writeFileSync(converterPath, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst a = process.argv.slice(2); const o = a[a.indexOf('-o') + 1];\nwriteFileSync(o, '# Attention Is All You Need\\n\\nBody.\\n');\n`);
chmodSync(converterPath, 0o755);
const converter = { name: 'conv', path: converterPath, from: 'test' };

const work = {
  title: TITLE, doi: null, publication_year: 2017,
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: `https://arxiv.org/pdf/${ARXIV}`, landing_page_url: null, source: { display_name: 'arXiv' } }],
};

const firstMock = installFetch((url) => {
  if (url.includes('arxiv.org/pdf/')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  return { status: 404, body: 'not mocked' };
});
const first = await prepareFullText({ work, identifier: ARXIV, converter, root, findArxiv: async () => null });
firstMock.restore();
check('the fixture really is a cache entry this plugin wrote',
  first.problem === null && first.fromCache === false,
  `problem=${first.problem} fromCache=${first.fromCache}`);

// The probe must answer with NO fetch installed at all. If it reaches for the
// network, `globalThis.fetch` is the real one and the assertion below fails on
// the request count rather than on a timeout.
let requests = 0;
const probeMock = installFetch(() => { requests += 1; return { status: 500, body: '' }; });
const probe = completedFullText({ identifier: ARXIV, root });
probeMock.restore();
check('the cache probe finds the entry', probe.hit === true, JSON.stringify(probe));
check('the cache probe makes NO network request', requests === 0, `requests=${requests}`);
check('the probe recovers the title from the marker', probe.title === TITLE, JSON.stringify(probe.title));

// ── 3. The tool itself does not touch the network on a cache hit ────────────
{
  let toolRequests = 0;
  const mock = installFetch((url) => {
    toolRequests += 1;
    return { status: 500, body: `unexpected request: ${url}` };
  });
  const tools = loadTools({ cache: false, libraryRoot: root });
  const reply = await tools.get('paper_fulltext').execute({ identifier: ARXIV });
  mock.restore();
  check('a cached arXiv call makes ZERO requests', toolRequests === 0, `requests=${toolRequests}`);
  check('the reply still names the paper', reply.includes(TITLE),
    reply.split('\n').slice(0, 4).join(' | '));
  check('the reply says it came from the cache', /already converted/.test(reply),
    reply.split('\n').find((l) => /PDF source/.test(l)) ?? '');
}

// ── 4. force_refresh still goes to the network ─────────────────────────────
//
// The probe is skipped when the caller asked for the work to be redone, so the
// metadata lookup must still happen — otherwise "refresh" would silently mean
// "reuse the title I already had".
{
  let toolRequests = 0;
  const mock = installFetch((url) => {
    toolRequests += 1;
    if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
    if (url.includes('arxiv.org/pdf/')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
    return { status: 404, body: 'not mocked' };
  });
  const tools = loadTools({ cache: false, libraryRoot: root });
  await tools.get('paper_fulltext').execute({ identifier: ARXIV, force_refresh: true });
  mock.restore();
  check('force_refresh does NOT use the cache probe', toolRequests > 0, `requests=${toolRequests}`);
}

rmSync(root, { recursive: true, force: true });
done('D87 a cached arXiv full text needs no network');
