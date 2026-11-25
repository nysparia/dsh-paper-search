// test/d93-portal-capture-bounds.mjs — an unclosed tag merged two records into
// one garbage title, a `>` inside an attribute value broke the whole page, and a
// 220-character cap turned a long journal name into a "markup change".
//
// THE DEFECTS, all measured 24 Nov 2026 on 0.8.0.
//
// 1. The title captures were lazy but UNBOUNDED — `([\s\S]*?)<\/xmp>`,
//    `([\s\S]{3,220}?)<\/a>`, `([\s\S]*?)<\/a>`. When a closing tag is missing
//    the match runs to the NEXT closing tag in the document and swallows
//    everything between two records:
//
//      <a href="/Record/1" class="title">First Paper
//      <div class="footer">Some footer text</div>
//      <a href="/Record/2" class="title">Second Paper</a>
//        -> 1 paper, "First Paper Some footer text Second Paper"
//
//    Two records became one, the second was lost, and the surviving title was
//    page chrome presented as a definite title — worse than a missing one,
//    because it looks like data and gets cited.
//
// 2. `[^>]*` in the attribute matcher stopped at the first `>`, even inside a
//    quoted value, so a valid page was reported as broken:
//
//      <a title="a > b" class="title-article" href="/documents/detail/1">…
//        -> ERROR  Garuda markup changed: the "title-article" marker is no longer found
//
// 3. The Sinta capture was capped at 220 characters, so a 282-character journal
//    name was a "markup change", and a title shorter than 3 characters was
//    silently skipped:
//
//      -> ERROR  Sinta markup changed: profile links are still present, but they
//                no longer match the result pattern
//
// The capture is now bounded by the NEXT opening tag of the same kind (so a
// nested `<b>`/`<span>` inside a title is still allowed, which the audit
// measured as working), with a generous length backstop that `truncateClean`
// still cuts to 300.

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

// ── F3: an unclosed tag must not swallow the next record ──────────────────
{
  serve(`<html><body><a href="/Record/1" class="title">First Paper
<div class="footer">Some footer text</div>
<a href="/Record/2" class="title">Second Paper</a></body></html>`);
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: an unclosed first anchor does not merge two records',
    !h.papers.some((p) => /Some footer text/.test(p.title ?? '')),
    h.papers.map((p) => p.title).join(' | ') || '(none)');
  check('ios: the second record survives with its own title',
    h.papers.some((p) => p.title === 'Second Paper'),
    h.papers.map((p) => p.title).join(' | ') || '(none)');
}

{
  serve(`<html><body><a href="https://sinta.kemdiktisaintek.go.id/journals/profile/1">Jurnal Pertama
<div>Accredited S2</div>
<a href="https://sinta.kemdiktisaintek.go.id/journals/profile/2">Jurnal Kedua</a></body></html>`);
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: an unclosed first anchor does not merge two records',
    !h.papers.some((p) => /Accredited S2/.test(p.title ?? '')),
    h.papers.map((p) => p.title).join(' | ') || '(none)');
  check('sinta: the second record survives with its own title',
    h.papers.some((p) => p.title === 'Jurnal Kedua'),
    h.papers.map((p) => p.title).join(' | ') || '(none)');
}

{
  serve(`<html><body><a class="title-article" href="/documents/detail/1"><xmp>First Title
<div>Journal A</div>
<a class="title-article" href="/documents/detail/2"><xmp>Second Title</xmp></a></body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: an unclosed <xmp> does not merge two records',
    !h.papers.some((p) => /Journal A/.test(p.title ?? '')),
    h.papers.map((p) => p.title).join(' | ') || '(none)');
  check('garuda: the second record survives with its own title',
    h.papers.some((p) => p.title === 'Second Title'),
    h.papers.map((p) => p.title).join(' | ') || '(none)');
}

// ── A nested tag inside a title is still allowed ──────────────────────────
{
  serve('<html><body><a class="title-article" href="/documents/detail/1"><xmp>Pengaruh <b>Media</b> Sosial</xmp></a></body></html>');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a nested <b> inside the title is still stripped, not rejected',
    h.papers[0]?.title === 'Pengaruh Media Sosial', h.papers[0]?.title ?? '(none)');
}

{
  serve('<html><body><a href="/Record/1" class="title"><span class="name">Jurnal Pendidikan</span></a></body></html>');
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: a nested <span> inside the title is still stripped, not rejected',
    h.papers[0]?.title === 'Jurnal Pendidikan', h.papers[0]?.title ?? '(none)');
}

// ── F15: a `>` inside a quoted attribute value ────────────────────────────
{
  serve('<html><body><a title="a > b" class="title-article" href="/documents/detail/1"><xmp>A Real Title</xmp></a></body></html>');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a ">" inside an attribute value is not a markup change',
    h.error === null, h.error ?? 'null');
  check('garuda: and the result is parsed', h.papers[0]?.title === 'A Real Title',
    h.papers[0]?.title ?? '(none)');
}

{
  serve(`<html><body><a title="a > b" href="/Record/1" class="title">A Real IOS Title</a></body></html>`);
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: a ">" inside an attribute value is not a markup change',
    h.error === null, h.error ?? 'null');
}

// ── F16: the 220-character cap ────────────────────────────────────────────
{
  // 282 characters, the length the audit measured.
  const long = 'Jurnal Ilmiah Pendidikan Matematika dan Sains Terapan Indonesia Terakreditasi Nasional Peringkat Dua dengan Fokus pada Pembelajaran Berbasis Proyek dan Penilaian Autentik di Sekolah Menengah Atas Seluruh Wilayah Indonesia Timur dan Barat serta Kepulauan Sekitarnya';
  check('the fixture really is longer than the old 220-character cap', long.length > 220, String(long.length));
  serve(`<html><body><a href="https://sinta.kemdiktisaintek.go.id/journals/profile/1">${long}</a></body></html>`);
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: a journal name longer than 220 characters is not a markup change',
    h.error === null, h.error ?? 'null');
  check('sinta: and the name is parsed', (h.papers[0]?.title ?? '').length > 220,
    String((h.papers[0]?.title ?? '').length));
}

{
  serve('<html><body><a href="https://sinta.kemdiktisaintek.go.id/journals/profile/1">Ab</a></body></html>');
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: a 2-character title is not silently skipped',
    h.papers[0]?.title === 'Ab', h.papers[0]?.title ?? '(none)');
}

globalThis.fetch = realFetch;
done('d93 portal capture bounds');
