// test/d55-part-cleanup.mjs — D86 (audit M3): a failed write or rename left the
// `.part` file behind.
//
// THE DEFECT. `downloadPdf` wrote `<destination>.part` and renamed it, with no
// `try/finally`:
//
//   const temporary = `${destination}.part`;
//   writeFileSync(temporary, buf);
//   renameSync(temporary, destination);
//
// Measured 24 Nov 2026, with a directory sitting at the destination:
//
//   threw: "EISDIR … rename '…/dest-is-a-directory.pdf.part' -> '…/dest-is-a-directory.pdf'"
//   files in root after failure: ["dest-is-a-directory.pdf","dest-is-a-directory.pdf.part"]
//
// Nothing ever collected them, and on a full disk (the case M1 makes reachable)
// every attempt left another one.
//
// THE FIX. The write+rename is wrapped, and the temporary is unlinked on the way
// out. The `.part` name is still what an INTERRUPTED run leaves behind — that is
// the point of writing atomically — but a FAILED run no longer does.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { downloadPdf } from '../lib/fulltext.js';
import { reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d86-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

async function withFetch(body, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/pdf' : null) },
    arrayBuffer: async () => Buffer.from(body),
  });
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// ── 1. The rename fails because the destination is a directory ─────────────
{
  const dest = join(root, 'dest-is-a-directory.pdf');
  mkdirSync(dest, { recursive: true });
  const r = await withFetch(fakePdf(), async () => {
    try { await downloadPdf('https://example.org/paper.pdf', dest); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  check('the download fails when the destination is a directory', r.ok === false, JSON.stringify(r));
  check('the failure is reported, not swallowed', /EISDIR|ENOTDIR|EEXIST|EPERM|EISDIR/i.test(r.message ?? ''), r.message);
  check('no .part file is left behind', !existsSync(`${dest}.part`), `${dest}.part`);
  const leftovers = readdirSync(root).filter((f) => f.endsWith('.part'));
  check('the folder holds no .part file at all', leftovers.length === 0, leftovers.join(', ') || 'none');
}

// ── 2. The write itself fails (the .part path is a directory) ──────────────
{
  const dest = join(root, 'write-fails.pdf');
  mkdirSync(`${dest}.part`, { recursive: true });
  const r = await withFetch(fakePdf(), async () => {
    try { await downloadPdf('https://example.org/paper.pdf', dest); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  check('the download fails when the .part path is unusable', r.ok === false, JSON.stringify(r));
  check('the destination was not created', !existsSync(dest), dest);
  // The directory that was already there is not a leftover this code created;
  // what matters is that no FILE was left behind.
  const files = readdirSync(root).filter((f) => f.endsWith('.part') && !f.startsWith('write-fails'));
  check('no stray .part file was created', files.length === 0, files.join(', ') || 'none');
}

// ── 3. A successful download leaves no .part either ────────────────────────
{
  const dest = join(root, 'ok.pdf');
  const r = await withFetch(fakePdf(), async () => {
    try { return { ok: true, value: await downloadPdf('https://example.org/paper.pdf', dest) }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  check('a successful download still works', r.ok === true, JSON.stringify(r));
  check('the destination exists', existsSync(dest), dest);
  check('no .part file is left behind on success', !existsSync(`${dest}.part`), `${dest}.part`);
}

rmSync(root, { recursive: true, force: true });
done('D55 .part left behind by a failed write or rename');
