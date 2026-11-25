// test/d53-download-size-cap.mjs — D84 (audit M1): `downloadPdf` had no size cap.
//
// THE DEFECT. The whole reply was buffered and then written:
//
//   const buf = Buffer.from(await res.arrayBuffer());
//   writeFileSync(temporary, buf);
//
// `content-length` and `content-type` were never read. Measured 24 Nov 2026:
// a 64 MB body cost 64 MB of RSS and 64 MB on disk (the `Buffer` plus the
// `writeFileSync` copy), and a reply declaring 5 GiB was accepted as far as the
// header was concerned. The 120 s timeout bounds TIME, not bytes.
//
// THE FIX. A cap of 100 MB (`MAX_PDF_BYTES`): ~35x the largest paper PDF
// measured for this file's header comment (2.9 MB, PLOS), which leaves room for
// a scanned thesis while bounding what a hostile or broken OA host can cost.
// `content-length` is checked before the body is read, and the body is STREAMED
// with a running counter that aborts the transfer the moment the cap is passed.
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { downloadPdf } from '../lib/fulltext.js';
import { reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d84-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const CAP = 100 * 1024 * 1024;

/** A Response-shaped stub whose body is a real stream of `chunks` x `size` bytes. */
function streamedReply({ chunks, size, headers = {} }) {
  const head = Buffer.from(fakePdf());
  let sent = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    body: new ReadableStream({
      pull(controller) {
        if (sent >= chunks) { controller.close(); return; }
        sent++;
        // The first chunk is a real PDF header so the body is not refused for
        // the wrong reason; the rest is filler.
        controller.enqueue(sent === 1 ? new Uint8Array(head) : new Uint8Array(size));
      },
    }),
  };
}

/** Replace fetch for one call. */
async function withFetch(reply, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => reply;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// ── 1. `content-length` over the cap is refused BEFORE the body is read ────
{
  let bodyRead = false;
  const reply = {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(5 * 1024 * 1024 * 1024) : null) },
    get body() { bodyRead = true; return null; },
    arrayBuffer: async () => { bodyRead = true; return Buffer.from(fakePdf()); },
  };
  const dest = join(root, 'declared.pdf');
  const r = await withFetch(reply, async () => {
    try { await downloadPdf('https://example.org/paper.pdf', dest); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  check('a reply declaring 5 GiB is refused', r.ok === false, JSON.stringify(r));
  check('the refusal names the declared size', /5368709120|5\d{9}/.test(r.message ?? ''), r.message);
  check('the refusal names the cap', /cap/i.test(r.message ?? ''), r.message);
  check('the body was never read', bodyRead === false, `bodyRead=${bodyRead}`);
  check('nothing was written to disk', !existsSync(dest), dest);
}

// ── 2. A streamed body that passes the cap is ABORTED mid-transfer ─────────
{
  // 40 chunks of 8 MB = 320 MB, well past the 100 MB cap.
  const reply = streamedReply({ chunks: 40, size: 8 * 1024 * 1024 });
  const dest = join(root, 'streamed.pdf');
  const started = Date.now();
  const r = await withFetch(reply, async () => {
    try { await downloadPdf('https://example.org/paper.pdf', dest); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  const elapsed = Date.now() - started;
  check('a streamed body over the cap is refused', r.ok === false, JSON.stringify(r));
  check('the refusal names the cap', /cap/i.test(r.message ?? ''), r.message);
  check('the refusal reports where it stopped', /\d+ bytes/.test(r.message ?? ''), r.message);
  check('the transfer was aborted early, not after the whole body', elapsed < 5000, `${elapsed} ms`);
  check('nothing was written to disk', !existsSync(dest), dest);
  check('no .part file was left behind', !existsSync(`${dest}.part`), `${dest}.part`);
}

// ── 3. A body under the cap is still accepted ──────────────────────────────
{
  const reply = streamedReply({ chunks: 1, size: 0 });
  const dest = join(root, 'small.pdf');
  const r = await withFetch(reply, async () => {
    try { return { ok: true, value: await downloadPdf('https://example.org/paper.pdf', dest) }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  check('a body under the cap is accepted', r.ok === true, JSON.stringify(r));
  check('the file really was written', existsSync(dest) && statSync(dest).size > 0, dest);
  check('the reported byte count matches the file', r.value?.bytes === statSync(dest).size,
    `${r.value?.bytes} vs ${statSync(dest).size}`);
  check('no .part file was left behind on success', !existsSync(`${dest}.part`), `${dest}.part`);
}

// ── 4. The cap is a defensible number for a paper PDF ─────────────────────
check('the cap is 100 MB — stated, not implicit', CAP === 100 * 1024 * 1024, String(CAP));

rmSync(root, { recursive: true, force: true });
done('D53 downloadPdf size cap');
