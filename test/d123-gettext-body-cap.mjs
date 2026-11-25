// test/d123-gettext-body-cap.mjs — the body is bounded while it is read, not
// after it is in memory.
//
// THE DEFECT. `getText` called `await res.text()`, which buffers whatever the
// server sends. The only cap in the file was
//
//   err.fullBody = text.slice(0, 512 * 1024)
//
// which ran AFTER the whole body was in memory and only on the ERROR path — so
// the success path, the one that parses, had no bound at all. Measured 24 Nov
// 2026 (audit probe p7): an 8 MB page with the only result at the very end cost
// 28–37 MB of RSS.
//
// The cap is 4 MiB. Measured the same day on the live endpoints: OpenAlex at
// 100/page was 1.37 MB, Crossref at `rows=1000` was 3.13 MB, and the three HTML
// portals were 62 KB (Garuda) and smaller — and the plugin never asks for more
// than 50 rows per source. So 4 MiB is about 3× the real maximum and still
// refuses the audit's 8 MB page.
//
// `content-length` is checked first because it is free, but it cannot be the
// only check: measured the same day, Crossref answered `rows=20` with
// `content-length: 16244` for a 74,086-byte body and Garuda with `11915` for
// 62,359 — the header describes the COMPRESSED body, so it is a lower bound.
// The stream is counted as it arrives.

import { searchSource } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const realFetch = globalThis.fetch;

const RESULT = '<a class="title-article" href="/documents/detail/1"><xmp>A Real Title</xmp></a>';
const MiB = 1024 * 1024;

/**
 * Serve `chunks` as a real stream, with an optional `content-length`.
 *
 * `text()` returns the whole body, exactly as a real `Response` would, so the
 * unfixed code parses an oversized page instead of failing for an unrelated
 * reason — the assertions below have to fail on the OLD code for the reason the
 * audit measured. `textCalls` and `streamRead` record which path was taken.
 */
function serveStream(chunks, { contentType = 'text/html', contentLength, status = 200 } = {}) {
  const state = { textCalls: 0, streamRead: false };
  const all = Buffer.concat(chunks);
  globalThis.fetch = async () => {
    const queue = chunks.slice();
    // `pull` fires as soon as the stream is CONSTRUCTED (it fills its queue to
    // the high-water mark with no reader), so it cannot record "someone read
    // this". `getReader` can: that is the call the cap is supposed to avoid.
    const stream = new ReadableStream({
      pull(c) {
        const next = queue.shift();
        if (next === undefined) c.close();
        else c.enqueue(new Uint8Array(next));
      },
    });
    const getReader = stream.getReader.bind(stream);
    stream.getReader = (...a) => { state.streamRead = true; return getReader(...a); };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k) => {
          const key = String(k).toLowerCase();
          if (key === 'content-type') return contentType;
          if (key === 'content-length') return contentLength === undefined ? null : String(contentLength);
          return null;
        },
      },
      body: stream,
      text: async () => { state.textCalls++; return all.toString('utf8'); },
    };
  };
  return state;
}

/** 5 MiB of filler with the only result at the very end — the audit's page. */
const bigPage = () => [
  Buffer.alloc(MiB, 'x'),
  Buffer.alloc(MiB, 'x'),
  Buffer.alloc(MiB, 'x'),
  Buffer.alloc(MiB, 'x'),
  Buffer.from(`<html><body>${RESULT}</body></html>`),
];

// ── 1. The defect: a declared content-length over the cap is refused ───────
{
  const state = serveStream(bigPage(), { contentLength: 5 * MiB });
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('an oversized content-length is an ERROR', h.error !== null, h.error ?? 'null');
  check('and it yields no papers', h.papers.length === 0, String(h.papers.length));
  check('the error names the cap', /4194304-byte cap/.test(h.error ?? ''), h.error ?? '');
  check('the error names the constant to change', /MAX_BODY_BYTES/.test(h.error ?? ''), h.error ?? '');
  // The point of the fast path: the body is never buffered at all.
  check('the body is not read when the header already says it is too big',
    state.textCalls === 0 && state.streamRead === false,
    `text() calls ${state.textCalls}, stream read ${state.streamRead}`);
}

// ── 2. The defect: no content-length, so the stream itself is bounded ──────
{
  const state = serveStream(bigPage());
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('an oversized stream with no content-length is an ERROR', h.error !== null, h.error ?? 'null');
  check('and it yields no papers', h.papers.length === 0, String(h.papers.length));
  check('the streamed error names the cap', /4194304-byte cap/.test(h.error ?? ''), h.error ?? '');
  check('the stream was actually read', state.streamRead === true, String(state.streamRead));
}

// ── 3. No regression: a large but legitimate page still parses ────────────
{
  serveStream([Buffer.alloc(MiB, 'x'), Buffer.from(`<html><body>${RESULT}</body></html>`)]);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('a 1 MB page is under the cap and parses', h.error === null, h.error ?? 'null');
  check('and its result is found', h.papers.length === 1, String(h.papers.length));
  check('the title survives', h.papers[0]?.title === 'A Real Title', h.papers[0]?.title ?? '(none)');
}

// ── 4. No regression: an oversized ERROR body still names its status ──────
{
  serveStream(bigPage(), { contentLength: 5 * MiB, status: 503 });
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('a 503 with an oversized body still reports HTTP 503', /HTTP 503/.test(h.error ?? ''), h.error ?? '');
  check('and it also names the cap', /4194304-byte cap/.test(h.error ?? ''), h.error ?? '');
}

globalThis.fetch = realFetch;
done('D123 getText: body size cap');
