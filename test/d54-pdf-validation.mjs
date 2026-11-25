// test/d54-pdf-validation.mjs — D54 (audit M2, L5, L6): "valid PDF" meant "five
// ASCII bytes".
//
// THE DEFECTS, all measured 24 Nov 2026.
//
//   M2  `content-type` was never read, so a `text/html` error page that happened
//       to begin with `%PDF-` was stored as the paper. `checkPdf` had the same
//       blind spot: `"%PDF-" + 2000 NUL bytes` was reported `{ok: true}`.
//   L5  A DIRECTORY named `*.pdf` was reported as `only 0 bytes` — the right
//       verdict with a wrong statement about what is there.
//   L6  `%PDF-` was required at offset 0, so a real PDF with a leading newline,
//       a leading space or a UTF-8 BOM was reported `prefix ".%PDF"` — "not a
//       PDF" for a file every converter reads fine. The spec allows the header
//       anywhere in the first 1024 bytes.
//
// THE FIX. `downloadPdf` rejects an explicit non-PDF `content-type` (it does not
// REQUIRE the header — many repositories omit it). `checkPdf` requires a regular
// file, `%PDF-` within the first 1024 bytes, and `%%EOF` in the last 2 KB.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkPdf, downloadPdf } from '../lib/fulltext.js';
import { reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d54-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

async function withFetch(reply, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => reply;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

function replyOf(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    arrayBuffer: async () => Buffer.from(body),
  };
}

async function tryDownload(name, body, headers) {
  const dest = join(root, `${name}.pdf`);
  const r = await withFetch(replyOf(body, headers), async () => {
    try { return { ok: true, value: await downloadPdf('https://example.org/paper.pdf', dest) }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  return r;
}

// ── 1. M2: an explicit non-PDF content-type is refused ─────────────────────
{
  const r = await tryDownload('html', `%PDF-1.4\n${'% filler\n'.repeat(200)}%%EOF\n`, { 'content-type': 'text/html; charset=utf-8' });
  check('a text/html body that starts with %PDF- is refused', r.ok === false, JSON.stringify(r));
  check('the refusal names the content-type', /text\/html/.test(r.message ?? ''), r.message);
}
{
  const r = await tryDownload('json', fakePdf(), { 'content-type': 'application/json' });
  check('an application/json body is refused', r.ok === false, JSON.stringify(r));
}
// A missing content-type must still be accepted: many repositories omit it, and
// requiring it would refuse real PDFs.
{
  const r = await tryDownload('no-type', fakePdf(), {});
  check('a reply with NO content-type is still accepted', r.ok === true, JSON.stringify(r));
}
{
  const r = await tryDownload('octet', fakePdf(), { 'content-type': 'application/octet-stream' });
  check('application/octet-stream is still accepted (a common repository type)', r.ok === true, JSON.stringify(r));
}
{
  const r = await tryDownload('pdf-type', fakePdf(), { 'content-type': 'application/pdf' });
  check('application/pdf is accepted', r.ok === true, JSON.stringify(r));
}

// ── 2. M2: a body that is %PDF- followed by NULs is not a PDF ──────────────
{
  const nulPadded = `%PDF-${'\u0000'.repeat(2000)}`;
  const r = await tryDownload('nul', nulPadded, { 'content-type': 'application/pdf' });
  check('"%PDF-" + 2000 NUL bytes is refused by downloadPdf', r.ok === false, JSON.stringify(r));
  check('the refusal names the missing trailer', /%%EOF|trailer/i.test(r.message ?? ''), r.message);

  const file = join(root, 'nul-on-disk.pdf');
  writeFileSync(file, nulPadded);
  const verdict = checkPdf(file);
  check('checkPdf refuses "%PDF-" + 2000 NUL bytes', verdict.ok === false, JSON.stringify(verdict));
  check('checkPdf names the missing trailer', /%%EOF|trailer/i.test(verdict.reason ?? ''), verdict.reason);
}

// ── 3. L6: a real PDF with a BOM or leading whitespace is still a PDF ──────
for (const [label, prefix] of [['a leading newline', '\n'], ['a leading space', ' '], ['a UTF-8 BOM', '\uFEFF']]) {
  const file = join(root, `prefixed-${label.replace(/\W+/g, '-')}.pdf`);
  writeFileSync(file, `${prefix}${fakePdf()}`);
  const verdict = checkPdf(file);
  check(`a real PDF with ${label} is accepted`, verdict.ok === true, JSON.stringify(verdict));
}

// ── 4. A truncated PDF (no trailer) is not a PDF ───────────────────────────
{
  const file = join(root, 'truncated.pdf');
  writeFileSync(file, fakePdf().slice(0, 1200));
  const verdict = checkPdf(file);
  check('a truncated PDF is refused', verdict.ok === false, JSON.stringify(verdict));
  check('the reason names the missing trailer', /%%EOF|trailer/i.test(verdict.reason ?? ''), verdict.reason);
}

// ── 5. L5: a directory is not an empty file ────────────────────────────────
{
  const dir = join(root, 'a-directory.pdf');
  mkdirSync(dir, { recursive: true });
  const verdict = checkPdf(dir);
  check('a directory named *.pdf is refused', verdict.ok === false, JSON.stringify(verdict));
  check('the reason says "not a regular file", not "only 0 bytes"',
    /not a regular file/i.test(verdict.reason ?? ''), verdict.reason);
  check('the reason does not claim the file is empty', !/only 0 bytes/i.test(verdict.reason ?? ''), verdict.reason);
}

// ── 6. The clean case is untouched ─────────────────────────────────────────
{
  const file = join(root, 'clean.pdf');
  writeFileSync(file, fakePdf());
  const verdict = checkPdf(file);
  check('a clean PDF is still accepted', verdict.ok === true, JSON.stringify(verdict));
  check('the byte count is reported', verdict.bytes > 0, String(verdict.bytes));
}

rmSync(root, { recursive: true, force: true });
done('D54 PDF validation: content-type, trailer, BOM, directory');
