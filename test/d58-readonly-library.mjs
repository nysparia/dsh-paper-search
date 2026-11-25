// test/d58-readonly-library.mjs — D58 (audit M6): a read-only library root was
// reported as "all PDF candidates failed".
//
// THE DEFECT. The `EACCES` from `writeFileSync` inside `downloadPdf` was caught
// by the per-candidate `catch` and folded into the candidate-failure list:
//
//   problem: "all PDF candidates failed (openalex: EACCES: permission denied,
//             open '…/readonly/md/doi-10.1038_nature14539-2fbc9ecc.pdf.part')"
//   candidates: ["openalex"]
//
// The message blames the PDF sources. The actual cause is that the library folder
// is not writable, and every candidate will fail the same way — so the user is
// sent to `paper_oa` and the campus library for a permissions problem.
//
// THE FIX. A local write failure (`EACCES`, `EROFS`, `ENOSPC`, `ENAMETOOLONG`, …)
// stops the loop and is reported as a library-folder problem.
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { prepareFullText } from '../lib/fulltext.js';
import { installFetch, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();
const here = dirname(fileURLToPath(import.meta.url));
const converter = { name: 'fake', path: join(here, '_fake-converter.mjs'), from: 'test' };

const root = join(tmpdir(), `dsh-d58-${process.pid}`);
rmSync(root, { recursive: true, force: true });
const mdDir = join(root, 'md');
mkdirSync(mdDir, { recursive: true });
// Read-only: the folder exists and can be listed, but nothing can be written.
chmodSync(mdDir, 0o555);

const work = {
  doi: '10.1038/nature14539',
  title: 'A paper',
  publication_year: 2015,
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Test' } }],
};

const mock = installFetch((url) => {
  if (url.includes('example.org/paper.pdf')) return { body: fakePdf(), headers: { 'content-type': 'application/pdf' } };
  if (url.includes('export.arxiv.org')) return { body: '<feed></feed>' };
  return { status: 404, body: 'not mocked' };
});
const h = await prepareFullText({ work, identifier: work.doi, converter, root, findArxiv: async () => null });
mock.restore();
chmodSync(mdDir, 0o755);

check('the call reports a problem', typeof h.problem === 'string', h.problem ?? '(none)');
check('the problem names the LIBRARY FOLDER as the cause',
  /library folder/i.test(h.problem ?? ''), h.problem ?? '(none)');
check('the problem says it is a permissions/disk problem',
  /permission|disk|writ/i.test(h.problem ?? ''), h.problem ?? '(none)');
check('the problem does NOT blame the PDF sources',
  !/all PDF candidates failed/i.test(h.problem ?? ''), h.problem ?? '(none)');
check('the problem does not send the user to paper_oa for a permissions problem',
  !/paper_oa/i.test(h.problem ?? ''), h.problem ?? '(none)');
check('the underlying EACCES is still visible', /EACCES|permission denied/i.test(h.problem ?? ''),
  h.problem ?? '(none)');

rmSync(root, { recursive: true, force: true });
done('D58 read-only library root reported as a PDF-source failure');
