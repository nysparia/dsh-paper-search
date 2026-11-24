// test/d12-cache-note.mjs — D12: `cacheNote` was set and never read.
//
// `lib/fulltext.js:544` sets `result.cacheNote` when a cached `.md` is dropped
// because its companion PDF is invalid. On baseline 864a6e8 `grep -n cacheNote
// lib/*.js` returned exactly one hit — the assignment — so the self-healing path
// worked silently: the user's cached conversion was thrown away and re-downloaded
// with no explanation.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { installFetch, loadTools, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d12-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });

// A stale cache entry: a non-empty `.md` whose companion PDF is NOT a PDF (an
// HTML error page an older plugin version wrote before `%PDF-` validation).
const slug = 'doi-10.1038_nature14539';
writeFileSync(join(root, 'md', `${slug}.md`), '# Cached conversion\n\nstale content\n');
writeFileSync(join(root, 'md', `${slug}.pdf`), '<!doctype html><html>404 not found</html>');

const mock = installFetch((url) => {
  if (url.includes('api.openalex.org/works/doi:')) {
    return {
      body: {
        id: 'https://openalex.org/W1000',
        doi: 'https://doi.org/10.1038/nature14539',
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

// A converter that really produces Markdown, so the reply reaches the file
// section — where the cache note belongs.
const converter = join(dirname(fileURLToPath(import.meta.url)), 'fake-converter.mjs');
const tools = await loadTools({ cache: false, libraryRoot: root, anydocPath: converter });
const reply = await tools.get('paper_fulltext').execute({ identifier: '10.1038/nature14539' });
mock.restore();

check('the stale cache was really dropped and re-downloaded', /PDF source\s*:/.test(reply), reply.split('\n').slice(0, 12).join(' | '));
check('the reply explains that the cache was dropped',
  /cache dropped/i.test(reply),
  reply.split('\n').filter((l) => /cache/i.test(l)).join(' | ') || 'no line mentions the cache');
check('the note names the reason (the PDF was not valid)', /not valid|invalid/i.test(reply));

rmSync(root, { recursive: true, force: true });
done('D12 unread cacheNote');
