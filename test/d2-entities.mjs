// D2 — HTML entities are never decoded, and one author becomes two.
//
// Measured on baseline 864a6e8:
//   authorList(["It&#x27;s a test"])   -> ["It&#x27","s a test"]
//   authorList(["O&#x27;Brien, Sean"]) -> ["O&#x27","Brien, Sean"]   <- ONE author became TWO
//   authorList(["caf&#233;"])          -> ["caf&#233"]
//   authorList(["A &amp; B"])          -> ["A &amp","B"]
//
// Two independent faults: hex entities are not matched by the decoder at all,
// and `authorList` splits on `;` BEFORE decoding — every entity ends with `;`,
// so an entity inside a name splits that name in two.

import { authorList } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

// ── the four measured cases ──────────────────────────────────────────────────
check('hex entity: apostrophe does not split the name',
  authorList(["It&#x27;s a test"]), ["It's a test"]);

check('hex entity: O\'Brien stays ONE author',
  authorList(["O&#x27;Brien, Sean"]), ["O'Brien, Sean"]);

check('decimal entity: café decodes',
  authorList(["caf&#233;"]), ['café']);

check('named entity: &amp; does not split the name',
  authorList(["A &amp; B"]), ['A & B']);

// ── the separator must still work ────────────────────────────────────────────
check('a genuine ";" separator still yields two authors',
  authorList(["Smith; Jones"]), ['Smith', 'Jones']);

check('a genuine ";" separator with entities on both sides',
  authorList(["O&#x27;Brien, Sean; caf&#233;"]), ["O'Brien, Sean", 'café']);

// ── other shapes that reach the same decoder ─────────────────────────────────
check('hex em dash decodes',
  authorList(["Smith &#x2014; Jones"]), ['Smith — Jones']);

check('uppercase hex digits decode',
  authorList(["O&#X27;Brien"]), ["O'Brien"]);

check('named entity table still works (&quot; &nbsp; &amp;)',
  authorList(['a &quot;b&quot;&nbsp;&amp;&nbsp;c']), ['a "b" & c']);

// An UNKNOWN entity is left as literal text (the table is not a whitelist that
// eats what it does not know), and its `;` is then a genuine separator — the
// same as on the baseline. Pinned so a future decoder change is visible.
check('an unknown entity is left alone, not eaten',
  authorList(['x &bogus; y']), ['x &bogus', 'y']);

check('an entity without a trailing semicolon is left alone',
  authorList(['AT&T']), ['AT&T']);

done('D2 entity decoding');
