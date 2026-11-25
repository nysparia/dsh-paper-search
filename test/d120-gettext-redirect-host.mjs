// test/d120-gettext-redirect-host.mjs — a body served from another host is not
// this source's answer.
//
// THE DEFECT. `getText` fetched with `redirect: 'follow'` and never looked at
// `res.url`, so a 302 to ANY host was parsed as the source's own result page.
// Measured 24 Nov 2026 (audit probe p7, a real 302 to a second local server):
//
//   redirect to http://localhost:42329/ (a different host)
//     -> papers=1 title="A Real Title"
//        url=https://garuda.kemdiktisaintek.go.id/documents/detail/1 error=null
//
// The reply then carries a Garuda URL for a record Garuda never served. A
// captive portal, a mirror or a hijacked DNS answer produces exactly that, and
// the model has no way to tell the record from a real hit.
//
// The diagnosis was wrong in the other direction too: a login wall, a CAPTCHA or
// a cookie interstitial came back as "markup changed", which sends the operator
// to the parser when the truth is "we were served a different page".
//
// WHAT MUST STILL WORK. A same-host redirect (http->https, a trailing slash) is
// not a defect, a `www.`-only difference is the same site answering under its
// canonical name, and a reply with no `res.url` at all — every stubbed reply in
// this suite — must not be refused.

import { searchSource } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const realFetch = globalThis.fetch;

const RESULT = '<a class="title-article" href="/documents/detail/1"><xmp>A Real Title</xmp></a>';

/**
 * Serve one canned body, with `finalUrl` as the URL the body really came from.
 *
 * `finalUrl` is a function of the requested URL so the "no redirect" case is
 * expressed as "the reply came from where we asked", which is what a real
 * `fetch` reports.
 */
function serve(body, finalUrl, { status = 200, contentType = 'text/html' } = {}) {
  globalThis.fetch = async (u) => ({
    ok: status >= 200 && status < 300,
    status,
    url: typeof finalUrl === 'function' ? finalUrl(String(u)) : finalUrl,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  });
}

// ── 1. The defect: a foreign host is an error, not a result ─────────────────
{
  serve(`<html><body>${RESULT}</body></html>`, 'https://mirror.example.net/captive');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('a body from another host is an ERROR', h.error !== null, h.error ?? 'null');
  check('and it yields no papers', h.papers.length === 0, String(h.papers.length));
  check('the error names the host we asked', /garuda\.kemdiktisaintek\.go\.id/.test(h.error ?? ''), h.error ?? '');
  check('the error names the host that answered', /mirror\.example\.net/.test(h.error ?? ''), h.error ?? '');
  check('the error says it was a redirect', /redirect/i.test(h.error ?? ''), h.error ?? '');
  // The old message blamed the parser. A redirect is not a parser break.
  check('the error does NOT say "markup changed"', !/markup changed/i.test(h.error ?? ''), h.error ?? '');
}

// ── 2. A JSON source is guarded the same way ───────────────────────────────
{
  serve('{"message":{"items":[]}}', 'https://elsewhere.example.org/x', { contentType: 'application/json' });
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a JSON source redirected to another host is an ERROR', h.error !== null, h.error ?? 'null');
  check('the JSON error names both hosts',
    /api\.crossref\.org/.test(h.error ?? '') && /elsewhere\.example\.org/.test(h.error ?? ''), h.error ?? '');
}

// ── 3. No regression: a same-host reply still parses ───────────────────────
{
  serve(`<html><body>${RESULT}</body></html>`, (u) => u);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('a reply from the host we asked is not an error', h.error === null, h.error ?? 'null');
  check('and it still parses', h.papers.length === 1, String(h.papers.length));
  check('the title survives', h.papers[0]?.title === 'A Real Title', h.papers[0]?.title ?? '(none)');
}

// ── 4. No regression: a same-host redirect (http->https, trailing slash) ───
{
  serve(`<html><body>${RESULT}</body></html>`, 'https://garuda.kemdiktisaintek.go.id/documents/?q=pendidikan');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('a same-host redirect still parses', h.error === null && h.papers.length === 1,
    h.error ?? `${h.papers.length} paper(s)`);
}

// ── 5. No regression: `www.` is the same site ──────────────────────────────
{
  serve(`<html><body>${RESULT}</body></html>`, 'https://www.garuda.kemdiktisaintek.go.id/documents?q=pendidikan');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('a www-only difference is not a different host', h.error === null && h.papers.length === 1,
    h.error ?? `${h.papers.length} paper(s)`);
}

// ── 6. No regression: a reply with no `res.url` is not a redirect ──────────
{
  serve(`<html><body>${RESULT}</body></html>`, undefined);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('an unknown final URL is not treated as a redirect', h.error === null && h.papers.length === 1,
    h.error ?? `${h.papers.length} paper(s)`);
}

globalThis.fetch = realFetch;
done('D120 getText: a redirect to another host');
