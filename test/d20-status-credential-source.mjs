// test/d20-status-credential-source.mjs — D20: `paper_status` reported a source
// it never consulted.
//
// Baseline dbd5583 printed `← environment variable` from its own reader, while
// DSH's `describe()` can report `configured` / `source` / `writable` / `masked`.
// With a key stored through the DSH configuration UI the line said
// `OPENALEX_API_KEY               EMPTY` — the key was stored and the doctor
// said it was not.
//
// The seam's own answer must be printed when the seam is present; the existing
// wording stays when it is absent, because it is then the truth. The
// `filled (N characters)` line stays either way: it is what tells a user the
// key is non-empty without revealing it.
//
// Run: node test/d20-status-credential-source.mjs

import { check, fakeCredentials, loadTools } from './harness.mjs';

const lineFor = (report, name) => report.split('\n').find((l) => l.includes(name)) ?? '';

// ── The seam is present: its `source` is what gets printed ─────────────────
{
  const tools = loadTools({ cache: false }, {
    credentials: fakeCredentials({ OPENALEX_API_KEY: 'OA-SEAM-KEY-789' }, 'file'),
  });
  const report = await tools.get('paper_status').execute({});
  const line = lineFor(report, 'OPENALEX_API_KEY');

  check('paper_status reports the key as filled', /filled \(\d+ characters\)/.test(line), line);
  check('paper_status prints the seam\'s source', /←\s*file/.test(line), line);
  check('paper_status does not claim the environment when the seam says file',
    !/environment variable/.test(line), line);
  check('paper_status does not print the key value', !report.includes('OA-SEAM-KEY-789'));
}

// ── A different source string is echoed verbatim, not mapped to a fixed word ─
// `credentials-local` reports `file`, `env`, `project-env` and `user-env`
// (credentials-local/src/index.ts:638-655). A reader that hard-coded "file"
// would pass the assertion above and still lie for the other three.
{
  const tools = loadTools({ cache: false }, {
    credentials: fakeCredentials({ OPENALEX_API_KEY: 'OA-SEAM-KEY-789' }, 'project-env'),
  });
  const report = await tools.get('paper_status').execute({});
  const line = lineFor(report, 'OPENALEX_API_KEY');
  check('paper_status echoes a non-file source verbatim', /←\s*project-env/.test(line), line);
}

// ── The masked preview is printed when the seam supplies one ───────────────
{
  const tools = loadTools({ cache: false }, {
    credentials: fakeCredentials({ OPENALEX_API_KEY: 'OA-SEAM-KEY-789' }, 'file'),
  });
  const report = await tools.get('paper_status').execute({});
  const line = lineFor(report, 'OPENALEX_API_KEY');
  check('paper_status prints the masked preview', line.includes('••••••••'), line);
}

// ── An unconfigured reference still reads EMPTY, with no invented source ───
{
  const tools = loadTools({ cache: false }, { credentials: fakeCredentials({}) });
  const report = await tools.get('paper_status').execute({});
  const line = lineFor(report, 'OPENALEX_API_KEY');
  check('an unconfigured reference reads EMPTY', /EMPTY/.test(line), line);
  check('an unconfigured reference prints no source', !/←/.test(line), line);
}

// ── With no seam the old wording is kept, because it is then the truth ─────
{
  const saved = process.env.OPENALEX_API_KEY;
  process.env.OPENALEX_API_KEY = 'OA-FROM-ENV';
  let report = '';
  try {
    const tools = loadTools({ cache: false });
    report = await tools.get('paper_status').execute({});
  } finally {
    if (saved === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = saved;
  }
  const line = lineFor(report, 'OPENALEX_API_KEY');
  check('without the seam the environment wording is kept', /←\s*environment variable/.test(line), line);
  check('without the seam the key still reads as filled', /filled \(\d+ characters\)/.test(line), line);
}

console.log(process.exitCode ? '\nFAILED' : '\nOK');
