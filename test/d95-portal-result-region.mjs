// test/d95-portal-result-region.mjs — the result pattern ran over the WHOLE
// page, so any matching anchor outside the result list became a paper.
//
// THE DEFECT. `garuda`, `sinta` and `ios` matched their result pattern against
// the entire document. A sidebar "popular documents" widget, a "recently
// viewed" list and a pagination link are all ordinary anchors, so each became a
// `makePaper` record with a URL built from its id. Measured 24 Nov 2026 on
// 0.8.0, with a genuine zero-result page plus one navigation anchor:
//
//   garuda  <p>Found 0 documents</p> + <aside><a class="title-article" …>
//           -> 1 paper, "Most Downloaded Article", a real-looking URL
//   sinta   <h1>Results for "…"</h1> + <aside><a …/journals/profile/60001>
//           -> 1 paper, "Popular journal"
//   ios     <p>No Results!</p> + <nav><a href="/Record/12345" class="title">Next</a>
//           -> 1 paper titled "Next"
//
// The portal said zero and the reply said one, with a citable-looking record the
// model cannot tell from a real hit. That is worse than a false empty answer.
//
// The same page-wide scan made the "did the markup change?" guard fire on a
// sidebar anchor, so a genuine zero-result page was reported as FAILED — the
// failure the comment above `startsTextNode` forbids ("reporting a failure when
// the result is perfectly validly empty — just as misleading as hiding a
// failure"). And an anchor inside an HTML comment or a `<script>` template
// satisfied the guard even though no browser renders it as a link.
//
// WHAT MUST STILL WORK. A normal result page parses, and a real markup change is
// still an error — test/d30 pins that, and this file does not repeat it.

import { searchSource } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();
const realFetch = globalThis.fetch;

/** Serve one canned HTML body for every request. */
function serve(html) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.invalid/',
    headers: { get: () => null },
    text: async () => html,
  });
}

// ── F1: an anchor outside the result list is not a paper ──────────────────
{
  serve(`<html><body>
    <p>Found 0 documents</p>
    <aside class="popular">
      <a class="title-article" href="/documents/detail/999"><xmp>Most Downloaded Article</xmp></a>
    </aside>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a zero-result page with a sidebar anchor returns NO paper',
    h.papers.length === 0, `${h.papers.length} paper(s): ${h.papers.map((p) => p.title).join(' | ')}`);
  check('garuda: and the sidebar title never reaches the reply',
    !h.papers.some((p) => /Most Downloaded/.test(p.title ?? '')), h.papers[0]?.title ?? '(none)');
}

{
  serve(`<html><body>
    <h1>Results for "pendidikan"</h1><div class="list"></div>
    <aside><a href="https://sinta.kemdiktisaintek.go.id/journals/profile/60001">Popular journal</a></aside>
  </body></html>`);
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: a zero-result page with a sidebar profile link returns NO paper',
    h.papers.length === 0, `${h.papers.length} paper(s): ${h.papers.map((p) => p.title).join(' | ')}`);
}

{
  serve(`<html><body>
    <p>No Results!</p>
    <aside><a href="/Record/999" class="title">Recently viewed</a></aside>
  </body></html>`);
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: a zero-result page with a sidebar /Record anchor returns NO paper',
    h.papers.length === 0, `${h.papers.length} paper(s): ${h.papers.map((p) => p.title).join(' | ')}`);
}

{
  // The shape the audit predicted: a pagination link is result-shaped.
  serve(`<html><body>
    <p>No Results!</p>
    <nav><a href="/Record/12345" class="title">Next</a></nav>
  </body></html>`);
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: a "Next" pagination anchor is not a paper titled "Next"',
    h.papers.length === 0, `${h.papers.length} paper(s): ${h.papers.map((p) => p.title).join(' | ')}`);
}

// ── F6: the container guard must not fire on page chrome ──────────────────
{
  // The portal said zero; the guard must not turn that into "markup changed".
  serve(`<html><body>
    <p>Found 0 documents</p>
    <aside class="popular">
      <a class="title-article" href="/documents/detail/999"><span>Popular Doc</span></a>
    </aside>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a genuine zero-result page is a VALID empty answer, not FAILED',
    h.error === null, h.error ?? 'null');
  check('garuda: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

// ── F17: an anchor inside a comment or a script template is not a link ────
{
  serve(`<html><body>
    <p>Found 0 documents</p>
    <!-- <a class="title-article" href="/documents/detail/9"><xmp>Commented out</xmp></a> -->
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a container anchor inside an HTML COMMENT does not make the page FAILED',
    h.error === null, h.error ?? 'null');
}

{
  serve(`<html><body>
    <p>Found 0 documents</p>
    <script>var tpl = '<a class="title-article" href="/documents/detail/9"><xmp>x</xmp></a>';</script>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a container anchor inside a <script> template does not make the page FAILED',
    h.error === null, h.error ?? 'null');
}

// ── The fence must not swallow real results ───────────────────────────────
{
  serve(`<html><body>
    <div class="article-item"><a class="title-article" href="/documents/detail/1"><xmp>A Real Garuda Title</xmp></a></div>
    <div class="article-item"><a class="title-article" href="/documents/detail/2"><xmp>Another Real Garuda Title</xmp></a></div>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a normal result page still parses', h.papers.length === 2, String(h.papers.length));
  check('garuda: and the titles are the result titles',
    h.papers[0]?.title === 'A Real Garuda Title', h.papers[0]?.title ?? '(none)');
}

{
  serve(`<html><body>
    <a href="https://sinta.kemdiktisaintek.go.id/journals/profile/60001">Jurnal Pendidikan Karakter</a>
    <a href="https://sinta.kemdiktisaintek.go.id/journals/profile/60002">Jurnal Ilmu Pendidikan</a>
  </body></html>`);
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: a normal result page still parses', h.papers.length === 2, String(h.papers.length));
}

{
  serve(`<html><body>
    <a href="/Record/12345" class="title">Kumpulan Makalah Pendidikan</a>
    <a href="/Record/12346" class="title">Prosiding Seminar Nasional</a>
  </body></html>`);
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: a normal result page still parses', h.papers.length === 2, String(h.papers.length));
}

globalThis.fetch = realFetch;
done('d91 portal result region');
