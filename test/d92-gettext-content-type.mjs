// test/d92-gettext-content-type.mjs — a JSON envelope must not be parsed as an
// HTML result page, and an HTML error page must not be parsed as JSON.
//
// THE DEFECT. `getText` never looked at `content-type`. Measured 24 Nov 2026
// (audit probe p7): a 200 `application/json` error envelope containing the
// portal's own zero marker was parsed as an HTML result page by `ios` and
// reported as a valid empty answer —
//
//   200 application/json body containing "No Results!"
//     -> papers=0 error=null
//
// — so the reply said "IOS answered and had nothing" about a request that was
// refused. The same hole in the other direction turns an HTML error page into
// `Unexpected token '<'`, which names neither the source nor the reason.
//
// WHAT MUST STILL WORK. The header is NOT required: many APIs omit it or send
// `application/octet-stream`, and a connector must keep working there. Only an
// explicit contradiction is refused, and only on a 2xx reply — a 429 that
// happens to be `text/html` is a rate limit, not a content-type problem
// (measured 24 Nov 2026: `api.core.ac.uk` answers 429 with `text/html`).

import { searchSource } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const realFetch = globalThis.fetch;

const RESULT = '<a class="title-article" href="/documents/detail/1"><xmp>A Real Title</xmp></a>';
const CROSSREF_OK = '{"message":{"items":[]}}';

/** Serve one canned body with one `content-type` (or none). */
function serve(body, contentType, status = 200) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  });
}

// ── 1. The defect: an HTML source must not parse a JSON envelope ───────────
{
  // The portal's zero marker inside a JSON error envelope — the exact body the
  // audit measured, and the one that used to read as a valid empty answer.
  serve('{"status":"error","message":"No Results!"}', 'application/json');
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('a JSON envelope is an ERROR, not a valid empty answer', h.error !== null, h.error ?? 'null');
  check('and it yields no papers', h.papers.length === 0, String(h.papers.length));
  check('the error names the type the server sent', /application\/json/.test(h.error ?? ''), h.error ?? '');
  check('the error says HTML was expected', /HTML/i.test(h.error ?? ''), h.error ?? '');
}

{
  // `+json` is JSON too — `application/problem+json` is the standard error shape.
  serve('{"title":"Not Found","status":404}', 'application/problem+json');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('a +json type is refused for an HTML source', h.error !== null, h.error ?? 'null');
  check('the +json error names the type', /application\/problem\+json/.test(h.error ?? ''), h.error ?? '');
}

// ── 2. The defect, other direction: a JSON source must not parse HTML ──────
{
  serve('<html><body><h1>Rate limited</h1></body></html>', 'text/html');
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('an HTML page is an ERROR for a JSON source', h.error !== null, h.error ?? 'null');
  check('the error names text/html', /text\/html/.test(h.error ?? ''), h.error ?? '');
  check('the error says JSON was expected', /JSON/.test(h.error ?? ''), h.error ?? '');
}

// ── 3. No regression: the header is not required ───────────────────────────
{
  serve(`<html><body>${RESULT}</body></html>`, null);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('an HTML page with NO content-type still parses', h.error === null && h.papers.length === 1,
    h.error ?? `${h.papers.length} paper(s)`);
}
{
  serve(`<html><body>${RESULT}</body></html>`, 'application/octet-stream');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('application/octet-stream is not a contradiction', h.error === null && h.papers.length === 1,
    h.error ?? `${h.papers.length} paper(s)`);
}
{
  serve(`<html><body>${RESULT}</body></html>`, 'text/plain; charset=utf-8');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('text/plain is not a contradiction', h.error === null && h.papers.length === 1,
    h.error ?? `${h.papers.length} paper(s)`);
}
{
  serve(CROSSREF_OK, null);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a JSON reply with NO content-type still parses', h.error === null, h.error ?? 'null');
}
{
  serve(CROSSREF_OK, 'application/json; charset=utf-8');
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a JSON reply with parameters still parses', h.error === null, h.error ?? 'null');
}

// ── 4. No regression: a non-2xx reply keeps its STATUS ─────────────────────
{
  // Measured 24 Nov 2026: api.core.ac.uk answers 429 with `text/html`. That is a
  // rate limit and must keep reading as one.
  serve('<html><body>Too many requests</body></html>', 'text/html', 429);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a 429 served as text/html still reports HTTP 429', /HTTP 429/.test(h.error ?? ''), h.error ?? '');
  check('and it is not reported as a content-type problem', !/expected/i.test(h.error ?? ''), h.error ?? '');
}

globalThis.fetch = realFetch;
done('D92 getText: content-type');
