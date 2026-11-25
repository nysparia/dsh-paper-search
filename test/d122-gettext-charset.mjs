// test/d122-gettext-charset.mjs — a declared charset must be honoured, not
// decoded as UTF-8.
//
// THE DEFECT. `getText` called `res.text()`, which decodes as UTF-8 and ignores
// the `charset` parameter. Measured 24 Nov 2026 (audit probe p7): a page
// declaring `charset=iso-8859-1` produced
//
//   "Pengaruh M\uFFFDdia Sosial: Jos\uFFFD Mu\uFFFDoz"
//
// U+FFFD is a character that is not in the source, and it lands in the TITLE the
// reply prints — the same "a value the platform did not report became a definite
// value" shape the rest of this file refuses. Indonesian and Portuguese titles
// carry `é`, `ñ`, `ç` routinely, so this is the common case for the three
// Indonesian portals, not an exotic one.
//
// WHAT MUST STILL WORK. No declared charset means UTF-8 (the old behaviour), and
// a charset Node cannot decode must fall back to UTF-8 rather than fail the
// source — an unknown label is not a reason to lose the page.

import { searchSource } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const realFetch = globalThis.fetch;

const TITLE = 'Pengaruh Media Sosial: José Muñoz';
const PAGE = `<html><body><a class="title-article" href="/documents/detail/1"><xmp>${TITLE}</xmp></a></body></html>`;

/**
 * Serve raw BYTES with a declared content-type.
 *
 * The body is a real stream, because that is the only path where the bytes and
 * the declared charset can disagree — a stub that hands over a JS string has
 * already been decoded by whoever built it. `text()` reproduces exactly what the
 * old code did (UTF-8 decode), so the unfixed code fails these assertions for
 * the reason the audit measured.
 */
function serveBytes(bytes, contentType) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    body: new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
    }),
    text: async () => new TextDecoder('utf-8').decode(bytes),
  });
}

/** The first title in the reply, or null. */
async function title() {
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  return { title: h.papers[0]?.title ?? null, error: h.error };
}

// ── 1. The defect: a declared latin-1 charset is honoured ──────────────────
{
  serveBytes(Buffer.from(PAGE, 'latin1'), 'text/html; charset=iso-8859-1');
  const { title: t, error } = await title();
  check('an iso-8859-1 page parses', error === null, error ?? 'null');
  check('the title is the text the server sent', t === TITLE, JSON.stringify(t));
  check('no U+FFFD is invented', !/\uFFFD/.test(t ?? ''), JSON.stringify(t));
}

// ── 2. windows-1252 is a label Node knows ─────────────────────────────────
{
  serveBytes(Buffer.from(PAGE, 'latin1'), 'text/html; charset=windows-1252');
  const { title: t } = await title();
  check('a windows-1252 page decodes', t === TITLE, JSON.stringify(t));
}

// ── 3. No regression: UTF-8 is still UTF-8 ────────────────────────────────
{
  serveBytes(Buffer.from(PAGE, 'utf8'), 'text/html; charset=UTF-8');
  const { title: t } = await title();
  check('a declared UTF-8 page decodes', t === TITLE, JSON.stringify(t));
}
{
  serveBytes(Buffer.from(PAGE, 'utf8'), 'text/html');
  const { title: t } = await title();
  check('an undeclared charset means UTF-8', t === TITLE, JSON.stringify(t));
}

// ── 4. No regression: an unknown label falls back to UTF-8 ────────────────
{
  serveBytes(Buffer.from(PAGE, 'utf8'), 'text/html; charset=x-not-a-charset');
  const { title: t, error } = await title();
  check('an unknown charset does not fail the source', error === null, error ?? 'null');
  check('an unknown charset falls back to UTF-8', t === TITLE, JSON.stringify(t));
}

globalThis.fetch = realFetch;
done('D122 getText: declared charset');
