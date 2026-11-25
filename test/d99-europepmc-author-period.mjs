// test/d99-europepmc-author-period.mjs — the last Europe PMC author kept the
// sentence-final period.
//
// THE DEFECT. Europe PMC terminates `authorString` with a period, so the LAST
// author carried it while every other name was clean. Measured live 25 Nov 2026:
//
//   "Jäckle K, Kramer M, Meier MP, Hawellek T, Roch PJ, Homann C, Castro WHM,
//    Wagner H, Boström K, Lehmann W, Weiser L."
//     -> authors: […, "Weiser L."]      <- the period belongs to the sentence
//
// The period is the SENTENCE terminator, not part of the name, so it is stripped
// from the final element only.
//
// THE TRAP. A period inside a name is part of the name. `"J. Smith"` must not
// become `"J Smith"`, and a bare initial (`"S."`) must be left alone because
// there the period IS the whole name. Only the FINAL character of the FINAL
// element is ever considered.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Europe PMC reply with the given `authorString`. */
function serve(authorString) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      resultList: { result: [{ id: '1', title: 'A paper', pubYear: '2024', authorString }] },
    }),
  });
}

const authorsOf = async (s) => {
  serve(s);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  return h.papers[0]?.authors ?? [];
};

// ── 1. THE DEFECT: the sentence period is gone ────────────────────────────
{
  const a = await authorsOf('Skov S, Werling K, O\'Day J, Hicks J, Liu CK, Delp S.');
  check('the last author has no trailing period', a.at(-1) === 'Delp S', JSON.stringify(a.at(-1)));
  check('the other authors are unchanged', a.slice(0, 5).join('|') === "Skov S|Werling K|O'Day J|Hicks J|Liu CK",
    a.slice(0, 5).join('|'));
  check('no name carries a trailing period', a.every((n) => !n.endsWith('.')), JSON.stringify(a));
}

// ── 2. A period INSIDE a name is part of the name ─────────────────────────
{
  const a = await authorsOf('J. Smith, Delp S.');
  check('an initial inside a name keeps its period', a[0] === 'J. Smith', JSON.stringify(a[0]));
  check('the final sentence period is still stripped', a.at(-1) === 'Delp S', JSON.stringify(a.at(-1)));
}

// ── 3. A single author with the sentence period ───────────────────────────
{
  const a = await authorsOf('Delp S.');
  check('a single author loses the sentence period', a.length === 1 && a[0] === 'Delp S', JSON.stringify(a));
}

// ── 4. A bare initial is left alone ───────────────────────────────────────
// "S." is the whole name; stripping the period would leave a single letter with
// no indication that it is an initial.
{
  const a = await authorsOf('S.');
  check('a bare initial keeps its period', a.length === 1 && a[0] === 'S.', JSON.stringify(a));
}

// ── 5. A string with no sentence period is unchanged ──────────────────────
{
  const a = await authorsOf('Skov S, Delp S');
  check('no period: the last author is unchanged', a.at(-1) === 'Delp S', JSON.stringify(a.at(-1)));
}

// ── 6. An empty authorString is still an empty list ───────────────────────
{
  const a = await authorsOf('');
  check('an empty authorString yields no authors', a.length === 0, JSON.stringify(a));
}

globalThis.fetch = realFetch;
console.log('\nD99 europepmc author period: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
