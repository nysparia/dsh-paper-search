// test/d57-converter-timeout-kill.mjs — D57 (audit M5): the timeout sent
// SIGTERM and resolved immediately, so a child that ignored it kept running and
// wrote a complete `.md` AFTER the failure was reported.
//
// THE DEFECT.
//
//   const timer = setTimeout(() => {
//     try { child.kill(); } catch { }   // SIGTERM, and `done` fires at once
//     done('timeout');
//   }, timeoutMs);
//
// Measured 24 Nov 2026 with a converter that traps SIGTERM:
//
//   result: {"ok":false,"message":"timeout > 400 ms"}
//   child STILL ALIVE after the "timeout" (SIGTERM ignored)?: true
//
// and with one that writes 1.5 s later:
//
//   reported result: {"ok":false,"message":"timeout > 400 ms"}
//   md exists right after: false
//   md exists 2 s later: true
//   md content: "# LATE but complete conversion\n"
//
// The next call then served that file as a cache hit (H1).
//
// THE FIX. SIGTERM, then SIGKILL after a short grace period, and the promise
// resolves on `close` — not on the timer — so the function cannot return while
// the child can still write. The output goes to `<md>.part` and is renamed only
// on success, so even a write that slips through cannot land on the final name.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { convertToMarkdown } from '../lib/fulltext.js';
import { reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d57-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const pdf = join(root, 'paper.pdf');
writeFileSync(pdf, fakePdf());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. A converter that traps SIGTERM and writes 1.5 s later ───────────────
//
// It also drops a "still alive" marker at 1.2 s: if that file appears, the child
// survived the timeout, which is the defect itself.
const latePath = join(root, 'late.mjs');
const aliveMarker = join(root, 'still-alive.txt');
writeFileSync(latePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
const o = a[a.indexOf('-o') + 1];
process.on('SIGTERM', () => { /* ignored on purpose */ });
setTimeout(() => { writeFileSync(${JSON.stringify(aliveMarker)}, 'alive'); }, 1200);
setTimeout(() => { writeFileSync(o, '# LATE but complete conversion\\n'); }, 1500);
setTimeout(() => process.exit(0), 3000);
`);
chmodSync(latePath, 0o755);

const md = join(root, 'late.md');
const started = Date.now();
const r = await convertToMarkdown(pdf, md, { name: 'late', path: latePath, from: 'test' }, { timeoutMs: 300 });
const elapsed = Date.now() - started;

check('the timeout is reported as a failure', r.ok === false, JSON.stringify(r));
check('the reason is a timeout', /timeout >/.test(r.message ?? ''), r.message);
check('the call returned promptly, not after the child finished',
  elapsed < 2500, `${elapsed} ms with a 300 ms bound`);

// Wait past the moment the child would have written.
await sleep(1600);

check('the child did NOT survive the timeout (SIGKILL escalation)',
  !existsSync(aliveMarker), existsSync(aliveMarker) ? 'the child was still alive at 1.2 s' : 'dead');
check('no .md appeared after the failure was reported', !existsSync(md), md);
check('no .part file was left behind', !existsSync(`${md}.part`), `${md}.part`);

// ── 2. A converter that exits normally is untouched ────────────────────────
const goodPath = join(root, 'good.mjs');
writeFileSync(goodPath, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n'
  + 'const a = process.argv.slice(2); const o = a[a.indexOf("-o") + 1];\n'
  + 'writeFileSync(o, "# Converted\\n");\n');
chmodSync(goodPath, 0o755);
const goodMd = join(root, 'good.md');
const ok = await convertToMarkdown(pdf, goodMd, { name: 'good', path: goodPath, from: 'test' }, { timeoutMs: 5000 });
check('a converter that finishes in time still succeeds', ok.ok === true, JSON.stringify(ok));
check('the .md is at its final name', existsSync(goodMd), goodMd);
check('no .part file is left behind on success', !existsSync(`${goodMd}.part`), `${goodMd}.part`);

// ── 3. A converter that ignores SIGTERM but writes nothing is still bounded ─
const stubbornPath = join(root, 'stubborn.mjs');
writeFileSync(stubbornPath, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n');
chmodSync(stubbornPath, 0o755);
const stubbornMd = join(root, 'stubborn.md');
const t0 = Date.now();
const stubborn = await convertToMarkdown(pdf, stubbornMd, { name: 'stubborn', path: stubbornPath, from: 'test' }, { timeoutMs: 200 });
const stubbornElapsed = Date.now() - t0;
check('a SIGTERM-ignoring converter is still reported as a timeout',
  stubborn.ok === false && /timeout >/.test(stubborn.message ?? ''), stubborn.message);
check('and the call is still bounded (SIGKILL lands within the grace period)',
  stubbornElapsed < 3000, `${stubbornElapsed} ms`);

rmSync(root, { recursive: true, force: true });
done('D57 converter timeout: SIGTERM only, and a late write');
