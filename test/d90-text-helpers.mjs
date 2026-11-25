// d90 — three defects in the text helpers every connector shares.
//
// `cleanText`, `decodeEntities` and `truncateClean` are on the path of ALL 23
// sources, so a defect here is not a portal problem — it is a problem with every
// title the plugin ever prints. All three measured 24 Nov 2026 on 0.8.0.
//
//   1. `cleanText` stripped `<[^>]*>`, which matches a COMPARISON as readily as a
//      tag: "Pengaruh X < 5 terhadap Y > Z" became "Pengaruh X Z". The middle of
//      the title was deleted, silently.
//   2. `decodeEntities` knew six named entities, so `&eacute;`, `&rsquo;` and
//      `&mdash;` — ordinary CMS output — survived verbatim into the title.
//   3. `truncateClean` sliced by UTF-16 code unit, so a 300-unit cut could land
//      between the halves of a surrogate pair and leave a lone high surrogate,
//      which a UTF-8 round trip turns into U+FFFD.
//
// The helpers are internal, so the assertions drive them through a connector —
// which is also the only way to be sure the fix reaches the reply.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** Run one Garuda search over a canned page and return the first title. */
async function titleFrom(rawTitle) {
  const tools = loadTools();
  const h = installFetch(() => ({
    body: `<a class="title-article" href="/documents/detail/1"><xmp>${rawTitle}</xmp></a>`,
    headers: { 'content-type': 'text/html' },
  }));
  const reply = await tools.get('paper_search').execute({ query: 'x', sources: 'garuda', max_results: 5 });
  h.restore();
  const line = reply.split('\n').find((l) => /^\d+\. /.test(l));
  return line ? line.replace(/^\d+\. /, '') : null;
}

// ── 1. A bare `<` is not a tag ──────────────────────────────────────────────
{
  check('a comparison survives intact',
    (await titleFrom('Pengaruh X < 5 terhadap Y > Z')) === 'Pengaruh X < 5 terhadap Y > Z',
    JSON.stringify(await titleFrom('Pengaruh X < 5 terhadap Y > Z')));
  check('a lone `<` with no `>` survives',
    (await titleFrom('Pengaruh X < 5 terhadap Y')) === 'Pengaruh X < 5 terhadap Y');
  check('a real tag is still stripped',
    (await titleFrom('Pengaruh <b>X</b> terhadap Y')) === 'Pengaruh X terhadap Y',
    JSON.stringify(await titleFrom('Pengaruh <b>X</b> terhadap Y')));
  check('a JATS wrapper is still stripped',
    (await titleFrom('<jats:p>text</jats:p>')) === 'text');
  check('an HTML comment is still stripped',
    (await titleFrom('a<!-- hidden -->b')) === 'a b',
    JSON.stringify(await titleFrom('a<!-- hidden -->b')));
  // The order matters: entities are decoded AFTER tags are stripped, so an
  // entity-encoded tag is the literal text the source meant.
  check('an entity-encoded tag stays literal text',
    (await titleFrom('&lt;b&gt;bold&lt;/b&gt;')) === '<b>bold</b>',
    JSON.stringify(await titleFrom('&lt;b&gt;bold&lt;/b&gt;')));
}

// ── 2. Named entities beyond the XML five ───────────────────────────────────
{
  check('&eacute; decodes', (await titleFrom('Jos&eacute;')) === 'José', JSON.stringify(await titleFrom('Jos&eacute;')));
  check('&rsquo; decodes', (await titleFrom('it&rsquo;s')) === 'it’s', JSON.stringify(await titleFrom('it&rsquo;s')));
  check('&mdash; decodes', (await titleFrom('a&mdash;b')) === 'a—b', JSON.stringify(await titleFrom('a&mdash;b')));
  check('&hellip; decodes', (await titleFrom('a&hellip;')) === 'a…', JSON.stringify(await titleFrom('a&hellip;')));
  check('&ntilde; decodes', (await titleFrom('Mu&ntilde;oz')) === 'Muñoz', JSON.stringify(await titleFrom('Mu&ntilde;oz')));
  check('&uuml; decodes', (await titleFrom('M&uuml;ller')) === 'Müller', JSON.stringify(await titleFrom('M&uuml;ller')));
  // The XML five must keep working.
  check('&amp; still decodes', (await titleFrom('a &amp; b')) === 'a & b');
  check('a decimal entity still decodes', (await titleFrom('&#233;')) === 'é');
  check('a hex entity still decodes', (await titleFrom('&#x2013;')) === '–');
  check('an astral hex entity still decodes', (await titleFrom('&#x1F600;')) === '😀');
  // An entity outside the table survives verbatim — visible, not wrong.
  check('an unknown entity survives verbatim', (await titleFrom('a&notanentity;b')) === 'a&notanentity;b',
    JSON.stringify(await titleFrom('a&notanentity;b')));
}

// ── 3. Truncation never splits a surrogate pair ─────────────────────────────
{
  // The 300th UTF-16 unit is the high half of the emoji.
  const title = `${'a'.repeat(299)}😀${'b'.repeat(10)}`;
  const out = await titleFrom(title);
  check('the truncated title is 300 units', out.length === 300, `got ${out.length}`);
  check('it does not end in a lone high surrogate', !/[\uD800-\uDBFF]…$/.test(out),
    [...out.slice(-3)].map((c) => c.codePointAt(0).toString(16)).join(' '));
  check('it survives a UTF-8 round trip', Buffer.from(out, 'utf8').toString('utf8') === out);
  check('it ends with the ellipsis', out.endsWith('…'));
}

done('D90 the shared text helpers');
