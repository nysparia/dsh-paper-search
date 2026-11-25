// test/d97-worknumber-whitespace.mjs — `workNumber('   ')` returned `0`.
//
// THE DEFECT. Only `''` was guarded, so a whitespace-only string reached
// `Number('   ')`, which is **0**, and `Number.isFinite(0)` is true. Measured
// 25 Nov 2026 on the baseline:
//
//   null    -> citedBy null
//   ""      -> citedBy null
//   "   "   -> citedBy 0        <- wrong
//   "\t\n"  -> citedBy 0        <- wrong
//   false   -> citedBy 0        <- wrong
//   []      -> citedBy 0        <- wrong
//
// A platform that pads a missing count with spaces produced "0 citations" — the
// exact confusion the helper exists to prevent, and then `min_citations` treated
// the record as a real zero instead of "unknown".
//
// `workNumber` is not exported, so this is driven through a connector that
// passes the raw platform value straight into `makePaper` (`europepmc`'s
// `citedByCount`).
//
// WHAT MUST STILL WORK. A real 0 — the number 0 or the string "0" — is still 0.

import { searchSource } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Europe PMC reply carrying `citedByCount: value`. */
function serveCount(value) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      resultList: { result: [{ id: '1', title: 'A record', pubYear: '2024', citedByCount: value }] },
    }),
  });
}

const citedByOf = async (value) => {
  serveCount(value);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  return h.papers[0]?.citedBy;
};

// ── 1. THE DEFECT: a blank is not a zero ──────────────────────────────────
check('a whitespace-only count is null', await citedByOf('   '), null);
check('a tab/newline count is null', await citedByOf('\t\n'), null);
check('an empty string count is null', await citedByOf(''), null);
check('a null count is null', await citedByOf(null), null);
check('an absent count is null', await citedByOf(undefined), null);
check('a boolean count is null', await citedByOf(false), null);
check('an array count is null', await citedByOf([]), null);

// ── 2. A real zero is still a zero ────────────────────────────────────────
check('the number 0 stays 0', await citedByOf(0), 0);
check('the string "0" stays 0', await citedByOf('0'), 0);
check('a padded "0" stays 0', await citedByOf(' 0 '), 0);

// ── 3. A real count is unchanged ──────────────────────────────────────────
check('a real count is carried through', await citedByOf(740), 740);
check('a numeric string is carried through', await citedByOf('740'), 740);

// ── 4. The consequence: a blank count is "unknown", not "below threshold" ─
{
  const { filterAndSort } = await import('../lib/index.js');
  serveCount('   ');
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  const f = filterAndSort(h.papers, { minCitations: 10 });
  check('a blank count is counted as "no citation count"', f.dropped.noCitations, 1);
  check('a blank count is NOT counted as "below the threshold"', f.dropped.lowCitations, 0);
}

globalThis.fetch = realFetch;
done('D97 workNumber whitespace');
