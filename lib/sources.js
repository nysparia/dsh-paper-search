// lib/sources.js — literature source connectors for dsh-paper-search.
//
// TWO KINDS OF SOURCE, and the difference matters (do not blur it):
//
//   kind: 'api'  — public REST API that returns JSON. Stable, has a schema.
//   kind: 'html' — public web page that MUST be parsed. Fragile by nature:
//                  the operator can change the markup at any time and this parser
//                  will return 0 results. That is why its failures MUST be
//                  reported as they are (see `searchSource`), not turned
//                  into "no results".
//
// THE RULE THIS WHOLE FILE FOLLOWS: a failure must not disguise itself as
// emptiness. Every non-2xx throws an error with the status and a body snippet;
// `searchSource` catches it and returns it as `error`, separate
// from `papers`. This is the lesson from upstream `paper-search-mcp`, which
// returns `[]` for EVERY status != 200 without a trace — so an arXiv
// answering 406 looks like "no papers".

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The User-Agent carries the REAL version, read from package.json.
//
// It used to be hardcoded as `dsh-paper-search/0.1` while the package was at
// 0.6.1 — measured 23 Nov 2026. That matters beyond cosmetics: Crossref and
// OpenAlex route "polite pool" traffic by User-Agent, and a client that reports
// a version it is not running is a client the operator cannot identify when it
// misbehaves. Reading the manifest keeps the two from drifting again.
const PACKAGE_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const UA = `dsh-paper-search/${PACKAGE_VERSION} (+https://github.com/nysparia/dsh-paper-search)`;
const TIMEOUT_MS = 25000;

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function getText(url, { headers = {}, accept, timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}), ...headers },
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      // `body` is for the MESSAGE (short). `fullBody` is stored SEPARATELY so that
      // reply content that is still useful can be salvaged — measured on arXiv:
      // HTTP 406 sometimes actually carries a VALID Atom feed (issue #121).
      err.body = text.slice(0, 160).replace(/\s+/g, ' ');
      err.fullBody = text.slice(0, 512 * 1024);
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  return JSON.parse(await getText(url, { ...opts, accept: 'application/json' }));
}

// ── Uniform result shape ─────────────────────────────────────────────────────

/**
 * Named HTML entities this decoder knows.
 *
 * ── SIX WAS NOT ENOUGH (measured 24 Nov 2026 on 0.8.0) ──────────────────────
 *
 * The table held `amp lt gt quot apos nbsp`, so every other named entity
 * survived verbatim into the title:
 *
 *   "Jos&eacute; &rsquo;quoted&rsquo; &mdash; done"
 *     -> "Jos&eacute; &rsquo;quoted&rsquo; &mdash; done"
 *
 * `&rsquo;`, `&mdash;`, `&hellip;`, `&eacute;` are ordinary CMS output, not
 * exotic — a title with an apostrophe or an em dash is the common case, and the
 * user saw the entity instead of the character.
 *
 * The set below is the Latin-1 block plus the punctuation and symbol entities
 * that actually appear in bibliographic text. It is not the full HTML5 table
 * (2,231 entries, most of them mathematical); an entity outside it still
 * survives verbatim, which is the old behaviour and is visible rather than
 * wrong. Numeric entities — decimal and hex — are handled separately and cover
 * everything else.
 */
const ENTITIES = {
  // The five XML predefined entities plus the space.
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  // Latin-1 letters. `&eacute;` in a Spanish/Portuguese/French name is the case
  // that made this table necessary.
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  aelig: 'æ', ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', ntilde: 'ñ', oacute: 'ó',
  ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', uacute: 'ú',
  ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Oacute: 'Ó',
  Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Uacute: 'Ú',
  Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
  // Punctuation and symbols that appear in titles.
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  sbquo: '\u201a', bdquo: '\u201e', ndash: '\u2013', mdash: '\u2014',
  hellip: '\u2026', bull: '\u2022', middot: '\u00b7', prime: '\u2032',
  Prime: '\u2033', dagger: '\u2020', Dagger: '\u2021', sect: '\u00a7',
  para: '\u00b6', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', sup2: '\u00b2',
  sup3: '\u00b3', micro: '\u00b5', laquo: '\u00ab', raquo: '\u00bb',
  lsaquo: '\u2039', rsaquo: '\u203a', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', curren: '\u00a4', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  shy: '\u00ad', iexcl: '\u00a1', iquest: '\u00bf', ordf: '\u00aa',
  ordm: '\u00ba', not: '\u00ac', macr: '\u00af', acute: '\u00b4',
  cedil: '\u00b8', uml: '\u00a8', brvbar: '\u00a6', larr: '\u2190',
  rarr: '\u2192', harr: '\u2194', le: '\u2264', ge: '\u2265',
  ne: '\u2260', asymp: '\u2248', infin: '\u221e', minus: '\u2212',
};

/**
 * Decode HTML entities: named (`&amp;`), decimal (`&#233;`) and HEX (`&#x27;`).
 *
 * The hex form was missing entirely. The alternation used to be `#\d+|[a-z]+`,
 * and `&#x27;` is `#` followed by `x27` — which matches neither branch, so it
 * survived as literal text. Measured 24 Nov 2026: Crossref and OpenAlex return
 * `O&#x27;Brien` entity-encoded, and the surviving `;` then split the name in
 * two inside `authorList` (see the comment there).
 *
 * `String.fromCodePoint`, not `fromCharCode`: the latter truncates anything
 * above U+FFFF, so `&#x1F600;` would decode to garbage. An unparseable or
 * out-of-range code point is left as the original text rather than becoming
 * U+0000, which is what `fromCharCode(NaN)` silently produces.
 */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, k) => {
    if (k[0] === '#') {
      const hex = k[1] === 'x' || k[1] === 'X';
      const code = hex ? Number.parseInt(k.slice(2), 16) : Number(k.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[k.toLowerCase()] ?? m;
  });
}

/**
 * Strip markup, decode entities, collapse whitespace.
 *
 * ── A BARE `<` USED TO DELETE EVERYTHING UP TO THE NEXT `>` (fixed 24 Nov 2026)
 *
 * The tag pattern was `<[^>]*>`, which matches a COMPARISON as readily as a tag.
 * Measured on 0.8.0 through the Garuda connector:
 *
 *   "Pengaruh X < 5 terhadap Y > Z"  ->  "Pengaruh X Z"
 *
 * The middle of the title was deleted, silently, and `cleanText` is on the path
 * of EVERY source — not just the HTML portals. A title containing `<` is not
 * exotic: comparisons, version ranges and `<=` all produce one.
 *
 * So the pattern now requires what a tag actually starts with: a letter, `!`
 * (a comment or doctype) or `?` (an XML declaration). `< 5` starts with a space
 * and survives; `<b>`, `</b>`, `<jats:p>`, `<!-- … -->` and `<?xml … ?>` are
 * still stripped.
 *
 * The ORDER matters and is deliberate: tags are stripped BEFORE entities are
 * decoded, so `&lt;b&gt;` — which the source meant as the literal text `<b>` —
 * is not then treated as markup. `test/d29-single-clean.mjs` pins that.
 */
function cleanText(s) {
  if (!s) return null;
  return decodeEntities(String(s).replace(/<\/?[a-zA-Z!?][^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function truncate(s, n) {
  const t = cleanText(s);
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Truncate a string that has ALREADY been cleaned — no second `cleanText` pass.
 *
 * WHY THIS EXISTS (measured 24 Nov 2026). `makePaper` cleaned the title and then
 * handed it to `truncate`, which cleans AGAIN. The second pass is not a no-op:
 * the first pass has already turned `&lt;title&gt;` into a real `<title>`, so the
 * second pass strips it as markup and deletes text that is CONTENT. Measured on
 * a real Crossref record:
 *
 *   raw      "&lt;title&gt;WWW image retrieval …&lt;/title&gt;"
 *   pass 1   "<title>WWW image retrieval …</title>"
 *   pass 2   "WWW image retrieval …"          (right by accident — it was a wrapper)
 *
 * and on a title that IS the markup:
 *
 *   raw      "&lt;div&gt;"  ->  pass 1 "<div>"  ->  pass 2 ""  ->  record DROPPED
 *
 * That is exactly what the `authorList` comment above forbids: the decode happens
 * exactly ONCE, so a double-encoded `O&amp;#x27;Brien` collapses no further here
 * than it does in a title. `truncate` keeps its cleaning pass for the call sites
 * that hand it RAW text (`resolveWork`'s error message); `makePaper` uses this.
 */
function truncateClean(s, n) {
  if (!s) return null;
  if (s.length <= n) return s;
  // SLICE BY CODE POINT, NOT BY CODE UNIT. `slice` counts UTF-16 units, so a cut
  // that lands between the two halves of a surrogate pair leaves a LONE HIGH
  // SURROGATE at the end. Measured 24 Nov 2026 on 0.8.0 with a 304-unit title
  // whose 300th unit was the high half of an emoji: the result ended in
  // `\ud83d` + `…`, and a UTF-8 round trip turned it into U+FFFD — the title
  // gained a replacement character that is not in the source.
  //
  // `Array.from` splits on code points, so the cut can only land between
  // characters. The cost is one array for a string that is already being copied.
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  return `${chars.slice(0, n - 1).join('')}…`;
}

/**
 * Normalize an author list from any shape into an ARRAY of names. Never
 * throws; always returns an array (possibly empty).
 *
 * This is the answer to three upstream bugs that really happened
 * (issue #109, #110, #112): a connector passed a **string** into a field typed
 * as a list, and the consumer then `join`ed that string so every name was split
 * per character — `"TAN, Kwan Hong"` became `"T; A; N; ,;  ; K; w; a; n; …"`.
 * Other shapes that also show up in the field: arrays of objects (`{name}`,
 * `{display_name}`, `{given, family}`), and fields missing entirely.
 *
 * DELIBERATELY does NOT split on COMMAS: `"TAN, Kwan Hong"` is ONE author, and
 * splitting it would actually corrupt the name. Only semicolons are used as
 * separators.
 *
 * ORDER MATTERS: entities are decoded BEFORE the split. Every entity ends with
 * `;`, so splitting first cut an entity in half and turned ONE author into TWO.
 * Measured 24 Nov 2026 on the baseline: `"O&#x27;Brien, Sean"` became
 * `["O&#x27", "Brien, Sean"]` — a real Crossref/OpenAlex encoding of a real
 * author name. Decoding first makes the `;` inside `&#x27;` disappear before it
 * can be mistaken for a separator, while a genuine `"; "` separator survives.
 */
export function authorList(x) {
  const output = [];
  const add = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (typeof v === 'object') {
      // A nested shape that is real in the field: OpenAlex wraps authors
      // as `{ author: { display_name } }`.
      if (v.author) { add(v.author); return; }
      add(v.name ?? v.display_name ?? v.raw_author_name ?? v.fullName ?? v.fullname ?? v.full_name
        ?? [v.given, v.family].filter(Boolean).join(' '));
      return;
    }
    if (typeof v === 'string') {
      // Tag-strip and decode FIRST, then split — see the comment above. The
      // order matches `cleanText` (markup, then entities, then whitespace), and
      // the decode happens exactly ONCE: calling `cleanText` on each part would
      // decode a second time, so a double-encoded `O&amp;#x27;Brien` would
      // collapse further here than it does in a title.
      for (const part of decodeEntities(v.replace(/<[^>]*>/g, ' ')).split(';')) {
        const b = part.replace(/\s+/g, ' ').trim();
        if (b) output.push(b);
      }
      return;
    }
    const s = cleanText(v);
    if (s) output.push(s);
  };
  add(x);
  return output.slice(0, 50);
}

/**
 * Strip the punctuation a DOI picks up when it is pasted from running text:
 * a trailing `.` `,` `;` `:` and a trailing UNBALANCED `)`.
 *
 * Measured 24 Nov 2026 on the baseline: `isDoi('10.1038/nature14539.')` was
 * true and `normalizeDoi` kept the dot, so the request went to OpenAlex as
 * `doi:10.1038/nature14539.` and 404'd — and the reply then said "DOI … not
 * found in OpenAlex", which reads as "this paper does not exist".
 *
 * A `)` is NOT always punctuation: the Lancet hydroxychloroquine DOI is
 * `10.1016/S0140-6736(20)31180-6`, which ends in a balanced pair. So a `)` is
 * stripped only while the string has MORE `)` than `(` — that keeps the real
 * DOI intact while still cleaning `10.1234/foo(bar))`.
 */
function stripDoiPunctuation(d) {
  let s = d;
  for (;;) {
    const last = s.at(-1);
    if (last === '.' || last === ',' || last === ';' || last === ':') { s = s.slice(0, -1); continue; }
    if (last === ')') {
      const open = (s.match(/\(/g) ?? []).length;
      const close = (s.match(/\)/g) ?? []).length;
      if (close > open) { s = s.slice(0, -1); continue; }
    }
    return s;
  }
}

/** The DOI without its URL/`doi:` prefix and without trailing punctuation. */
function doiCore(q) {
  return stripDoiPunctuation(
    String(q ?? '').trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, ''),
  );
}

/** DOI normalized without the URL prefix — so that dedup works. */
export function normalizeDoi(doi) {
  if (!doi) return null;
  const d = doiCore(doi);
  return d.length > 3 ? d.toLowerCase() : null;
}

/**
 * Is `rest` another copy of the phrase `a` — possibly truncated, possibly with
 * different trailing punctuation or capitalization?
 *
 * Used by rule (D) of `collapseTitle` to tell "a duplicated prefix followed by
 * the rest of the title" (which must be collapsed) from "the phrase repeated"
 * (which must NOT be). Both are `a + a + something`, and the only difference is
 * what that `something` is.
 *
 * The comparison ignores case and trailing punctuation because that is exactly
 * where a repeat drifts: `"Music Education, Music Education, Music Education!"`
 * ends in `!` where the first two copies end in `,`. A truncated final copy
 * (`"Education, Education, Education"` -> rest `"Education,"`) is a copy too —
 * that is the shape the whole fix is about.
 */
function isCopyOf(rest, a) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const r = norm(rest);
  const p = norm(a);
  if (!p) return false;
  // An empty remainder is a pure repetition — rule (A)'s shape, not rule (D)'s.
  if (!r) return true;
  // A truncated copy: the remainder is a PREFIX of the phrase.
  if (p.startsWith(r)) return true;
  // A complete copy, or a copy plus the start of another.
  return r.startsWith(p);
}

/**
 * Garuda writes titles inside an <xmp> element with SEVERAL repetition shapes,
 * and repeats them to fill the display width. All four were measured 28 Sep 2026
 * from **50 real titles** (5 queries):
 *
 *   A. exact period          "X X X X X X"                         (255 characters)
 *   B. repeated after ": "   "X: X"                                (194 characters)
 *   C. prefix then "X: X"    "NLP, Machine Learning X: X"          (270 characters)
 *   D. phrase repeated at the start  "IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI …"
 *
 * What must NOT be touched — and was checked on those 50 samples: VALID titles
 * shaped "Title: subtitle", "Title: (case study)", and "Title: keywords".
 * That is why rule (c) requires the part after ": " to be genuinely THE SAME as
 * the tail of the previous part — not merely that a colon is present.
 *
 * ── THE CLAIM ABOVE WAS FALSE (found 24 Nov 2026) ───────────────────────────
 *
 * "On the 50 samples, not a single valid title was truncated" was a statement
 * about the SAMPLE, not about the code. Rule (A) tested only
 * `t[i] === t[i % p]` for `i >= p`, which never checks that the LAST copy is
 * complete — so a title that ends part-way through a repetition was read as an
 * exact doubling and cut. Measured on real Crossref records:
 *
 *   "Education, Education, Education"  (31 chars, period 11, 31 % 11 = 9)
 *     -> "Education,"                    a real book, reduced to one word
 *   "Music Education, Music Education, Music Education!"
 *     -> "Music Education, Music Education!"
 *
 * A 499-title live sweep altered 7 of 499 real Crossref titles. Rule (D) made it
 * worse: it fired on the same string and deleted one copy, and the next round
 * deleted another. Both rules now require the repetition to be COMPLETE.
 *
 * Deliberately conservative: an over-long title is better than a wrongly truncated one.
 */
export function collapseTitle(s) {
  // The period search below is O(n^2): an outer scan over n/2 candidate periods
  // and an inner scan over n characters. Measured on this machine: 5,000 chars
  // 32 ms, 20,000 chars 433 ms, 50,000 chars 2,753 ms, 100,000 chars 12,964 ms.
  // `makePaper` only truncates to 300 chars AFTER this runs, so a source that
  // returns an oversized `title` field (a full abstract, a concatenated record)
  // would stall the whole search. No real title is anywhere near this long, so
  // clamping first is free and removes the stall.
  const MAX_TITLE_CHARS = 2000;
  let t = (s ?? '').trim().slice(0, MAX_TITLE_CHARS);
  for (let round = 0; round < 4; round++) {
    const before = t;

    // (A) exact period: find the smallest period, leave one copy.
    //
    // The bound is `Math.ceil(n / 2)`, not `Math.floor(n / 2)`. For an exact
    // doubling the period is exactly n/2, and when n is ODD that is a half
    // integer — `Math.floor` then stops one short and the doubling is missed.
    // Measured 24 Nov 2026: `"Digital Literacy Digital Literacy"` (33 chars,
    // period 17) was returned unchanged, while the same title with one trailing
    // space (34 chars, trimmed to 33) collapsed. Garuda repeats titles to fill
    // the display width, so an odd-length repeat is a real case.
    //
    // Note `p <= n / 2` would NOT have fixed this: `17 <= 16.5` is false. Only
    // rounding the bound UP reaches the period.
    //
    // ── THE COMPLETENESS TEST (added 24 Nov 2026) ────────────────────────────
    //
    // `t[i] === t[i % p]` alone accepts a period that only matches because the
    // string ENDS IN THE MIDDLE of a copy: `"Education, Education, Education"`
    // (31 chars, period 11) satisfies it for every `i >= 11`, because the last
    // 9 characters are a PREFIX of the period. The title was cut to
    // `"Education,"` — a real book reduced to one word.
    //
    // So a period is accepted only when the LAST COPY IS WHOLE. With
    // `r = n % p`, the last copy is `r` characters long, and there are exactly
    // two ways it can be whole:
    //
    //   r === 0                    the copies tile the string exactly;
    //   the missing tail is        a pad whose final trailing space was removed
    //   whitespace only, AND the   by `.trim()` above, and whose period ends in
    //   period ends in a WORD      a word rather than in punctuation.
    //
    // The first half of the second case is not a loophole — it is the
    // odd-length doubling D10 fixed. `"Digital Literacy Digital Literacy "` is
    // 34 chars and `.trim()` removes the final space, leaving 33 with period 17:
    // `r = 16`, and the one missing character is the period's own trailing
    // space. Requiring `r === 0` outright would re-break that case.
    //
    // The second half is what separates a PAD from an ENUMERATION, and it is
    // the whole point of this fix. A display pad repeats a title with a SPACE
    // between copies, so its period ends in a word:
    //
    //   "Digital Literacy " × 3   -> period ends in "y"   -> a pad, collapse
    //   "IMPLEMENTASI … KARAKTER " -> period ends in "R"  -> a pad, collapse
    //
    // A period ending in punctuation followed by a space (`", "`) is a LIST
    // SEPARATOR, and `X, X, X` is a legitimate title form — the measured book
    // *Education, Education, Education*, and *Music Education, Music Education,
    // Music Education!* from the 499-title sweep. Collapsing those deletes real
    // text, so they are left alone:
    //
    //   "Education, " × 3   -> period ends in ","  -> an enumeration, keep
    //
    // The cost is that a pad of a title that itself ends in punctuation is left
    // alone. That is the conservative direction this function promises: an
    // over-long title is better than a wrongly truncated one.
    const n = t.length;
    for (let p = 10; p <= Math.ceil(n / 2); p++) {
      const r = n % p;
      if (r !== 0) {
        const tail = t.slice(r, p);
        if (tail.trim() !== '') continue;
        // The period's last non-whitespace character must be a word character.
        if (!/[a-z0-9]$/i.test(t.slice(0, p).trimEnd())) continue;
      }
      let matches = true;
      for (let i = p; i < n; i++) {
        if (t[i] !== t[i % p]) { matches = false; break; }
      }
      if (matches) { t = t.slice(0, p).trim(); break; }
    }

    // (D) phrase repeated at the start: "A A rest" -> "A rest".
    // `A` must end on a word boundary, so it does not cut mid-word.
    //
    // ── AND THE REMAINDER MUST NOT BE ANOTHER COPY (added 24 Nov 2026) ───────
    //
    // This rule was the second half of the same defect. On
    // `"Education, Education, Education"` it fired on `"Education, "` and deleted
    // one copy, and the next round then saw `"Education, Education"` — an exact
    // doubling — and cut that too. So even a title rule (A) now leaves alone was
    // eaten here. Measured on real Crossref records:
    //
    //   "Music Education, Music Education, Music Education!"
    //     -> "Music Education, Music Education!"     (one copy deleted)
    //
    // The distinction is what follows the two copies. Rule (D) exists to strip a
    // DUPLICATED PREFIX from a title that then CONTINUES (shape D above). When
    // the remainder is itself a (possibly truncated) copy of the phrase, the
    // string is not a duplicated prefix — it is the phrase repeated, and cutting
    // it destroys the title.
    //
    // "Is the remainder a copy?" is answered by comparing it to the phrase with
    // trailing punctuation and case ignored, because the last copy is exactly
    // where a repeat tends to pick up a `!` or lose a `,`. An EMPTY remainder is
    // a pure repetition too — rule (A) handles that shape, and if rule (A)
    // rejected it the repetition was not complete, so rule (D) must not cut it
    // either.
    for (let p = 8; p <= Math.floor(t.length / 2); p++) {
      const a = t.slice(0, p);
      if (!/[\s.)\]]$/.test(a)) continue;
      if (!t.startsWith(a + a)) continue;
      const rest = t.slice(2 * p);
      if (isCopyOf(rest, a)) continue;
      t = (a + rest).trim();
      break;
    }

    // (B)/(C) repeated after the last ": " — compared WITHOUT regard to upper/
    // lower case, because Garuda often repeats a title with different capitalization.
    const splitAt = t.lastIndexOf(': ');
    if (splitAt > 0) {
      const tail = t.slice(splitAt + 2).trim();
      const head = t.slice(0, splitAt).trim();
      if (tail.length >= 20 && head.toLowerCase().endsWith(tail.toLowerCase())) t = head;
    }

    if (t === before) break;
  }
  return t;
}

function makePaper(p) {
  const doi = normalizeDoi(p.doi);
  return {
    // CLEANED EXACTLY ONCE. `cleanText` decodes entities and strips tags; running
    // it a second time inside `truncate` would strip markup the FIRST pass just
    // produced from escaped text — see `truncateClean` for the measurement.
    title: truncateClean(collapseTitle(cleanText(p.title) ?? ''), 300),
    authors: authorList(p.authors).slice(0, 15),
    year: Number.isFinite(Number(p.year)) && Number(p.year) > 1500 ? Number(p.year) : null,
    source: p.source,
    doi,
    url: p.url || (doi ? `https://doi.org/${doi}` : null),
    journal: cleanText(p.journal),
    abstract: truncateClean(cleanText(p.abstract), 900),
    openAccess: !!p.openAccess,
    // The citation count is only reported by some sources (OpenAlex, Semantic Scholar).
    // `null` = UNKNOWN, and that differs from 0 — do not let consumers show it
    // as "0 citations".
    //
    // `workNumber`, NOT `Number.isFinite(Number(p.citedBy))`: `Number(null)` is
    // 0 and `Number.isFinite(0)` is TRUE, so the obvious guard turned "the source
    // did not report a count" into "0 citations". Measured 24 Nov 2026 with a
    // canned OpenAlex work carrying `cited_by_count: null`: the search path said
    // 0 while `detailOfWork` said `null` for the same work. `detailOfWork` was
    // fixed this way first; this is the same fix in the same file.
    citedBy: workNumber(p.citedBy),
    // Work type — ONLY if the source genuinely reports it. `null`
    // means "not reported", and that is DIFFERENT from "not an article": the
    // `kind` filter deliberately still shows the null ones (see `filterAndSort`).
    type: p.type ? String(p.type).toLowerCase() : null,
    // RETRACTION. Only OpenAlex reports it, and only `paper_detail` used to show
    // it — the SEARCH path dropped the flag, so a retracted paper came back
    // looking like any other result. Measured 24 Nov 2026 with a mocked OpenAlex
    // reply for the retracted Lancet hydroxychloroquine paper: the search record
    // had no `isRetracted` field at all. `sources.js:604-634` calls that the
    // worst possible failure mode — a retracted paper is exactly the paper a
    // reader most needs to be warned about — so the flag is carried here and
    // `formatResult` prints the warning. It is NEVER used to filter.
    isRetracted: p.isRetracted === true,
  };
}

// ── INTERNATIONAL sources (JSON API) ─────────────────────────────────────────

/**
 * The Crossref fields this plugin asks for.
 *
 * `is-referenced-by-count` was MISSING (fixed 24 Nov 2026), so Crossref never
 * returned it and `citedBy` was always `null` for `crossref`, `acm` and `ieee`.
 * Crossref does report it and it IS selectable — verified live on real records:
 * 18, 57 and 4641 citations on three works. The consequence was that
 * `min_citations` silently emptied those three sources:
 *
 *   Filter: citations >= 100 — 0 below the threshold · 2 DROPPED because the
 *   source does not report a citation count.
 *
 * The reply was honest about the drop, but the cause was this `select` list, not
 * a platform limitation — and the registry `note` for `ieee` claimed the
 * opposite ("citation counts ARE present"). Both are now true.
 */
const CROSSREF_FIELDS = 'DOI,title,container-title,author,issued,abstract,URL,type,is-referenced-by-count';

/**
 * Translate `kind` (our vocabulary: article/review/preprint) into Crossref's
 * vocabulary. Crossref **has no** "review" kind — review articles there are
 * still `journal-article` — so a `review` request is deliberately NOT forced:
 * filtering it with `journal-article` would return ALL articles, which is the
 * opposite of what was asked. `review` filtering happens after the results
 * arrive, from a field the source genuinely reports.
 *
 * The same filter is written REPEATEDLY for several kinds — that is how Crossref
 * expresses OR on a single field.
 */
function crossrefFilter(kind) {
  const map = { article: 'journal-article', preprint: 'posted-content' };
  const t = (kind ?? []).map((j) => map[j]).filter(Boolean);
  return t.length ? t.map((x) => `type:${x}`).join(',') : null;
}

/**
 * One Crossref item -> one paper. USED BY THREE SOURCES (`crossref`, `acm` and
 * `ieee`), so they cannot drift apart from each other.
 */
function fromCrossrefItem(it, source) {
  return makePaper({
    title: it.title?.[0],
    authors: authorList(it.author),
    year: it.issued?.['date-parts']?.[0]?.[0],
    source,
    doi: it.DOI,
    url: it.URL,
    type: it.type,
    journal: it['container-title']?.[0],
    abstract: it.abstract,
    // `workNumber` inside `makePaper` keeps a missing count as `null`; Crossref
    // omits the field entirely for works nobody has cited yet, and that is a
    // real 0 only when the field is present and says 0.
    citedBy: it['is-referenced-by-count'],
  });
}

async function crossref(query, { rows, email, kind = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  u.searchParams.set('select', CROSSREF_FIELDS);
  const kindFilter = crossrefFilter(kind);
  if (kindFilter) u.searchParams.set('filter', kindFilter);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => fromCrossrefItem(it, 'crossref')).filter((p) => p.title);
}

/**
 * ACM Digital Library — via Crossref, filtered to the DOI prefix `10.1145`.
 * **Without an API key.** This adopts upstream PR **#123**: there `acm.py` is a
 * skeleton that always throws `NotImplementedError`, so the source could never
 * be brought to life with a key (`PAPER_SEARCH_MCP_ACM_API_KEY` could never be
 * filled with a valid value). ACM has no public search API — but its entire
 * output is registered in Crossref under a single DOI prefix, and that prefix
 * can be filtered.
 *
 * Measured 28 Sep 2026: `filter=prefix:10.1145` answers HTTP 200 and **every**
 * result carries a `10.1145/…` DOI (7.6 million works in Crossref).
 *
 * What is DELIBERATELY **NOT** CLAIMED: that the results are open access. Upstream
 * PR #123 says ACM DL has been open since 1 Jan 2026, but **re-measured here**:
 * `HEAD https://dl.acm.org/doi/pdf/<2026 doi>` answers **HTTP 403**, and only
 * **9 of 20** ACM 2026 publications have a `license` field in Crossref. So
 * `openAccess` is left as it is (false) — a source that claims OA without
 * evidence is worse than one that does not claim it.
 */
async function acm(query, { rows, email, kind = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  const kindFilter = crossrefFilter(kind);
  // The literal form `'prefix:10.1145'` is DELIBERATELY preserved: an old test
  // checks exactly that string, and the `kind` filter is only APPENDED behind it —
  // deviating from that form would blind the guard for no reason.
  u.searchParams.set('filter', 'prefix:10.1145' + (kindFilter ? `,${kindFilter}` : ''));
  u.searchParams.set('select', CROSSREF_FIELDS);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => fromCrossrefItem(it, 'acm')).filter((p) => p.title);
}

/** OpenAlex stores abstracts as an inverted index — it must be reassembled. */
/**
 * OpenAlex's `abstract_inverted_index` -> a plain string, or `null`.
 *
 * The index maps each word to the positions it occupies, so the abstract is
 * rebuilt by writing each word at its positions and reading the array back.
 *
 * ── A MALFORMED INDEX USED TO CRASH THE TOOL (fixed 24 Nov 2026) ────────────
 *
 * The body was four lines: `for (const i of idxs) pos[i] = word`. Measured on
 * 0.8.0 with a reply whose positions were a NUMBER instead of an array:
 *
 *   { abstract_inverted_index: { word: 5 } }
 *     -> TypeError: idxs is not iterable
 *
 * and that throw came out of `paper_detail` — a tool whose only documented
 * throws are for invalid ARGUMENTS. A malformed third-party reply must never
 * take the tool down.
 *
 * ── AND A PARTIAL REBUILD IS NOT AN ABSTRACT ────────────────────────────────
 *
 * The same expression silently DROPPED words at positions that are not array
 * indices: `{ a: [-1], b: [0] }` produced "b", and `{ a: [1e9], b: [0] }`
 * produced "b a" from a sparse array a billion elements long. A partial abstract
 * reads as the paper's abstract, which is a wrong answer rather than a missing
 * one — the same rule `workNumber` exists for.
 *
 * So the index is VALIDATED first. Anything that is not an array of
 * non-negative integers below `ABSTRACT_MAX_POSITION` makes the whole abstract
 * `null`, and the caller then says "OpenAlex has no abstract for this work" —
 * which is true: we could not build one.
 */
const ABSTRACT_MAX_POSITION = 10000;

function openAlexAbstract(inv) {
  if (!inv || typeof inv !== 'object' || Array.isArray(inv)) return null;
  const entries = Object.entries(inv);
  if (entries.length === 0) return null;
  const pos = [];
  for (const [word, idxs] of entries) {
    if (!Array.isArray(idxs)) return null;
    for (const i of idxs) {
      if (!Number.isInteger(i) || i < 0 || i >= ABSTRACT_MAX_POSITION) return null;
      pos[i] = word;
    }
  }
  const text = pos.filter(Boolean).join(' ').trim();
  return text || null;
}

/** One OpenAlex work -> the uniform paper shape. Used by search AND the citation graph. */
function fromOpenAlexWork(w, source = 'openalex') {
  return makePaper({
    title: w.title,
    authors: authorList(w.authorships),
    year: w.publication_year,
    source,
    doi: w.doi,
    url: w.doi || w.id,
    journal: w.primary_location?.source?.display_name,
    abstract: openAlexAbstract(w.abstract_inverted_index),
    openAccess: !!w.open_access?.is_oa,
    citedBy: w.cited_by_count,
    type: w.type,
    // The search request sets no `select`, so the full work arrives and this
    // flag is already in the reply — it was simply never carried through.
    isRetracted: w.is_retracted === true,
  });
}

async function openalex(query, { rows, email, apiKey = null, minCitations = null, kind = null }) {
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', query);
  u.searchParams.set('per-page', String(rows));
  // Push-down: the citation threshold and the kind are handled by OpenAlex itself,
  // so that `max_results` is still filled with results that PASSED the filter —
  // not trimmed after arrival (which leaves only a few results).
  const filter = [];
  if (Number.isFinite(minCitations) && minCitations > 0) filter.push(`cited_by_count:>${Math.max(0, Math.floor(minCitations) - 1)}`);
  const t = (kind ?? []).filter((j) => ['article', 'review', 'preprint'].includes(j));
  if (t.length) filter.push(`type:${t.join('|')}`);
  if (filter.length) u.searchParams.set('filter', filter.join(','));
  if (email) u.searchParams.set('mailto', email);
  if (apiKey) u.searchParams.set('api_key', String(apiKey));
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((w) => fromOpenAlexWork(w)).filter((p) => p.title);
}

// ── OpenAlex citation graph (upstream PR #96) ────────────────────────────────
//
// THREE things PR #96 added upstream, and here they are realized as
// TWO tools + one `paper_oa` function:
//   get_citing_papers     -> `paper_citations` direction "citing"
//   get_referenced_papers -> `paper_citations` direction "references"
//   find_open_access_pdf  -> `paper_oa`
//
// Why NOT three separate tools like upstream: every registered tool is also sent
// BACK to the model on EVERY request. Upstream does not count that cost (PR #97
// there exposes 57 tools). Here the two citation directions share
// one schema because their input shape is identical.

const OPENALEX = 'https://api.openalex.org';

/** Limit on how many references are actually fetched — a cost fence, not an API limit. */
export const REFERENCE_LIMIT = 100;

/**
 * Build an OpenAlex URL.
 *
 * TWO optional credentials, and they do different things:
 *
 *   `apiKey` — the real lever. Sent as the `api_key` query parameter (OpenAlex
 *     also accepts `Authorization: Bearer`, but the query parameter keeps this
 *     function's shape identical to the `mailto` handling that was already here).
 *     A free key raises the daily budget 10x and the per-second limit from 10 to
 *     30, and it is REQUIRED for cursor paging past the first page. Measured
 *     23 Nov 2026: `?api_key=FAKE` answers HTTP 401 "API key not found", so a
 *     wrong key is reported rather than silently ignored.
 *
 *   `email` — `mailto`, the old "polite pool" convention. Kept because it costs
 *     nothing and some deployments still set it, but it is NOT what raises the
 *     limit any more: the current OpenAlex authentication docs do not mention
 *     `mailto` at all, and the 429 body names the missing KEY as the reason.
 *     The error message below used to claim otherwise and was wrong.
 */
function openAlexUrl(path, params = {}, email, apiKey = null) {
  const u = new URL(OPENALEX + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (email) u.searchParams.set('mailto', email);
  if (apiKey) u.searchParams.set('api_key', String(apiKey));
  return u.toString();
}

/**
 * All OpenAlex calls go through here so that the error messages are consistent.
 * HTTP 429 from OpenAlex is **transient** and has been measured several times in
 * this project; a raw "HTTP 429" does not tell the consumer what to do.
 * 404 is deliberately NOT translated here — each caller has its own, more
 * precise message (DOI vs OpenAlex id vs title).
 */
async function openAlexJson(path, params, email, apiKey = null) {
  try {
    return await getJson(openAlexUrl(path, params, email, apiKey));
  } catch (e) {
    if (e?.status === 429) {
      // The advice depends on whether a key is already in use: telling someone
      // who HAS a key to "set a key" is useless, and telling someone without one
      // to "wait 10 seconds" hides the actual fix.
      throw new Error(apiKey
        ? 'OpenAlex is rate-limiting (HTTP 429) — the daily budget or the per-second limit is spent. Check it with GET https://api.openalex.org/rate-limit?api_key=… ; the daily budget resets at midnight UTC.'
        : 'OpenAlex is rate-limiting (HTTP 429) — without an API key the daily budget is shared by everyone on this network\'s IP address. Set OPENALEX_API_KEY (free: https://openalex.org/settings/api-key) for a 10x budget and 30 req/s instead of 10.');
    }
    if (e?.status === 401) {
      // A wrong key must not look like a transient failure.
      throw new Error('OpenAlex rejected the API key (HTTP 401) — check OPENALEX_API_KEY. A key only works after its email address is verified.');
    }
    // Measured 29 Sep 2026: `works/doi:…` was once answered with HTTP 504
    // "Gateway timeout" plus an explanatory JSON body (`reason: query_timeout`).
    // Untranslated, the consumer only sees "HTTP 504" without knowing
    // that it is transient and simply needs a retry.
    if (e?.status === 504 || e?.status === 503) {
      throw new Error(`OpenAlex is slow right now (HTTP ${e.status}) — this is transient, retry in a moment`);
    }
    throw e;
  }
}

/** Short OpenAlex id: "https://openalex.org/W123" -> "W123". */
export function workId(w) {
  return String(w?.id ?? '').split('/').pop() || null;
}

/** Is this input an OpenAlex id (W…), not a DOI and not a title? */
export function isWorkId(t) {
  return /^(?:https?:\/\/openalex\.org\/)?W\d+$/i.test(String(t ?? '').trim());
}

/** Summary of one OpenAlex work — used by the citation-graph & OA output header. */
export function summarizeWork(w) {
  return {
    id: workId(w),
    title: cleanText(w?.title),
    year: w?.publication_year ?? null,
    doi: normalizeDoi(w?.doi),
    journal: cleanText(w?.primary_location?.source?.display_name),
    authors: authorList(w?.authorships),
    // `workNumber`, not `Number.isFinite(Number(…))` — see the note in
    // `makePaper`. `Number(null)` is 0, so the obvious guard reported an
    // unreported count as "0 citations" in the citation-graph header too.
    citedBy: workNumber(w?.cited_by_count),
  };
}

/**
 * DOI / OpenAlex id / TITLE -> ONE OpenAlex work.
 *
 * A title is accepted because the model often only has the title. But selecting
 * by title can be WRONG — measured 28 Sep 2026: the title query
 * *"Attention is all you need"* returned `W2626778328`, a duplicate record with a
 * strange DOI, not the original record. That is why the caller MUST
 * show the work that was actually selected (see `summarizeWork`), so that a
 * wrong pick is visible rather than disguised.
 */
export async function resolveWork(identifier, { email, apiKey = null } = {}) {
  const t = String(identifier ?? '').trim();
  if (!t) throw new Error('identifier is required: DOI (10.…), OpenAlex id (W…), or paper title');

  if (isWorkId(t)) {
    const id = t.split('/').pop();
    try {
      return await openAlexJson(`/works/${id}`, {}, email, apiKey);
    } catch (e) {
      if (e.status === 404) throw new Error(`OpenAlex id ${id} not found`);
      throw e;
    }
  }

  // IMPORTANT: what decides "this is a DOI" is `isDoi()`, NOT `normalizeDoi()`.
  // `normalizeDoi()` only strips the URL prefix and then checks the length — it
  // accepts ALMOST any text, so using it here would treat every title as a DOI
  // (caught by the smoke test 29 Sep 2026: "zzzqqqxxyy cannot possibly exist" was
  // answered with "DOI … not found" instead of being searched as a title).
  // `normalizeDoi()` is used AFTER it passes, to strip the `https://doi.org/` prefix.
  const doi = isDoi(normalizeDoi(t) ?? '') ? normalizeDoi(t) : null;
  if (doi) {
    try {
      return await openAlexJson(`/works/doi:${encodeURI(doi)}`, {}, email, apiKey);
    } catch (e) {
      // OpenAlex's 404 is an HTML page, not JSON — the message must be
      // translated, otherwise the consumer sees "<!doctype html>".
      if (e.status === 404) throw new Error(`DOI ${doi} not found in OpenAlex — try giving its title, or check the DOI`);
      throw e;
    }
  }

  const j = await openAlexJson('/works', { search: t, 'per-page': 1 }, email, apiKey);
  const w = j?.results?.[0];
  if (!w) throw new Error(`no OpenAlex work matches "${truncate(t, 80)}"`);
  return w;
}

// ── Single-work DETAIL (the free replacement for a billed S2 detail call) ────
//
// WHY THIS EXISTS. `get_semantic_paper_detail` was the single most expensive
// tool in this machine's history: 60 calls / 60 credits, 31% of all billed
// spend, and 15 of them were CONSECUTIVE calls that a single batch would have
// answered for 2 credits. OpenAlex carries the same metadata for free, so the
// detail lookup belongs here rather than behind a credit meter.
//
// WHAT OPENALEX DOES *NOT* HAVE, and therefore what this cannot return:
//   · the Semantic Scholar `paperId` / `corpusId` / S2 URL — those exist only
//     in S2's own graph. A caller that needs to chain into another S2 tool must
//     still resolve the paper there.
//   · citation CONTEXTS and INTENTS (the sentence that cites, and whether the
//     citation is background/method/result). OpenAlex stores only the edge.
//   · SPECTER2 embeddings and TLDR summaries.
// Everything else — title, authors, year, date, venue, citation count, DOI,
// PMID, PMCID, abstract, OA locations, topics, retraction flag — is here.

/**
 * The fields a detail reply needs. `select` is not cosmetic: a full OpenAlex
 * work carries 59 fields (measured 23 Nov 2026), most of them irrelevant to a
 * reader, and the abstract alone can be several kB.
 */
const DETAIL_FIELDS = [
  'id', 'doi', 'title', 'display_name', 'publication_year', 'publication_date',
  'type', 'cited_by_count', 'authorships', 'primary_location', 'best_oa_location',
  'locations', 'open_access', 'ids', 'abstract_inverted_index',
  'referenced_works_count', 'is_retracted', 'language', 'biblio',
  'topics', 'keywords', 'fwci', 'citation_normalized_percentile',
].join(',');

/**
 * Parse ONE identifier into the OpenAlex filter prefix it belongs to.
 *
 * Returns `{ prefix, value }` or `null` when the input is not an identifier at
 * all (a title, say) — the caller then falls back to a search.
 *
 * The five prefixes are the ones OpenAlex actually accepts in `filter=`. They
 * were each verified against the live API on 23 Nov 2026:
 *   doi:10.3390/info15060294|10.1038/…      -> 200, 2 works
 *   pmid:37074525|36568739                  -> 200, 2 works
 *   pmcid:PMC8371605|PMC10113978            -> 200, 2 works
 *   arxiv:1706.03762|2106.12345             -> 200, 2 works
 *   openalex_id:W3177828909|W4398222754     -> 200, 2 works
 *
 * MIXING prefixes in one filter is NOT allowed — OpenAlex answers HTTP 400
 * ("trying to do an OR query between filters"). Measured 23 Nov 2026. So a
 * mixed batch must be split into one request per prefix, which is what
 * `resolveWorks` does.
 */
export function parseIdentifier(input) {
  const t = String(input ?? '').trim();
  if (!t) return null;

  // OpenAlex id: W123, or the full https://openalex.org/W123 URL.
  if (isWorkId(t)) return { prefix: 'openalex_id', value: t.split('/').pop() };

  // Explicit prefixes the model may pass through from another tool's output.
  const explicit = /^(doi|pmid|pmcid|arxiv|openalex_id)\s*:\s*(.+)$/i.exec(t);
  if (explicit) {
    const prefix = explicit[1].toLowerCase();
    const value = explicit[2].trim();
    if (!value) return null;
    if (prefix === 'doi') return isDoi(value) ? { prefix, value: normalizeDoi(value) } : null;
    if (prefix === 'arxiv') {
      const a = isArxivId(value);
      return a ? { prefix, value: a.id } : null;
    }
    if (prefix === 'openalex_id') return isWorkId(value) ? { prefix, value: value.split('/').pop() } : null;
    // pmid / pmcid: digits, or PMC-prefixed for pmcid.
    if (prefix === 'pmcid') {
      const m = /^(?:pmc)?(\d+)$/i.exec(value);
      return m ? { prefix, value: `PMC${m[1]}` } : null;
    }
    return /^\d+$/.test(value) ? { prefix, value } : null;
  }

  // A bare DOI.
  if (isDoi(t)) return { prefix: 'doi', value: normalizeDoi(t) };

  // A bare arXiv id (1706.03762 / arXiv:1706.03762v2).
  const a = isArxivId(t);
  if (a) return { prefix: 'arxiv', value: a.id };

  // A bare PMCID (`PMC8371605`). The tool description promises this format
  // (`lib/index.js:991` and `:1000`), but only the explicit `pmcid:` prefix was
  // accepted, so a bare `PMC…` fell through to a TITLE search that usually
  // missed. Measured 24 Nov 2026: `parseIdentifier('PMC8371605')` returned null.
  // This is safe to accept because `PMC` + digits is unambiguous — unlike a bare
  // number, which is deliberately NOT guessed (see the comment below).
  const pmc = /^(?:pmc)(\d+)$/i.exec(t);
  if (pmc) return { prefix: 'pmcid', value: `PMC${pmc[1]}` };

  // A bare PMID / PMCID is deliberately NOT guessed from digits alone: a bare
  // number is far more likely to be a year, a count, or a typo than a PMID, and
  // silently querying `pmid:2024` would return a wrong paper with no warning.
  return null;
}

/**
 * Many identifiers -> many OpenAlex works, in as few requests as possible.
 *
 * Grouped by prefix because OpenAlex rejects a mixed-prefix OR (HTTP 400,
 * measured 23 Nov 2026). At most 50 values per request — the same fence
 * `worksFromIds` uses, and well under OpenAlex's own URL limit.
 *
 * ── THE RETRACTED-WORK TRAP (found 23 Nov 2026, the hard way) ───────────────
 *
 * OpenAlex's LIST endpoint (`/works?filter=…`) **silently omits retracted
 * works** unless `is_retracted:true` is added to the filter. The single-work
 * endpoint (`/works/doi:…`) does NOT — it returns them normally.
 *
 * Measured with `10.1016/S0140-6736(20)31180-6` (the retracted
 * hydroxychloroquine Lancet paper):
 *
 *   GET /works/doi:10.1016/S0140-6736(20)31180-6        -> 200, is_retracted: true
 *   GET /works?filter=doi:10.1016/S0140-6736(20)31180-6 -> 200, count: 0
 *   GET /works?filter=openalex_id:W3027680906           -> 200, count: 0
 *   GET /works?filter=openalex_id:W3027680906,is_retracted:true -> 200, count: 1
 *
 * There are **91,863** retracted works in OpenAlex (measured the same day), and
 * every one of them was invisible to a batch lookup. That is the worst possible
 * failure mode for this tool: a retracted paper is exactly the paper a reader
 * most needs to be warned about, and the batch would have reported it as
 * "not found in OpenAlex" — which the reply explicitly says does NOT mean the
 * paper does not exist, but which a reader would reasonably read as "no record".
 *
 * FIX: every batch request asks for retracted works too, and the reply keeps
 * the `is_retracted` flag so `detailLines` can print the warning.
 *
 * Returns `{ works, requests, unresolved }`:
 *   · `works`      — the OpenAlex records that were found, in request order;
 *   · `requests`   — how many HTTP calls this actually cost (reported to the
 *                    caller so a "free" claim stays honest);
 *   · `unresolved` — the inputs OpenAlex had no record for, so the caller can
 *                    say WHICH one is missing instead of silently returning a
 *                    shorter list.
 */
export async function resolveWorks(inputs, { email, apiKey = null } = {}) {
  const parsed = [];
  const unresolved = [];
  for (const raw of inputs ?? []) {
    const p = parseIdentifier(raw);
    if (p) parsed.push({ raw, ...p });
    else unresolved.push(String(raw ?? ''));
  }

  const groups = new Map();
  for (const p of parsed) {
    if (!groups.has(p.prefix)) groups.set(p.prefix, []);
    groups.get(p.prefix).push(p);
  }

  const works = [];
  let requests = 0;
  for (const [prefix, items] of groups) {
    // De-duplicate within the group: the same DOI twice must not be fetched twice.
    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const key = it.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const ids = chunk.map((c) => c.value).join('|');

      // TWO requests per chunk, and both are necessary.
      //
      // `is_retracted:true` is AND-ed with the identifier filter, NOT OR-ed —
      // measured 23 Nov 2026 with one retracted and one normal DOI:
      //   filter=doi:A|B                  -> 1 work  (the NORMAL one)
      //   filter=doi:A|B,is_retracted:true -> 1 work  (the RETRACTED one)
      // So neither request alone sees both. The first finds the ordinary works,
      // the second finds the retracted ones, and the union is the truth.
      //
      // This doubles the request count for a batch. That is the correct trade:
      // the alternative is silently reporting a retracted paper as "not found",
      // which is the one error this tool must never make.
      const found = [];
      for (const extra of ['', ',is_retracted:true']) {
        const j = await openAlexJson('/works', {
          filter: `${prefix}:${ids}${extra}`, 'per-page': chunk.length, select: DETAIL_FIELDS,
        }, email, apiKey);
        requests += 1;
        for (const w of j?.results ?? []) {
          // The two requests are disjoint by construction, but a work can be
          // returned twice if OpenAlex ever changes that — keep it once.
          if (!found.some((x) => String(x?.id) === String(w?.id))) found.push(w);
        }
      }
      works.push(...found);
      // Anything neither request returned is genuinely absent from OpenAlex.
      // Matched by the id field the prefix refers to, NOT by position: OpenAlex
      // does not promise to preserve the order of an OR filter.
      if (found.length < chunk.length) {
        for (const c of chunk) {
          if (!found.some((w) => identifierMatches(w, prefix, c.value))) unresolved.push(c.raw);
        }
      }
    }
  }
  return { works, requests, unresolved };
}

/**
 * Does this OpenAlex work carry the given identifier? Used to detect misses.
 *
 * ── A VERSIONED arXiv ID NEVER MATCHED (fixed 24 Nov 2026) ──────────────────
 *
 * `isArxivId` keeps the version suffix — its own doc comment shows
 * `arXiv:1706.03762v2` as an accepted input — but OpenAlex stores `ids.arxiv`
 * WITHOUT it (`https://arxiv.org/abs/1706.03762`). The equality test therefore
 * could never succeed for a versioned id, and `resolveWorks` uses this test to
 * decide what is missing, so the work was returned AND listed as absent:
 *
 *   1. FIRST paper the caller asked for
 *      arXiv: 1706.03762 · OpenAlex: W1
 *
 *   NOT FOUND in OpenAlex (2):
 *     · arXiv:1706.03762v2
 *     · arXiv:9999.99999
 *   These are genuinely absent from OpenAlex — …
 *
 * The same broken test drives the caller-order restoration in `lib/index.js`, so
 * a batch containing a versioned id also came back in the wrong order. Measured
 * live: OpenAlex ACCEPTS `filter=arxiv:1706.03762v2` and returns the work, so
 * only the match test was wrong — the lookup itself succeeds.
 *
 * The version suffix is stripped on BOTH sides, so a work whose `ids.arxiv`
 * happens to carry a version still matches a bare id.
 */
export function identifierMatches(work, prefix, value) {
  const v = String(value ?? '').toLowerCase();
  if (prefix === 'openalex_id') return String(work?.id ?? '').split('/').pop().toLowerCase() === v;
  if (prefix === 'doi') return normalizeDoi(work?.doi) === v;
  if (prefix === 'pmid') return String(work?.ids?.pmid ?? '').split('/').pop() === v;
  if (prefix === 'pmcid') return String(work?.ids?.pmcid ?? '').split('/').pop().toLowerCase() === v;
  if (prefix === 'arxiv') {
    const bare = (x) => String(x ?? '').split('/').pop().toLowerCase().replace(/v\d+$/, '');
    return bare(work?.ids?.arxiv) === bare(v);
  }
  return false;
}

/**
 * A number from a work, or `null` when the source did NOT report one.
 *
 * `Number(null)` is **0** and `Number.isFinite(0)` is TRUE, so the obvious
 * `Number.isFinite(Number(x))` guard silently turns "not reported" into "zero".
 * That is the difference between "this paper has no citations yet" and "OpenAlex
 * does not say" — and the second must never be printed as the first.
 *
 * `lib/index.js` has an identical helper for the search path; this copy exists
 * because `sources.js` deliberately imports nothing from `index.js` (the
 * dependency runs the other way).
 */
function workNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * ONE OpenAlex work -> the full detail record the model reads.
 *
 * Deliberately NOT `summarizeWork`: that shape is the compact header used by the
 * citation graph, and it drops the abstract, the ids, the topics and the OA
 * locations — exactly the fields a detail reply exists to provide.
 */
export function detailOfWork(w) {
  const ids = w?.ids ?? {};
  const shortId = (u) => (u ? String(u).split('/').pop() : null);
  const authors = (w?.authorships ?? []).map((a) => ({
    name: cleanText(a?.author?.display_name) ?? null,
    orcid: a?.author?.orcid ?? null,
    institutions: (a?.institutions ?? []).map((i) => cleanText(i?.display_name)).filter(Boolean),
    corresponding: a?.is_corresponding === true,
  })).filter((a) => a.name);

  const oa = summarizeOA(w);
  const biblio = w?.biblio ?? {};
  const percentile = w?.citation_normalized_percentile;

  return {
    id: workId(w),
    doi: normalizeDoi(w?.doi),
    title: cleanText(w?.title ?? w?.display_name),
    year: w?.publication_year ?? null,
    date: w?.publication_date ?? null,
    type: w?.type ? String(w.type).toLowerCase() : null,
    language: w?.language ?? null,
    venue: cleanText(w?.primary_location?.source?.display_name),
    publisher: cleanText(w?.primary_location?.source?.host_organization_name),
    // `Number(null)` is 0 and `Number.isFinite(0)` is TRUE, so the obvious
    // `Number.isFinite(Number(x))` guard turns "OpenAlex did not report a count"
    // into "0 citations" — a claim the data does not support. Measured 23 Nov
    // 2026: a work with `cited_by_count: null` printed "cited 0 times".
    // `workNumber()` exists for exactly this and is used here now.
    citedBy: workNumber(w?.cited_by_count),
    // `fwci` is OpenAlex's field-weighted citation impact: 1.0 = world average
    // for that field/year. Reported as-is, never rounded into a verdict.
    fwci: workNumber(w?.fwci),
    percentile: workNumber(percentile?.value),
    isRetracted: w?.is_retracted === true,
    authors,
    abstract: openAlexAbstract(w?.abstract_inverted_index),
    biblio: {
      volume: biblio?.volume ?? null,
      issue: biblio?.issue ?? null,
      firstPage: biblio?.first_page ?? null,
      lastPage: biblio?.last_page ?? null,
    },
    ids: {
      openalex: workId(w),
      doi: normalizeDoi(w?.doi),
      pmid: shortId(ids?.pmid),
      pmcid: shortId(ids?.pmcid),
      arxiv: shortId(ids?.arxiv),
      mag: ids?.mag ?? null,
    },
    topics: (w?.topics ?? []).slice(0, 5).map((t) => cleanText(t?.display_name)).filter(Boolean),
    keywords: (w?.keywords ?? []).slice(0, 8).map((k) => cleanText(k?.display_name)).filter(Boolean),
    referenceCount: workNumber(w?.referenced_works_count),
    openAccess: oa,
  };
}

/**
 * The OpenAlex fields the citation map needs. `referenced_works` MUST be there —
 * that is the input for the coupling computation — and `select` keeps the reply
 * small (measured 2 Oct 2026: ~52 kB for 50 works complete with their reference
 * lists, versus hundreds of kB without `select`).
 *
 * `referenced_works_count` is what the work HAS, as opposed to what came back.
 * Without it a truncated reference list is indistinguishable from a short one:
 * measured 24 Nov 2026, a container record with 400 real references returned 100,
 * and the map's container warning stayed silent because 100 is not a long list.
 */
const MAP_FIELDS = 'id,doi,title,publication_year,cited_by_count,referenced_works,referenced_works_count';

/**
 * Candidates for the CITATION MAP (upstream issue #122) — works that cite the
 * seed, or the seed's references — COMPLETE with their `referenced_works`.
 *
 * Returns RAW works, not the uniform paper shape: the map needs each work's
 * reference list, and the uniform shape deliberately does not store it.
 *
 * Deliberate cost fence: at most 50 candidates and at most ONE list request
 * (those works are fetched all at once via `filter=openalex_id:W1|W2|…`,
 * not one by one).
 */
export async function mapCandidates(work, { direction = 'citing', max = 40, email, apiKey = null } = {}) {
  const id = workId(work);
  if (!id) throw new Error('this work has no OpenAlex id — the citation map cannot run');
  const limit = Math.min(Math.max(Number(max) || 40, 2), 50);

  if (direction === 'references') {
    const all = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
    const ids = all.slice(0, limit).map((x) => String(x).split('/').pop()).filter(Boolean);
    if (ids.length === 0) return { works: [], total: all.length, checked: 0, requests: 0 };
    const j = await openAlexJson('/works', { filter: `openalex_id:${ids.join('|')}`, 'per-page': ids.length, select: MAP_FIELDS }, email, apiKey);
    return { works: j?.results ?? [], total: all.length, checked: ids.length, requests: 1 };
  }

  const j = await openAlexJson('/works', { filter: `cites:${id}`, sort: 'cited_by_count:desc', 'per-page': limit, select: MAP_FIELDS }, email, apiKey);
  return { works: j?.results ?? [], total: Number(j?.meta?.count ?? 0), checked: limit, requests: 1 };
}

/**
 * Works by a list of OpenAlex ids — used to give TITLES to shared references
 * (which appear in the map only as ids). One request, at most 50 ids.
 */
export async function worksFromIds(ids, { email, apiKey = null } = {}) {
  const clean = [...new Set((ids ?? []).map((x) => String(x).split('/').pop()).filter(Boolean))].slice(0, 50);
  if (clean.length === 0) return [];
  const j = await openAlexJson('/works', { filter: `openalex_id:${clean.join('|')}`, 'per-page': clean.length, select: MAP_FIELDS }, email, apiKey);
  return j?.results ?? [];
}

/** Works that CITE a work — forward snowballing. */
export async function worksCiting(work, { rows = 10, sort = 'citations', email, apiKey = null } = {}) {
  const id = workId(work);
  if (!id) throw new Error('this work has no OpenAlex id — citation traversal cannot run');
  const order = sort === 'newest' ? 'publication_date:desc' : 'cited_by_count:desc';
  const j = await openAlexJson('/works', { filter: `cites:${id}`, sort: order, 'per-page': rows }, email, apiKey);
  const total = Number(j?.meta?.count ?? 0);
  const papers = (j?.results ?? []).map((w) => fromOpenAlexWork(w)).filter((p) => p.title);
  return {
    total,
    // `checked` is how many records this call actually looked at — NOT the
    // platform total. Reporting `total` here made a 3-row page claim it had
    // examined all 49,296 citing works, which would turn any "most cited first"
    // statement into a lie the moment a caller printed it.
    checked: papers.length,
    papers,
  };
}

/**
 * Works CITED BY a work — its reference list (backward snowballing).
 *
 * TWO LIMITS THAT MUST BE REPORTED AS THEY ARE, not hidden:
 *   1. at most `REFERENCE_LIMIT` (100) references are fetched;
 *   2. filtering/sorting happens AFTER fetching, so "most cited" only holds
 *      among the ones that were checked.
 */
export async function worksCited(work, { rows = 10, sort = 'citations', email, apiKey = null } = {}) {
  const all = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
  const taken = all.slice(0, REFERENCE_LIMIT).map((x) => String(x).split('/').pop()).filter(Boolean);
  if (taken.length === 0) return { total: all.length, checked: 0, papers: [] };

  const collected = [];
  for (let i = 0; i < taken.length; i += 50) {
    const j = await openAlexJson('/works', {
      filter: `openalex_id:${taken.slice(i, i + 50).join('|')}`,
      'per-page': 50,
    }, email, apiKey);
    collected.push(...(j?.results ?? []));
  }

  const papers = collected
    .map((w) => fromOpenAlexWork(w))
    .filter((p) => p.title)
    .sort((a, b) => (sort === 'newest'
      ? (b.year ?? 0) - (a.year ?? 0)
      : (b.citedBy ?? -1) - (a.citedBy ?? -1)));

  return { total: all.length, checked: taken.length, papers: papers.slice(0, rows) };
}

/**
 * The open-access copy of a work. Pure (no network) so it can be tested
 * without calling the API.
 *
 * Measured OpenAlex location fields: `is_oa, pdf_url, landing_page_url, license,
 * version, source.display_name` — duplicate locations are dropped by URL.
 *
 * ── "NOT REPORTED" IS NOT "NOT OPEN ACCESS" (fixed 24 Nov 2026) ─────────────
 *
 * `isOa: !!oa.is_oa` turned a MISSING `open_access` block into `false`, which is
 * indistinguishable from a work OpenAlex explicitly marks `is_oa: false`. The
 * consumer then printed a definite negative:
 *
 *   work with no `open_access` field at all
 *     -> summarizeOA -> {"isOa":false,"status":null,"oaUrl":null,"locations":[]}
 *     -> paper_oa    -> "access status: NOT OPEN ACCESS — OpenAlex sees no free copy."
 *
 * That is a claim the data does not support, and it is the same defect
 * `workNumber()` exists to prevent for citation counts: unknown must never print
 * as a value. So:
 *
 *   `isOa`     — `true` / `false` / **`null`** when OpenAlex did not report it.
 *   `reported` — `false` when the `open_access` block is absent or null.
 *
 * `reported` is ADDITIVE and exists so a consumer can branch without having to
 * know that `null` means unknown: `if (!oa.reported) …`. Both are needed because
 * `isOa: null` alone is falsy, and a consumer that writes `if (!oa.isOa)` keeps
 * its old behaviour — which is why this change is BACKWARD COMPATIBLE for the
 * two files that are owned elsewhere (`lib/index.js`, `lib/fulltext.js`). What
 * those files must do to stop printing the false negative is stated in the
 * 0.7.0 changelog entry; nothing here requires them to change to keep working.
 *
 * A work that DOES report `is_oa: false` still yields `isOa: false` with
 * `reported: true` — that is a real negative and must keep printing as one.
 */
export function summarizeOA(work) {
  const block = work?.open_access;
  const reported = block !== null && block !== undefined && typeof block === 'object';
  const oa = reported ? block : {};
  const locations = [];
  const seen = new Set();
  /**
   * One location -> one entry, or null when it carries no URL.
   *
   * A LOCATION WITH A URL IS A COPY, EVEN WHEN `is_oa` IS ABSENT. The test used
   * to be `if (!l?.is_oa) continue`, which drops a location that has a
   * `pdf_url` but no `is_oa` flag — and OpenAlex does omit that flag on some
   * locations. Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580):
   *
   *   { locations: [{ pdf_url: 'https://x/a.pdf' }] }
   *     -> locations: []   -> paper_fulltext: "no open-access copy found"
   *
   * A copy was named in the reply and the tool said there was none. So the flag
   * is read THREE ways: `true` keeps the location, `false` drops it (the
   * platform said so), and ABSENT keeps it — because the URL is the evidence,
   * and "the flag was not stated" is not "this is not open access".
   */
  const addLocation = (l) => {
    if (!l || l.is_oa === false) return;
    const url = l.pdf_url || l.landing_page_url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    locations.push({
      pdf: l.pdf_url ?? null,
      landing: l.landing_page_url ?? null,
      license: l.license ?? null,
      version: l.version ?? null,
      source: l.source?.display_name ?? null,
    });
  };
  for (const l of work?.locations ?? []) {
    addLocation(l);
    if (locations.length >= 10) break;
  }
  // `best_oa_location` is OpenAlex's RECOMMENDED copy and was never read. It is
  // usually also in `locations`, but not always — and when it is the only one,
  // the tool reported "no open-access copy found" for a work that names one.
  if (locations.length === 0) addLocation(work?.best_oa_location);
  // `is_oa` itself can be missing inside a present block; that is still "not
  // reported", not "false". `=== true` / `=== false` keeps the two apart.
  const isOa = oa.is_oa === true ? true : oa.is_oa === false ? false : null;
  return {
    isOa,
    reported: reported && isOa !== null,
    status: oa.oa_status ?? null,
    oaUrl: oa.oa_url ?? null,
    locations,
  };
}

// ── arXiv fallback (upstream PR #124) ────────────────────────────────────────
//
// PR #124 adds arXiv to the OA repository fallback chain: an arXiv copy is
// often the only free version of a DOI-bearing paper that is not OA.
//
// WHAT WAS MEASURED 29 Sep 2026, and the shape of it determines the code below:
//   - OpenAlex does **not** store an arXiv id (`ids` only has openalex/doi/mag), so
//     the id has to be derived from the DOI `10.48550/arXiv.<id>` or from a location URL;
//   - if there is none, the arXiv version is searched **by TITLE** — and that is
//     where the danger is: a loose filter accepts a DIFFERENT paper. Measured with
//     a "contains" rule: the title *"Attention Is All You Need"* also accepted
//     *"Not All Attention Is All You Need"* and *"Element-wise Attention Is
//     All You Need"*. That is why `titleSimilarity()` below is **strict**: exactly
//     equal after normalization, or contained with a length ratio >= 0.92.

function normalizeTitle(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 1 = titles exactly equal after normalization · 0.95 = contained but nearly as long · 0 = not similar. */
export function titleSimilarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (shorter.length >= 20 && longer.includes(shorter) && shorter.length / longer.length >= 0.92) return 0.95;
  return 0;
}

/** Acceptance threshold for an arXiv match. Strict on purpose — see the note above. */
export const ARXIV_TITLE_THRESHOLD = 0.9;

/**
 * Metadata for one arXiv work from its ID (`1706.03762` or `1706.03762v7`).
 * Used when the user gives an arXiv id directly — without this its title is
 * unknown and the report only says "arXiv:1706.03762".
 */
export async function arxivWork(id) {
  const clean = String(id ?? '').trim();
  if (!clean) return null;
  await arxivWait();
  try {
    const xml = await getText(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(clean)}&max_results=1`,
      { accept: 'application/atom+xml' },
    );
    return parseArxiv(xml, 1)[0] ?? null;
  } finally {
    arxivLastRequest = Date.now();
  }
}

/** Is the input shaped like an arXiv id (`1706.03762`, `arXiv:1706.03762v2`)? */
export function isArxivId(t) {
  const m = /^(?:arxiv[:/\s]*)?(\d{4}\.\d{4,5})(v\d+)?$/i.exec(String(t ?? '').trim());
  return m ? { id: m[1] + (m[2] ?? '') } : null;
}
/** arXiv id from an arxiv.org URL (abs or pdf). */
export function arxivIdFromUrl(url) {
  const m = /arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/** arXiv id ALREADY listed on the OpenAlex work — no search needed. */
export function arxivIdFromWork(work) {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(normalizeDoi(work?.doi) ?? '');
  if (m) return m[1];
  for (const l of work?.locations ?? []) {
    const id = arxivIdFromUrl(l?.pdf_url) ?? arxivIdFromUrl(l?.landing_page_url);
    if (id) return id;
  }
  return null;
}

/**
 * Find an arXiv match from the TITLE. `null` = nothing similar enough.
 * Deliberately uses the same arXiv rate driver as a normal search
 * (their TOU: 1 request / 3 seconds).
 */
export async function arxivMatch(title, { rows = 5 } = {}) {
  const t = String(title ?? '').trim();
  if (t.length < 8) return null;
  await arxivWait();
  let result;
  try {
    // The title is interpolated into arXiv's query syntax, where a double quote
    // closes the `ti:"…"` phrase and `OR`/`AND` become operators. Measured: the
    // title `Attention" OR all:"x` produced
    // `search_query=ti:"Attention" OR all:"x"`, which searches something else
    // entirely — and the wrong paper would then be reported as "the arXiv
    // version of this one". Strip the syntax characters instead of escaping
    // them: arXiv has no escape sequence for a quote inside a phrase.
    const safe = t.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
    result = await fetchArxiv(`ti:"${safe}"`, rows);
  } finally {
    arxivLastRequest = Date.now();
  }
  for (const p of result) {
    const score = titleSimilarity(t, p.title);
    if (score < ARXIV_TITLE_THRESHOLD) continue;
    const id = arxivIdFromUrl(p.url);
    if (id) return { id, title: p.title, year: p.year, score, exact: score === 1 };
  }
  return null;
}

async function doaj(query, { rows, doajApiKey }) {
  // The DOAJ query lives in the PATH, not in the query string.
  //
  // `DOAJ_API_KEY` was read from the credentials store and passed all the way
  // here — and then IGNORED. Measured 23 Nov 2026: the request with a key and the
  // request without one were byte-identical, so the documented "raises DOAJ's
  // hourly limit" never happened. DOAJ takes the key as an `api_key` query
  // parameter (verified: the endpoint answers 200 with and without it, so a
  // wrong key cannot be detected from the status alone).
  const u = new URL(`https://doaj.org/api/search/articles/${encodeURIComponent(query)}`);
  u.searchParams.set('pageSize', String(rows));
  if (doajApiKey) u.searchParams.set('api_key', String(doajApiKey));
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((r) => {
    const b = r.bibjson ?? {};
    return makePaper({
      title: b.title,
      authors: authorList(b.author),
      year: b.year,
      source: 'doaj',
      doi: (b.identifier ?? []).find((x) => x.type === 'doi')?.id,
      url: (b.link ?? []).find((x) => x.type === 'fulltext')?.url,
      journal: b.journal?.title,
      abstract: b.abstract,
      openAccess: true,
    });
  }).filter((p) => p.title);
}

async function europepmc(query, { rows, kind = null }) {
  // Preprint push-down: Europe PMC marks preprints with `SRC:PPR`.
  // Measured 1 Oct 2026 — "digital literacy AND SRC:PPR" → 2,775 results;
  // "digital literacy AND NOT SRC:PPR" → 85,096. This addition ONLY happens
  // when preprints are actually requested via `kind`; there is no "NOT" logic
  // that could silently drop results.
  const extra = (kind ?? []).includes('preprint') ? ' AND SRC:PPR' : '';
  const u = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query + extra)}&format=json&pageSize=${rows}`;
  const j = await getJson(u);
  return (j?.resultList?.result ?? []).map((r) => makePaper({
    title: r.title,
    // DOAJ gives an `authorString` that IS comma-separated ("A, B, C"), so the
    // splitting is done here first — `authorList` itself deliberately does not
    // split commas, so that "TAN, Kwan Hong" (one author) is not corrupted.
    authors: authorList((r.authorString ?? '').split(/,\s*/)),
    year: r.pubYear,
    source: 'europepmc',
    doi: r.doi,
    url: r.doi ? `https://doi.org/${r.doi}` : `https://europepmc.org/article/${r.source ?? 'MED'}/${r.id}`,
    journal: r.journalTitle,
    abstract: r.abstractText,
    openAccess: r.isOpenAccess === 'Y',
  })).filter((p) => p.title);
}

async function pubmed(query, { rows }) {
  // E-utilities needs TWO calls: esearch (ids) then esummary (metadata).
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const s = await getJson(`${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${rows}&sort=relevance&term=${encodeURIComponent(query)}`);
  const ids = s?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const d = await getJson(`${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`);
  return ids.map((id) => {
    const r = d?.result?.[id];
    if (!r) return null;
    return makePaper({
      title: r.title,
      authors: authorList(r.authors),
      year: String(r.pubdate ?? '').slice(0, 4),
      source: 'pubmed',
      doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      journal: r.fulljournalname || r.source,
    });
  }).filter((p) => p && p.title);
}

// arXiv asks for NO MORE than 1 request / 3 seconds (their TOU). Because the
// sources run in parallel, arXiv requests are serialized here on their own.
//
// ── THE RACE THIS USED TO HAVE (fixed 23 Nov 2026) ──────────────────────────
//
// The old version read `arxivLastRequest`, awaited the delay, then wrote the
// timestamp. Between the read and the write, every other caller saw the SAME
// stale value and computed the SAME delay — so they all woke up together.
// Measured with three concurrent arXiv searches: the gaps between requests were
// 3003 ms, **0 ms**, **69 ms**, 2933 ms, **1 ms** — five violations of the TOU
// in one batch, which is exactly the behaviour that gets an IP blocked.
//
// The fix is a promise CHAIN: each caller appends itself to the previous one, so
// the wait and the timestamp update happen inside the same critical section and
// no two callers can observe the same "last request" value.
let arxivChain = Promise.resolve();
let arxivLastRequest = 0;
const ARXIV_MIN_INTERVAL_MS = 3000;

function arxivWait() {
  const turn = arxivChain.then(async () => {
    const delay = ARXIV_MIN_INTERVAL_MS - (Date.now() - arxivLastRequest);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    arxivLastRequest = Date.now();
  });
  // Keep the chain alive even if a caller's own work throws later.
  arxivChain = turn.catch(() => {});
  return turn;
}

/** Parse the arXiv Atom feed into a list of papers. */
function parseArxiv(xml, rows) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? r[1] : null;
    };
    out.push(makePaper({
      title: pick('title'),
      authors: [...block.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((x) => x[1]),
      year: String(pick('published') ?? '').slice(0, 4),
      source: 'arxiv',
      doi: pick('arxiv:doi'),
      url: pick('id'),
      journal: 'arXiv (preprint)',
      abstract: pick('summary'),
      openAccess: true,
    }));
  }
  return out.filter((p) => p.title).slice(0, rows);
}

/**
 * Fetch the arXiv Atom feed, with TWO fixes taken from upstream issues:
 *
 * 1. **HTTP 406 sometimes still carries a VALID feed** (issue #121). Reported
 *    as measured: a 406 with a 5250-byte body and `Content-Type: application/atom+xml`
 *    containing 2 entries. So a 406 is not failed outright — its content is tried
 *    first. If the body really is empty, only then is it a genuine failure.
 * 2. **A multi-word query without quotes can HANG** on the arXiv backend
 *    (issue #101). That is why the precise form is used first (see `arxiv`).
 */
async function fetchArxiv(query, rows) {
  const u = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=${rows}&sortBy=relevance`;
  try {
    return parseArxiv(await getText(u, { accept: 'application/atom+xml' }), rows);
  } catch (e) {
    if (e.status === 406 && /<entry>/.test(e.fullBody ?? '')) return parseArxiv(e.fullBody, rows);
    throw e;
  }
}

/**
 * The arXiv query shape. Precise first (`all:word1 AND all:word2`), loose
 * (`all:word1 word2`) as a fallback.
 *
 * Why NOT simply copy the upstream fix that quotes the phrase:
 * **measured 28 Sep 2026** — for the Indonesian query `"literasi digital"`, the
 * quoted form and the AND form both gave **0 results**, while the loose form gave
 * **50**. arXiv is indeed an English-language corpus. Blind quoting would wipe out
 * ALL results for non-English topics, so what is used is precise-with-fallback,
 * not quote-blindly.
 *
 * ── SYNTAX INJECTION (fixed 23 Nov 2026) ────────────────────────────────────
 *
 * The user's `query` is interpolated into arXiv's query language, where `"`,
 * `(`, `)`, `[`, `]`, `:` and the bare words `AND`/`OR`/`ANDNOT` are OPERATORS.
 * Measured: the query `Attention" OR all:"x` produced
 *
 *   search_query=all:Attention" OR all:"x
 *
 * which is a different search entirely — and its results would then be reported
 * as the answer to the user's query. `arxivMatch()` already stripped these
 * characters from a TITLE (that was the earlier fix); the SEARCH path did not.
 *
 * The characters are REMOVED rather than escaped: arXiv has no escape sequence
 * for a quote inside a phrase, so there is nothing to escape into. Removing them
 * keeps the words, which is what a search is for.
 */
export function arxivQuery(query, precise) {
  // Strip the query-language metacharacters, then collapse the whitespace they
  // leave behind. `:` goes too — `all:ti:foo` is a nested field expression.
  const cleaned = String(query ?? '').replace(/["\\()[\]{}:]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  // Nothing searchable left (empty query, or only metacharacters). Return null so
  // the caller can skip the request instead of sending a query that cannot match.
  if (words.length === 0) return null;
  // A bare AND/OR/ANDNOT is an operator, not a search term. Dropping it is the
  // only reading that keeps the query meaningful.
  const terms = words.filter((w) => !/^(and|or|andnot|not)$/i.test(w));
  if (terms.length === 0) return `all:${words[0]}`;
  if (terms.length === 1) return `all:${terms[0]}`;
  return precise ? terms.map((k) => `all:${k}`).join(' AND ') : `all:${terms.join(' ')}`;
}

async function arxiv(query, { rows }) {
  // `arxivQuery` returns null when nothing searchable survives sanitization
  // (empty query, or only metacharacters). Sending `all:""` would be a request
  // that cannot match anything, so it is skipped — and skipping costs no request.
  const precise = arxivQuery(query, true);
  if (precise === null) return [];

  await arxivWait();
  let result;
  try {
    result = await fetchArxiv(precise, rows);
  } finally {
    arxivLastRequest = Date.now();
  }
  if (result.length > 0) return result;

  // Loose fallback. Only run when the precise form is genuinely empty,
  // so that arXiv requests stay frugal (their TOU: 1 request / 3 seconds).
  //
  // AND ONLY WHEN IT IS ACTUALLY A DIFFERENT QUERY. For a single-word query the
  // two forms are the same string — `arxivQuery('literature', true)` and
  // `arxivQuery('literature', false)` both return `all:literature` — so the
  // fallback re-sent an identical request, waited out the 3-second self-throttle
  // to do it, and could not possibly get a different answer. Measured 24 Nov 2026
  // on 0.8.0 with `paper_status({probe:true, sources:'arxiv'})`: two identical
  // requests to `export.arxiv.org/api/query?search_query=all%3Aliterature`.
  const loose = arxivQuery(query, false);
  if (loose === null || loose === precise) return [];
  await arxivWait();
  try {
    return await fetchArxiv(loose, rows);
  } finally {
    arxivLastRequest = Date.now();
  }
}

async function semantic(query, { rows, semanticApiKey }) {
  const u = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${rows}&fields=title,year,authors,externalIds,venue,abstract,openAccessPdf`;
  // `semanticApiKey`, NOT `apiKey`: the shared options object now carries
  // OpenAlex's key under `apiKey`, and reading that here would send an OpenAlex
  // key to Semantic Scholar as `x-api-key` — a credential leak to a third party.
  const j = await getJson(u, semanticApiKey ? { headers: { 'x-api-key': semanticApiKey } } : {});
  return (j?.data ?? []).map((d) => makePaper({
    title: d.title,
    authors: authorList(d.authors),
    year: d.year,
    source: 'semantic',
    doi: d.externalIds?.DOI,
    url: d.openAccessPdf?.url || (d.externalIds?.DOI ? `https://doi.org/${d.externalIds.DOI}` : null),
    journal: d.venue,
    abstract: d.abstract,
    openAccess: !!d.openAccessPdf,
  })).filter((p) => p.title);
}

/** Some APIs return a field that can be either a single value OR an array. */
function first(x) {
  return Array.isArray(x) ? x[0] : x;
}

async function pmc(query, { rows }) {
  // PubMed Central uses the same E-utilities as PubMed:
  // esearch (ids) then esummary (metadata).
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const s = await getJson(`${base}/esearch.fcgi?db=pmc&retmode=json&retmax=${rows}&sort=relevance&term=${encodeURIComponent(query)}`);
  const ids = s?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const d = await getJson(`${base}/esummary.fcgi?db=pmc&retmode=json&id=${ids.join(',')}`);
  return ids.map((id) => {
    const r = d?.result?.[id];
    if (!r) return null;
    const pmcid = (r.articleids ?? []).find((a) => a.idtype === 'pmcid')?.value ?? `PMC${id}`;
    return makePaper({
      title: r.title,
      authors: authorList(r.authors),
      year: String(r.pubdate ?? '').slice(0, 4),
      source: 'pmc',
      doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
      url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
      journal: r.fulljournalname || r.source,
      openAccess: true,
    });
  }).filter((p) => p && p.title);
}

async function core(query, { rows, coreApiKey }) {
  // CORE CANNOT be used without a key: measured 28 Sep 2026, a request without
  // `Bearer` is answered with HTTP 429 and an EMPTY body — not 401. That is why a
  // missing key is reported as an actionable message, instead of being
  // left as a confusing 429.
  if (!coreApiKey) {
    throw new Error('CORE_API_KEY is required — without a key CORE answers HTTP 429 with an empty body');
  }
  const j = await getJson(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${rows}`, {
    headers: { Authorization: `Bearer ${coreApiKey}` },
  });
  return (j?.results ?? []).map((c) => makePaper({
    title: c.title,
    authors: authorList(c.authors),
    year: c.yearPublished,
    source: 'core',
    doi: c.doi,
    url: c.downloadUrl || (c.doi ? `https://doi.org/${c.doi}` : null),
    journal: c.publisher,
    abstract: c.abstract,
    openAccess: !!c.downloadUrl,
  })).filter((p) => p.title);
}

/**
 * Zenodo — general-purpose repository (data, software, preprints).
 *
 * ── `openAccess` USED TO BE HARDCODED `true` (fixed 24 Nov 2026) ─────────────
 *
 * Every Zenodo record was labelled open access, whatever Zenodo said. Zenodo
 * reports the real status in `metadata.access_right`, and it is not always
 * `open` — measured live on 10 records of one query:
 *
 *   WRONG  access_right=restricted  connector.openAccess=true
 *   WRONG  access_right=embargoed   connector.openAccess=true
 *   … 7 of 10 records claimed open access while Zenodo said otherwise
 *
 * The consequence is user-visible: `open_access_only` is supposed to drop
 * non-OA works, and it did not — a reader filtering for open access was handed
 * restricted and embargoed records labelled "open access".
 *
 * The four documented values are `open`, `restricted`, `embargoed`, `closed`.
 * Only `open` is open access; the other three are real negatives. A record that
 * does not report the field at all yields `null`, which `makePaper` turns into
 * `false` — "not claimed", never "claimed open".
 */
async function zenodo(query, { rows }) {
  const j = await getJson(`https://zenodo.org/api/records?q=${encodeURIComponent(query)}&size=${rows}`);
  return (j?.hits?.hits ?? []).map((z) => makePaper({
    title: z.metadata?.title,
    authors: authorList(z.metadata?.creators),
    year: String(z.metadata?.publication_date ?? '').slice(0, 4),
    source: 'zenodo',
    doi: z.metadata?.doi ?? z.doi,
    url: z.links?.self_html ?? z.links?.self,
    journal: z.metadata?.imprint?.publisher ?? 'Zenodo',
    abstract: z.metadata?.description,
    // `=== 'open'`, not `!== 'closed'`: `restricted` and `embargoed` are NOT
    // open access either, and treating them as "not closed, so open" is the
    // same mistake in a different direction.
    openAccess: zenodoOpenAccess(z.metadata?.access_right),
  })).filter((p) => p.title);
}

/** Zenodo's `access_right` -> a boolean, or `null` when the record does not say. */
function zenodoOpenAccess(accessRight) {
  const v = String(accessRight ?? '').trim().toLowerCase();
  if (!v) return null;
  return v === 'open';
}

/**
 * HAL — French open-access repository.
 *
 * ── `openAccess` USED TO BE HARDCODED `true` (fixed 24 Nov 2026) ─────────────
 *
 * Same defect as Zenodo, measured live: 8 of 10 HAL records were claimed open
 * access while HAL's own `openAccess_bool` said `false`. HAL reports the field
 * per record and it is selectable, so it is now requested in `fl` and mapped.
 *
 * A record that does not carry the field yields `null` -> `false` in
 * `makePaper`: not claimed, rather than claimed.
 */
async function hal(query, { rows }) {
  // `openAccess_bool` is in the `fl` list because a field that is not requested
  // is not returned — the connector cannot map what it never asked for.
  const fl = 'title_s,authFullName_s,producedDateY_i,doiId_s,uri_s,journalTitle_s,abstract_s,openAccess_bool';
  const j = await getJson(`https://api.archives-ouvertes.fr/search/?q=${encodeURIComponent(query)}&wt=json&rows=${rows}&fl=${fl}`);
  return (j?.response?.docs ?? []).map((a) => makePaper({
    title: first(a.title_s),
    authors: authorList(a.authFullName_s),
    year: a.producedDateY_i,
    source: 'hal',
    doi: first(a.doiId_s),
    url: first(a.uri_s),
    journal: first(a.journalTitle_s),
    abstract: first(a.abstract_s),
    // HAL sends a real boolean; `=== true` keeps a missing field from becoming
    // "open" through truthiness.
    openAccess: a.openAccess_bool === true ? true : a.openAccess_bool === false ? false : null,
  })).filter((p) => p.title);
}

/** IACR Cryptology ePrint Archive — the cryptology preprint archive (HTML). */
async function iacr(query, { rows }) {
  const html = await getText(`https://eprint.iacr.org/search?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const links = [...html.matchAll(/<a title="(\d{4}\/\d+)" class="paperlink" href="\/(\d{4}\/\d+)"/g)];
  if (links.length === 0) {
    // THREE possibilities, and they must not be confused — the same rule the
    // three Indonesian portals follow (see `portalHasNoResults`):
    //   1. the archive really has no match  -> `[]`, a VALID answer
    //   2. the markup changed               -> error
    //   3. the site blocks/redirects        -> error
    //
    // Measured 24 Nov 2026 against the live site:
    //   GET /search?q=literature         -> 100 paperlink anchors, 162,299 bytes
    //   GET /search?q=digital%20literacy ->   0 paperlink anchors,  17,108 bytes,
    //                                        body contains `<h4 class="mt-5">No results</h4>`
    //
    // So a genuinely empty search was reported as "markup changed", and the
    // reply then told the reader the source had FAILED — the opposite of the
    // truth. IACR was missed when the portals were fixed because it is declared
    // `kind: 'api'` while actually scraping HTML.
    //
    // ── AND THE GUARD ITSELF WAS TOO WEAK (found 24 Nov 2026) ────────────────
    //
    // `!/class="paperlink"/.test(html)` searched for a bare substring, which is
    // weaker than the result pattern: the pattern also needs `title="YYYY/NNNN"`
    // BEFORE the class and `href="/YYYY/NNNN"` AFTER it. A page that reordered
    // those attributes still contains `class="paperlink"`, so the guard passed
    // and the connector returned `[]` with `error: null` — a markup change
    // reported as a valid empty answer. The container test below is the same
    // anchor the pattern anchors on, with attribute order deliberately ignored.
    if (hasAnchorWith(html, /class="paperlink"/, /href="\/\d{4}\/\d+"/)) {
      throw new Error('IACR markup changed: "paperlink" anchors are still present, but they no longer match the result pattern (title, class and href in that order)');
    }
    if (portalHasNoResults(html, /No\s+results/i)) return [];
    throw new Error('IACR markup changed: links with class "paperlink" are no longer found');
  }
  const out = [];
  for (let i = 0; i < links.length && out.length < rows; i++) {
    // Slice per result using the next link's position as the boundary, so the
    // regex does not cross into another result.
    const block = html.slice(links[i].index, i + 1 < links.length ? links[i + 1].index : html.length);
    const pick = (re) => { const m = re.exec(block); return m ? m[1] : null; };
    const id = links[i][1];
    out.push(makePaper({
      title: pick(/<strong>([\s\S]*?)<\/strong>/),
      authors: authorList((pick(/<span class="fst-italic">([\s\S]*?)<\/span>/) ?? '').split(/,\s*/)),
      year: id.slice(0, 4),
      source: 'iacr',
      url: `https://eprint.iacr.org/${id}`,
      journal: 'IACR Cryptology ePrint Archive',
      abstract: pick(/<p class="mb-0 mt-1 search-abstract">([\s\S]*?)<\/p>/),
      openAccess: true,
    }));
  }
  return out.filter((p) => p.title);
}

/**
 * Unpaywall — an open-access finder **by DOI**, NOT a keyword
 * search engine. Verified 28 Sep 2026: with a DOI it answers HTTP 200 and
 * finds the paper; with a keyword it genuinely returns 0.
 *
 * A query that is not a DOI is returned EMPTY WITHOUT an error — that is not a
 * failure, that is how it works. If this were thrown as an error, every keyword
 * search would write a fake FAILED line.
 */
async function unpaywall(query, { rows, email }) {
  const doi = normalizeDoi(query);
  if (!doi) return [];
  if (!email) throw new Error('UNPAYWALL_EMAIL is required — Unpaywall rejects requests without an email');
  const j = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`);
  if (!j?.title) return [];
  const oa = j.best_oa_location ?? null;
  const result = makePaper({
    title: j.title,
    authors: authorList(j.z_authors),
    year: j.year,
    source: 'unpaywall',
    doi: j.doi ?? doi,
    url: oa?.url_for_pdf ?? oa?.url ?? (j.doi ? `https://doi.org/${j.doi}` : null),
    journal: j.journal_name,
    openAccess: !!j.is_oa,
  });
  return result.title ? [result].slice(0, Math.max(1, Math.min(rows, 1))) : [];
}

// ── INDONESIAN sources (HTML parsing) ────────────────────────────────────────
//
// The patterns below were MEASURED directly from their live pages (28 Sep 2026),
// not guessed. If an operator changes the markup, the source will report 0
// results — and that will be visible, not disguised, because we keep `error`
// separate from `papers` (see `searchSource`).

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function collectHtml(html, pattern, limit) {
  const out = [];
  for (const m of html.matchAll(pattern)) {
    if (out.length >= limit) break;
    out.push(m);
  }
  return out;
}

/**
 * When the result marker is not found, there are THREE DIFFERENT possibilities:
 *   1. the portal answers "zero results"  -> `[]`, that is a VALID result
 *   2. the portal markup changed          -> error
 *   3. the portal blocks/redirects        -> error
 *
 * Before this, (1) and (2) were treated the same, so a genuinely empty portal
 * was reported as **FAILED**. That is wrong in the opposite direction:
 * reporting a failure when the result is perfectly validly empty — just as
 * misleading as hiding a failure.
 *
 * The zero-result markers were measured 28 Sep 2026 using a nonsense query, then
 * compared against a query that has results:
 *
 *   Garuda : "Found 0 documents"                (page 11,181 characters)
 *   Sinta  : the `Results for "<q>"` header is still there, zero profile links
 *            (page 34,063 characters) — Sinta does NOT write an empty message
 *   IOS    : "No Results!"                      (page 23,041 characters)
 */
function portalHasNoResults(html, ...markers) {
  return markers.some((re) => re.test(html));
}

/**
 * Does the page contain an `<a>` tag that carries ALL of these attributes?
 *
 * ── WHY THIS EXISTS (found 24 Nov 2026) ─────────────────────────────────────
 *
 * Each portal's "did the markup change?" guard used to search the page for a
 * bare SUBSTRING — `title-article`, `journals/profile/`, `class="title"`,
 * `class="paperlink"`. That substring is weaker than the result pattern it is
 * supposed to protect, so a page that still contains the marker word but no
 * longer matches the pattern returned `[]` with `error: null`: a markup change
 * reported as a VALID EMPTY ANSWER, which is the one failure the file header
 * forbids. Measured on all four:
 *
 *   garuda  class="title-article" kept, inner <xmp> became <span>  -> [] , null
 *   sinta   "journals/profile/" kept, links became RELATIVE        -> [] , null
 *   ios     class="title" kept, attributes reordered               -> [] , null
 *   iacr    class="paperlink" kept, attributes reordered           -> [] , null
 *
 * The guard must therefore test the same thing the parser needs: the RESULT
 * CONTAINER — the anchor the pattern anchors on, with its identifying
 * attributes. Attribute ORDER is deliberately not part of the test, because a
 * reordering is exactly the change that broke the parser and must be reported;
 * what is tested is that the container is still there at all.
 *
 * So the two cases are now distinguishable:
 *   · container present, pattern matched nothing -> the markup INSIDE the
 *     container changed -> error;
 *   · no container at all -> either a genuinely empty page (the zero-result
 *     marker decides) or a changed page -> error.
 */
function hasAnchorWith(html, ...tests) {
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*>/gi)) {
    if (tests.every((re) => re.test(m[0]))) return true;
  }
  return false;
}

const GARUDA_BASE = 'https://garuda.kemdiktisaintek.go.id';

/** Garuda — index of Indonesian journal articles (Kemdiktisaintek). */
async function garuda(query, { rows }) {
  const html = await getText(`${GARUDA_BASE}/documents?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const pattern = /<a[^>]*class="title-article"[^>]*href="\/documents\/detail\/(\d+)"[^>]*>\s*<xmp>([\s\S]*?)<\/xmp>/g;
  const result = collectHtml(html, pattern, rows).map((m) => makePaper({
    title: m[2],
    source: 'garuda',
    url: `${GARUDA_BASE}/documents/detail/${m[1]}`,
    journal: 'Garuda (Indonesian journal)',
    openAccess: true,
  })).filter((p) => p.title);
  // HTML parsing that finds not a single pattern can mean TWO opposite things.
  // Tell them apart: Garuda writes "Found 0 documents" when it really is empty.
  // The container test is the SAME anchor the pattern needs (class + detail
  // href), so a page whose `<xmp>` changed is an error, not an empty answer.
  if (result.length === 0) {
    if (hasAnchorWith(html, /class="title-article"/, /href="\/documents\/detail\/\d+"/)) {
      throw new Error('Garuda markup changed: result links are still present, but the title is no longer inside <xmp>');
    }
    if (portalHasNoResults(html, /Found\s+0\s+document/i)) return [];
    throw new Error('Garuda markup changed: the "title-article" marker is no longer found');
  }
  return result;
}

/** Sinta — list of ACCREDITED Indonesian JOURNALS (not articles). */
async function sinta(query, { rows }) {
  const html = await getText(`https://sinta.kemdiktisaintek.go.id/journals?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const pattern = /href="https:\/\/sinta\.kemdiktisaintek\.go\.id\/journals\/profile\/(\d+)"[^>]*>([\s\S]{3,220}?)<\/a>/g;
  const result = collectHtml(html, pattern, rows).map((m) => makePaper({
    title: m[2],
    source: 'sinta',
    url: `https://sinta.kemdiktisaintek.go.id/journals/profile/${m[1]}`,
    journal: 'Sinta (accredited journals)',
    openAccess: true,
  })).filter((p) => p.title);
  // Sinta does NOT write an empty message — it still shows the
  // `Results for "<query>"` header followed by an empty list. So that header is
  // what is used as proof that "the page loaded, the result really is zero".
  // (Sinta lists JOURNALS, not articles, so a specific query is often zero.)
  //
  // The container test is the profile ANCHOR the pattern needs. It deliberately
  // accepts a RELATIVE href too: a page that switched to relative links still
  // has the container, so the parse failure is a markup change and must be
  // reported — measured 24 Nov 2026, that was the shape that slipped through the
  // old `journals/profile/` substring test and came back as a valid empty answer.
  if (result.length === 0) {
    if (hasAnchorWith(html, /href="[^"]*\/journals\/profile\/\d+"/)) {
      throw new Error('Sinta markup changed: profile links are still present, but they no longer match the result pattern (absolute href + title directly inside the anchor)');
    }
    if (portalHasNoResults(html, /Results for/i)) return [];
    throw new Error('Sinta markup changed: "journals/profile" links are no longer found');
  }
  return result;
}

/** IOS OneSearch — Indonesian repository aggregator (Perpusnas). */
async function ios(query, { rows }) {
  const html = await getText(`https://onesearch.id/Search/Results?lookfor=${encodeURIComponent(query)}&type=AllFields`, { headers: { 'User-Agent': UA_BROWSER } });
  const pattern = /<a[^>]*href="\/Record\/([^"]+)"[^>]*class="title"[^>]*>([\s\S]*?)<\/a>/g;
  const result = collectHtml(html, pattern, rows).map((m) => makePaper({
    title: m[2],
    source: 'ios',
    url: `https://onesearch.id/Record/${m[1]}`,
    journal: 'IOS OneSearch (Indonesian repository)',
    openAccess: true,
  })).filter((p) => p.title);
  // The container test is the result ANCHOR the pattern needs: a `/Record/…`
  // href carrying `class="title"`. Attribute ORDER is not part of the test —
  // a reordering is exactly the change that broke the parser and must be
  // reported, not swallowed as an empty answer (measured 24 Nov 2026).
  if (result.length === 0) {
    if (hasAnchorWith(html, /href="\/Record\/[^"]+"/, /class="title"/)) {
      throw new Error('IOS markup changed: result links are still present, but they no longer match the result pattern');
    }
    if (portalHasNoResults(html, /No Results!/i)) return [];
    throw new Error('IOS markup changed: result links with class "title" are no longer found');
  }
  return result;
}

// ── Registry ─────────────────────────────────────────────────────────────────

// ── Sources born from upstream issues/PRs (0.2.0) ───────────────────────────

/** DOI inside OpenReview BibTeX — used so the SAME work also gets deduped. */
function doiFromBibtex(bib) {
  const m = /doi\s*=\s*[{"]([^}"]+)[}"]/i.exec(String(bib ?? ''));
  return m?.[1]?.trim() ?? null;
}

/**
 * OpenReview (upstream issue #83) — ML conference venue: ICLR, NeurIPS, ICML.
 * **Without an API key.**
 *
 * The shape that WORKS, measured 1 Oct 2026:
 *   `GET api2.openreview.net/notes/search?term=<q>&content=all&source=forum&limit=N`
 * The generic `/notes` endpoint is instead answered with **HTTP 403
 * `ChallengeRequiredError`** (bot verification), so do NOT use it; only
 * `notes/search` gets through without a challenge. A `query=` parameter is also
 * rejected: the parameter is named `term`.
 *
 * TWO author shapes appear in the field and both are real: an array of STRINGS
 * (ICLR submissions) and an array of `{fullname}` objects (ORCID/DBLP records).
 * `authorList` handles both — the `fullname` shape was once NOT recognized and
 * author names were silently lost, then fixed together with this source.
 *
 * `pdf` can be a relative path (`/pdf/<hash>.pdf`) or an external URL (IEEE);
 * the relative one is completed against openreview.net. Many ICLR works only have
 * a copy here — not in Crossref nor OpenAlex.
 */
async function openreview(query, { rows }) {
  const u = new URL('https://api2.openreview.net/notes/search');
  u.searchParams.set('term', query);
  u.searchParams.set('content', 'all');
  u.searchParams.set('source', 'forum');
  u.searchParams.set('limit', String(rows));
  const j = await getJson(u.toString());
  return (j?.notes ?? [])
    .map((n) => {
      const c = n.content ?? {};
      const value = (k) => (c[k] && typeof c[k] === 'object' ? c[k].value : c[k]);
      const pdf = value('pdf');
      const pdfLink = typeof pdf === 'string' && pdf.startsWith('/') ? `https://openreview.net${pdf}` : (pdf ?? null);
      const invitations = JSON.stringify(n.invitations ?? n.invitation ?? '');
      const pdate = Number(value('pdate') ?? value('cdate') ?? n.pdate ?? n.cdate);
      const title = value('title');
      const venue = value('venue') ?? value('venueid');
      return makePaper({
        title,
        authors: authorList(value('authors') ?? value('authorids')),
        year: Number.isFinite(pdate) && pdate > 0 ? new Date(pdate).getUTCFullYear() : null,
        source: 'openreview',
        doi: doiFromBibtex(value('_bibtex')),
        url: pdfLink ?? `https://openreview.net/forum?id=${encodeURIComponent(n.forum ?? n.id ?? '')}`,
        // In ORCID/DBLP records, the `venue` field sometimes contains the TITLE
        // ITSELF (measured 1 Oct 2026). Showing it would repeat the title on the
        // venue line — so it is treated as "not reported".
        journal: cleanText(venue) && cleanText(venue) !== cleanText(title) ? venue : null,
        abstract: value('abstract'),
        // The kind marker is taken from a fact the API reports, not a guess:
        // a note that came in through the "…/-/Submission" track is a conference paper.
        type: /\/-\/Submission/i.test(invitations) ? 'article' : null,
      });
    })
    .filter((p) => p.title);
}

/**
 * SSRN (upstream PR #60) — **via OpenAlex**, not by scraping their site.
 *
 * Why not scrape: `ssrn.com` rejects ordinary requests (**HTTP 403**), which is
 * why SSRN used to be on the "deliberately unused" list. But all SSRN works are
 * indexed by OpenAlex as ONE source — `S4210172589`,
 * "SSRN Electronic Journal", **1,656,021 works** — so it can be searched with an
 * ordinary filter, without fetching a single SSRN page.
 *
 * Measured 1 Oct 2026: `search=digital literacy` + that source filter answered
 * **3,836 works**; examples of real results also appeared on the first page.
 *
 * Its value for economics/law/business: many SSRN preprints are not in
 * Crossref, so they would never show up through another source.
 */
const SSRN_OPENALEX_ID = 'S4210172589';

/**
 * A source whose content is ONE OpenAlex repository — the same path for
 * SSRN (0.2.0), bioRxiv, and medRxiv (0.3.0).
 *
 * Why it is done this way: all three demand special treatment when taken
 * directly — ssrn.com rejects ordinary requests (403), bioRxiv/medRxiv have no
 * keyword search at all (only date/category ranges) — whereas the entire content
 * of all three is already indexed by OpenAlex as one source. So we use an API we
 * ALREADY use: no new scraper, no key, and the `min_citations`/`kind` push-down
 * works for free.
 *
 * Measured 1 Oct 2026: bioRxiv `S4306402567` 345,976 works ("digital literacy"
 * 159; + preprint kind & citations>4 → 141) · medRxiv `S3005729997` 87,941 works
 * ("digital literacy" 1,352) · SSRN 1,656,021 works.
 */
async function openAlexRepository(query, { rows, email, apiKey = null, minCitations = null, kind = null }, sourceId, source) {
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', query);
  u.searchParams.set('per-page', String(rows));
  const filter = [`primary_location.source.id:${sourceId}`];
  if (Number.isFinite(minCitations) && minCitations > 0) filter.push(`cited_by_count:>${Math.max(0, Math.floor(minCitations) - 1)}`);
  const t = (kind ?? []).filter((j) => ['article', 'review', 'preprint'].includes(j));
  if (t.length) filter.push(`type:${t.join('|')}`);
  u.searchParams.set('filter', filter.join(','));
  if (email) u.searchParams.set('mailto', email);
  if (apiKey) u.searchParams.set('api_key', String(apiKey));
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((w) => fromOpenAlexWork(w, source)).filter((p) => p.title);
}

const ssrn = (query, options) => openAlexRepository(query, options, SSRN_OPENALEX_ID, 'ssrn');
const biorxiv = (query, options) => openAlexRepository(query, options, 'S4306402567', 'biorxiv');
const medrxiv = (query, options) => openAlexRepository(query, options, 'S3005729997', 'medrxiv');

/**
 * ChemRxiv (0.3.1) — chemistry preprints, also via OpenAlex.
 *
 * OpenAlex source `S4393918830` holds **64,495** works; "catalysis" gives
 * **13,594** real results (measured 2 Oct 2026).
 *
 * WHY NOT THEIR SITE: chemrxiv.org replies with **HTTP 403** and a Cloudflare
 * page ("Just a moment...") — measured 2 Oct 2026, both for its search page and
 * for its API gateway. The upstream module takes HTML from there, so that path
 * would be blocked; this OpenAlex path is not.
 */
const chemrxiv = (query, options) => openAlexRepository(query, options, 'S4393918830', 'chemrxiv');

/**
 * IEEE — via Crossref, **without an API key**: the same trick as ACM (#123).
 *
 * Measured 1 Oct 2026: `filter=member:263` answers **136,771** works; with
 * `type:proceedings-article` **106,734**; every result carries a `10.1109/…` DOI.
 * Upstream (PR #138) still makes IEEE require a key — this path does not.
 *
 * A LIMIT DELIBERATELY NOT CLAIMED: Crossref does **not** carry IEEE abstracts
 * (measured 0 of 5 records). Its citation field IS there (5 of 5). So abstracts
 * are usually empty — better honest than invented. If the abstract is needed,
 * fetch it via `paper({ mode: 'search' })` with the `openalex` source
 * using its DOI.
 */
async function ieee(query, { rows, email, kind = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  const kindFilter = crossrefFilter(kind);
  u.searchParams.set('filter', `member:263${kindFilter ? `,${kindFilter}` : ''}`);
  u.searchParams.set('select', CROSSREF_FIELDS);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => fromCrossrefItem(it, 'ieee')).filter((p) => p.title);
}

export const SOURCES = [
  // International
  { id: 'crossref', label: 'Crossref', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: crossref },
  { id: 'acm', label: 'ACM DL', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: acm, note: 'ACM Digital Library via Crossref (DOI prefix 10.1145) — no key needed (upstream PR #123)' },
  { id: 'openalex', label: 'OpenAlex', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: openalex },
  { id: 'doaj', label: 'DOAJ', region: 'international', kind: 'api', credit: 'optional', fn: doaj, note: 'also covers Indonesian open-access journals' },
  { id: 'europepmc', label: 'Europe PMC', region: 'international', kind: 'api', credit: null, fn: europepmc },
  { id: 'pubmed', label: 'PubMed', region: 'international', kind: 'api', credit: null, fn: pubmed, note: 'two calls per search (esearch + esummary)' },
  { id: 'arxiv', label: 'arXiv', region: 'international', kind: 'api', credit: null, fn: arxiv, note: 'preprint; self-throttled to 1 request / 3 seconds' },
  { id: 'semantic', label: 'Semantic Scholar', region: 'international', kind: 'api', credit: 'raises rate limit', fn: semantic },
  { id: 'pmc', label: 'PubMed Central', region: 'international', kind: 'api', credit: null, fn: pmc, note: 'open-access full text; two calls per search' },
  { id: 'core', label: 'CORE', region: 'international', kind: 'api', credit: 'REQUIRED — answers 429 without a key', needs: 'CORE_API_KEY', fn: core, note: 'open-access repository aggregator' },
  { id: 'zenodo', label: 'Zenodo', region: 'international', kind: 'api', credit: null, fn: zenodo, note: 'general-purpose repository: data, software, preprints' },
  { id: 'hal', label: 'HAL', region: 'international', kind: 'api', credit: null, fn: hal, note: 'French open-access repository' },
  { id: 'iacr', label: 'IACR ePrint', region: 'international', kind: 'html', credit: null, fn: iacr, note: 'cryptology preprint archive' },
  { id: 'openreview', label: 'OpenReview', region: 'international', kind: 'api', credit: null, fn: openreview, note: 'ML conferences (ICLR/NeurIPS/ICML) — no key needed (upstream issue #83)' },
  { id: 'ssrn', label: 'SSRN', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: ssrn, note: 'via OpenAlex, not by scraping their site, which answers 403 (upstream PR #60)' },
  { id: 'ieee', label: 'IEEE', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: ieee, note: 'via Crossref member:263 — WITHOUT an API key; Crossref does not carry IEEE abstracts' },
  { id: 'biorxiv', label: 'bioRxiv', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: biorxiv, note: 'biology preprints — via OpenAlex (repository S4306402567), not their date-range API' },
  { id: 'medrxiv', label: 'medRxiv', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: medrxiv, note: 'health preprints — via OpenAlex (repository S3005729997)' },
  { id: 'chemrxiv', label: 'ChemRxiv', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: chemrxiv, note: 'chemistry preprints — via OpenAlex (repository S4393918830); chemrxiv.org itself answers 403 from Cloudflare' },
  { id: 'unpaywall', label: 'Unpaywall', region: 'international', kind: 'api', input: 'doi', credit: 'REQUIRED email', needs: ['UNPAYWALL_EMAIL', 'OPENALEX_EMAIL'], fn: unpaywall, note: 'needs a DOI — not a keyword search engine' },
  // Indonesia
  { id: 'garuda', label: 'Garuda', region: 'indonesia', kind: 'html', credit: null, fn: garuda, note: 'Indonesian journal articles' },
  { id: 'sinta', label: 'Sinta', region: 'indonesia', kind: 'html', credit: null, fn: sinta, note: 'list of ACCREDITED JOURNALS, not articles' },
  { id: 'ios', label: 'IOS OneSearch', region: 'indonesia', kind: 'html', credit: null, fn: ios, note: 'Indonesian repository aggregator' },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);

/**
 * Sources that are REGISTERED but NOT part of the default `all` set.
 *
 * They stay callable by name — `sources: "pmc"` still works — but a bare
 * `paper_search({ query })` no longer pays for them. Each entry records the
 * measured reason, because "off by default" without a reason is just a guess.
 *
 * `pmc` — PubMed Central. Measured 23 Nov 2026: it costs TWO requests per search
 * (esearch + esummary, the same E-utilities as PubMed) and returns a strict
 * SUBSET of what `pubmed` already returns in the same run — PMC is the
 * open-access full-text slice of PubMed. So every default search paid two extra
 * requests to NCBI for records it already had. The one thing PMC adds is the
 * full-text availability flag, which `paper_fulltext` answers directly and more
 * cheaply (one OpenAlex request).
 *
 * `ios` — Indonesia OneSearch. Measured 23 Nov 2026: the host does not answer at
 * all from this machine (`UND_ERR_CONNECT_TIMEOUT` on both https and http, after
 * 10.5 s), so every default search waited 10.5 seconds to collect zero results.
 * It is an HTML scrape with no API, so there is nothing to fall back to. The
 * other two Indonesian sources (`garuda`, `sinta`) answer in ~6 s and stay on.
 */
export const DEFAULT_OFF = ['pmc', 'ios'];

/** Ids that a bare `paper_search` runs. Explicit requests may still name any id. */
export const DEFAULT_IDS = SOURCE_IDS.filter((id) => !DEFAULT_OFF.includes(id));

export const INTERNATIONAL_IDS = SOURCES.filter((s) => s.region === 'international').map((s) => s.id);
export const INDONESIA_IDS = SOURCES.filter((s) => s.region === 'indonesia').map((s) => s.id);
export const DOI_IDS = SOURCES.filter((s) => s.input === 'doi').map((s) => s.id);

/**
 * Is this query shaped like a DOI? Used to decide whether DOI-input sources
 * (unpaywall) also run when the user picks "all".
 * Without this, every keyword search pays for one request that is certain to be
 * empty — and shows a line that explains nothing.
 */
export function isDoi(q) {
  // The trailing punctuation is stripped BEFORE the shape test, so that a DOI
  // pasted from the end of a sentence is still recognized as a DOI (and then
  // normalized to the clean form) instead of falling through to a title search.
  // Measured 24 Nov 2026: `10.1038/nature14539.` used to pass `\S+` and keep
  // the dot, which 404'd in OpenAlex.
  return /^10\.\d{4,9}\/\S+$/i.test(doiCore(q));
}

export function findSource(id) {
  return SOURCES.find((s) => s.id === id) ?? null;
}

/**
 * The most specific reason a thrown error carries.
 *
 * `fetch` reports every network failure as `TypeError: fetch failed` and puts
 * the actual reason in `cause` — so without this, a connection reset, a DNS
 * miss, a refused connection and an expired certificate all read identically.
 * Measured 24 Nov 2026 against the live Garuda portal:
 *
 *   fetch(...) -> TypeError: fetch failed
 *                 cause: ECONNRESET
 *   reported   -> "Garuda  html  fetch failed"
 *
 * The code is what makes the line actionable: `ECONNRESET` means the server
 * dropped the connection (retry later), `ENOTFOUND` means the name does not
 * resolve (the source is gone), `CERT_HAS_EXPIRED` means the certificate is
 * stale. A `cause` may itself be an `AggregateError` with several codes (a host
 * with both A and AAAA records), so every code is collected.
 */
function errorCause(e) {
  const codes = [];
  const walk = (x, depth) => {
    if (!x || depth > 3) return;
    if (Array.isArray(x.errors)) for (const inner of x.errors) walk(inner, depth + 1);
    const code = x.code ?? x.errno;
    if (code && !codes.includes(String(code))) codes.push(String(code));
    if (x.cause) walk(x.cause, depth + 1);
  };
  walk(e?.cause, 0);
  return codes.length ? codes.join('/') : null;
}

/**
 * Run one source. ALWAYS returns { id, papers, error, ms } —
 * never throws — so that one dead source does not cancel the
 * whole search, and its failure stays visible to the caller.
 */
/**
 * A readable description of whatever was THROWN.
 *
 * `e?.message ?? 'failed'` lost the content of a thrown non-Error: a bare string
 * has no `.message`, so the reply said only "failed". Measured 24 Nov 2026 on
 * 0.7.0 (HEAD ba4b580) with a connector that threw `'a string, not an Error'`:
 * the per-source line read "FAILED Crossref api failed".
 *
 * `String(e)` is not enough either — it turns a plain object into
 * "[object Object]", which is no more informative than "failed". So an object
 * with no `message` is serialized, and only a value with nothing printable at
 * all falls back to "failed".
 */
function thrownText(e) {
  if (e === null || e === undefined) return 'failed';
  if (typeof e === 'string') return e;
  if (typeof e === 'number' || typeof e === 'boolean') return String(e);
  try {
    const json = JSON.stringify(e);
    if (json && json !== '{}') return json;
  } catch {
    // circular or otherwise unserializable — fall through
  }
  return String(e);
}

export async function searchSource(id, query, opts) {
  const source = findSource(id);
  if (!source) return { id, papers: [], error: `unknown source: ${id}`, ms: 0 };
  const started = Date.now();
  try {
    const papers = await source.fn(query, opts);
    return { id, papers: Array.isArray(papers) ? papers : [], error: null, ms: Date.now() - started };
  } catch (e) {
    const cause = errorCause(e);
    const message = e?.name === 'AbortError'
      ? 'timeout'
      // The status is appended only when the message does not already carry it.
      // `getText` builds "HTTP 400" as the message AND sets `err.status`, so the
      // unconditional append printed "HTTP 400 (HTTP 400)" on every HTTP failure
      // — measured 24 Nov 2026 against the live Crossref API.
      // A THROWN NON-Error LOSES ITS CONTENT under `e?.message ?? 'failed'`:
      // `'a string'` has no `.message`, so the reply said only "failed" and the
      // reason was gone. Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580) with a
      // connector that threw a bare string: the per-source line read
      // "FAILED Crossref api failed". `String(e)` keeps whatever was thrown.
      : `${e?.message ?? thrownText(e)}${e?.status && !/\bHTTP \d{3}\b/.test(String(e?.message ?? '')) ? ` (HTTP ${e.status})` : ''}${cause ? ` [${cause}]` : ''}${e?.body ? ` — ${e.body}` : ''}`;
    return { id, papers: [], error: message, ms: Date.now() - started };
  }
}

// ── Dedup ────────────────────────────────────────────────────────────────────

/**
 * The normalized title used as a dedup key — the WHOLE title, never a prefix.
 *
 * ── THE 120-CHARACTER FENCE MERGED DIFFERENT PAPERS (fixed 24 Nov 2026) ─────
 *
 * This used to end in `.slice(0, 120)`. Two records whose titles differ only
 * AFTER character 120 got the same key and were merged into one, with the second
 * record's URL discarded. Measured on two real Crossref records — different
 * peer-review reports for different versions of the same paper:
 *
 *   "Peer Review Report For: Data extraction methods for systematic review
 *    (semi)automation: A living systematic review [version 1; peer review: 3 approved]"
 *   "… [version 2; peer review: 2 approved]"
 *
 *   keys equal? true   ->   two DIFFERENT papers -> 1 record, one URL kept
 *
 * This is not a contrived shape: 30 of 298 sampled real titles have a normalized
 * key longer than 120 characters. The comment below explains why an
 * UNIDENTIFIABLE record must not share a key; the truncation reintroduced
 * exactly that failure for identifiable ones.
 *
 * So the key is the full normalized title. That is what "the same title" means,
 * and it keeps the dedup behaviour for genuinely identical titles — including
 * the case the fence was presumably added for, where two sources report the same
 * title with different trailing punctuation, which the normalization already
 * collapses.
 *
 * The cost is a longer Map key, which is bounded by the title length
 * (`makePaper` truncates titles to 300 characters, so the key is at most ~300).
 */
const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Drop duplicates: DOI first, then the normalized title.
 * `sources` records ALL sources that found that paper — so the user
 * knows a paper appeared in several databases, rather than it being hidden.
 */
export function dedup(papers) {
  const map = new Map();
  /**
   * Title keys that are shared by MORE THAN ONE distinct paper.
   *
   * A title alone does not identify a paper: "Editorial" and "Introduction" are
   * real titles that recur across journals and years. Measured 24 Nov 2026 on
   * 0.7.0 (HEAD ba4b580) with four records that differ in year AND URL and carry
   * no DOI:
   *
   *   Editorial 2020 (crossref)  \
   *   Editorial 2021 (doaj)       >  ONE record, the 2021 URL discarded
   *   Introduction 2019 (hal)    \
   *   Introduction 2022 (zenodo)  >  ONE record, the 2022 URL discarded
   *
   * Two papers vanished from a four-paper result set, silently. So a title key
   * maps to a LIST of entries, and a new record joins an existing one only when
   * the years are COMPATIBLE: equal, or one of them unknown. Two records with
   * the same title and two DIFFERENT known years are two papers.
   *
   * The asymmetry is deliberate. A false SPLIT shows the same paper twice, which
   * the reader can see and dismiss; a false MERGE deletes a paper, which nobody
   * can see. The same reasoning already governs the slug hash in
   * `lib/fulltext.js`.
   */
  const byTitle = new Map();
  for (const p of papers) {
    // A record with neither a DOI nor a usable title cannot be identified by
    // content, so it must not share a key with every other such record.
    // Measured: `titleKey(null)` is `''`, so three distinct untitled records
    // from Zenodo/HAL/IOS collapsed into ONE survivor and the other two URLs
    // were lost. Fall back to the URL, then to the source+index, so each
    // unidentifiable record stays its own entry.
    const tk = titleKey(p.title);
    let key;
    if (p.doi) {
      key = `doi:${p.doi}`;
    } else if (tk) {
      // Find an entry with this title whose year does not CONTRADICT this one.
      const candidates = byTitle.get(tk) ?? [];
      const match = candidates.find((k) => {
        const a = map.get(k)?.year;
        const b = p.year;
        return a == null || b == null || Number(a) === Number(b);
      });
      key = match ?? `t:${tk}:${p.year ?? '?'}:${candidates.length}`;
      if (!match) {
        candidates.push(key);
        byTitle.set(tk, candidates);
      }
    } else {
      key = p.url ? `u:${p.url}` : `x:${p.source}:${map.size}`;
    }
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...p, sources: [p.source] });
      continue;
    }
    if (!existing.sources.includes(p.source)) existing.sources.push(p.source);
    // Fill the empty fields from the other copy — do not throw the information away.
    for (const f of ['abstract', 'journal', 'doi', 'url', 'year']) {
      if (!existing[f] && p[f]) existing[f] = p[f];
    }
    if (!existing.openAccess && p.openAccess) existing.openAccess = true;
    // A retraction flag must SURVIVE dedup: if any source flags the work, the
    // merged record is flagged. Dropping it here would hide the warning exactly
    // when two databases disagree about the same paper.
    if (p.isRetracted) existing.isRetracted = true;
    if (p.authors?.length > (existing.authors?.length ?? 0)) existing.authors = p.authors;
    // The citation count taken is the LARGEST, not the last: one source may
    // report it while another does not (`null`), and `null` is not 0.
    if (p.citedBy != null && (existing.citedBy == null || p.citedBy > existing.citedBy)) existing.citedBy = p.citedBy;
  }
  return [...map.values()];
}
