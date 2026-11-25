// test/d93-arxiv-entry-parsing.mjs — `parseArxiv` matched `<entry>` literally
// and lost four shapes of a real Atom feed without saying so.
//
// THE DEFECTS, all measured 25 Nov 2026 against `parseArxiv` directly:
//
//   <entry xml:base="…">            -> 0 papers, error null
//   <![CDATA[…]]> title             -> 0 papers, error null
//   <arxiv:title>                   -> 0 papers, error null
//   first </entry> missing          -> 1 paper carrying BOTH author lists
//   <title type="a>b">              -> title `b">Attention Is All You Need`
//   <arxiv:affiliation> before <name> -> authors []
//
// The first three are the same defect shape as the IACR one (`test/d91`): a feed
// that HAS entries was reported as a feed with no results. Atom permits
// attributes on `<entry>`, and the live feed uses a plain `<entry>` (fetched
// 25 Nov 2026), so this was latent — not active — but silent for every future
// query.
//
// WHAT MUST STILL WORK. A feed with genuinely zero entries is still an empty
// answer (`[]`, no throw), a PARTIAL drop is still not a failure, and `rows`
// still caps the list.
//
// `parseArxiv` is called directly rather than through `searchSource` because
// every other way in goes through `arxivWait`, which self-throttles to one
// request per 3 seconds (arXiv's TOU) — seven shapes through the search path
// would spend 20 seconds asleep for no extra coverage.

import { parseArxiv } from '../lib/sources.js';
import { check, outcome } from './harness.mjs';

const feed = (entries) => `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>arXiv Query</title>
${entries}
</feed>`;

const entry = (inner, attrs = '') => `  <entry${attrs}>
${inner}
  </entry>`;

const good = (title = 'Attention Is All You Need') => entry(`    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>${title}</title>
    <summary>  The dominant sequence transduction models.  </summary>
    <author>
      <name>Ashish Vaswani</name>
    </author>
    <author>
      <name>Noam Shazeer</name>
    </author>`);

// ── 1. Baseline: the shape the live feed actually uses ────────────────────
{
  const r = parseArxiv(feed(good()), 5);
  check('a plain <entry> parses', r.length === 1, String(r.length));
  check('the title is read', r[0]?.title === 'Attention Is All You Need', r[0]?.title ?? '(none)');
  check('both authors are read', (r[0]?.authors ?? []).length === 2, JSON.stringify(r[0]?.authors));
  check('the year comes from <published>', r[0]?.year === 2017, String(r[0]?.year));
  check('the url comes from <id>', r[0]?.url === 'http://arxiv.org/abs/1706.03762v7', r[0]?.url ?? '(none)');
}

// ── 2. M3: `<entry>` carrying an attribute is still an entry ──────────────
{
  const r = parseArxiv(feed(entry(`    <title>Attention Is All You Need</title>
    <author><name>Ashish Vaswani</name></author>`, ' xml:base="http://arxiv.org/"')), 5);
  check('an <entry xml:base="…"> parses', r.length === 1, String(r.length));
  check('and its title is read', r[0]?.title === 'Attention Is All You Need', r[0]?.title ?? '(none)');
}
{
  const r = parseArxiv(feed(entry(`    <title>A Paper</title>`, ' type="x"')), 5);
  check('an <entry type="x"> parses', r.length === 1, String(r.length));
}

// ── 3. M3: entries present but nothing parsed is an ERROR, not emptiness ──
{
  const cdata = await outcome(() => parseArxiv(feed(good('<![CDATA[Attention Is All You Need]]>')), 5));
  check('a CDATA title is reported as a parse failure', cdata.threw === true, JSON.stringify(cdata.value ?? cdata.message));
  check('and the message says the feed was not understood', /not understood/i.test(cdata.message ?? ''), cdata.message ?? '');
}
{
  const ns = await outcome(() => parseArxiv(feed(good().replace(/<title>/g, '<arxiv:title>').replace(/<\/title>/g, '</arxiv:title>')), 5));
  check('a namespace-prefixed title is reported as a parse failure', ns.threw === true, JSON.stringify(ns.value ?? ns.message));
}

// ── 4. L1: a malformed entry must not merge two entries into one ──────────
{
  const merged = feed(`  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>First Paper Title</title>
    <author><name>A</name></author>
  <entry>
    <id>http://arxiv.org/abs/2106.12345v1</id>
    <title>Second Paper Title</title>
    <author><name>B</name></author>
  </entry>`);
  const r = await outcome(() => parseArxiv(merged, 5));
  check('a missing </entry> is reported as a parse failure', r.threw === true, JSON.stringify(r.value ?? r.message));
  check('and it counts the tags', /2 <entry> tag\(s\) but 1 complete entry/.test(r.message ?? ''), r.message ?? '');
}

// ── 5. L2: an attribute value containing `>` must not corrupt the title ───
{
  const r = parseArxiv(feed(good().replace('<title>', '<title type="a>b">')), 5);
  check('a title with `>` inside an attribute is read whole',
    r[0]?.title === 'Attention Is All You Need', JSON.stringify(r[0]?.title));
}

// ── 6. L3: an element between <author> and <name> must not empty the list ─
{
  const r = parseArxiv(feed(good().replace(/<author>/g, '<author>\n      <arxiv:affiliation>Google</arxiv:affiliation>')), 5);
  check('an affiliation before <name> does not lose the authors',
    (r[0]?.authors ?? []).length === 2, JSON.stringify(r[0]?.authors));
  check('and the names are right', r[0]?.authors?.[0] === 'Ashish Vaswani', JSON.stringify(r[0]?.authors));
}

// ── 7. No regression: a feed with zero entries is a VALID empty answer ────
{
  const r = await outcome(() => parseArxiv(feed(''), 5));
  check('a feed with no entries does not throw', r.threw === false, r.message ?? '');
  check('and returns an empty list', (r.value ?? []).length === 0, String((r.value ?? []).length));
}

// ── 8. No regression: a PARTIAL drop is not a failure ─────────────────────
{
  const r = await outcome(() => parseArxiv(feed(`${good('First Paper Title')}
${entry(`    <id>http://arxiv.org/abs/2106.12345v1</id>
    <author><name>Someone</name></author>`)}`), 5));
  check('one untitled entry among titled ones does not throw', r.threw === false, r.message ?? '');
  check('and the titled entry is returned', (r.value ?? []).length === 1, String((r.value ?? []).length));
}

// ── 9. No regression: `rows` still caps the list ──────────────────────────
{
  const many = feed(Array.from({ length: 5 }, (_, i) => good(`Paper ${i}`)).join('\n'));
  check('rows caps the parsed list', parseArxiv(many, 2).length === 2, String(parseArxiv(many, 2).length));
}

console.log('\nD93 arXiv entry parsing: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
