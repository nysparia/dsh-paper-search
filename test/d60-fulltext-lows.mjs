// test/d60-fulltext-lows.mjs — D79 (audit L2, L3, L4, L7): four small defects in
// `lib/fulltext.js`, each measured 24 Nov 2026.
//
//   L2  `http://[2001:0:0:0:0:0:0:1]/` was reported SAFE. The Teredo branch
//       treated every `2001:0::/32` address as Teredo, bit-inverted the last 32
//       bits (`::1` -> 255.255.255.254) and called that public. A real Teredo
//       address carries the Teredo SERVER's IPv4 in groups 2–3; this one carries
//       nothing, so the address it tunnels to cannot be recovered.
//   L3  `pdfCandidates` kept `file:///etc/passwd`, `ftp://x/y.pdf`, `42` and
//       `{href: …}`. They were refused later by `isSafeUrl`, but the candidate
//       list is printed to the user on failure, so a hostile reply got its
//       `file:///etc/passwd` echoed back as a "PDF candidate tried".
//   L4  The Unpaywall URL carried the user's email and was printed on failure:
//       `…?email=secret.person%40university.edu`.
//   L7  `convertToMarkdown` leaked one file descriptor per call when the `.err`
//       path could not be opened: 21 calls took the count from 22 to 43.
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { convertToMarkdown, isSafeUrl, pdfCandidates, prepareFullText } from '../lib/fulltext.js';
import { installFetch, reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d79-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// ── L2: the Teredo classification ──────────────────────────────────────────
check('http://[2001:0:0:0:0:0:0:1]/ is NOT reported safe',
  isSafeUrl('http://[2001:0:0:0:0:0:0:1]/').safe === false,
  JSON.stringify(isSafeUrl('http://[2001:0:0:0:0:0:0:1]/')));
check('the reason says the tunnelled IPv4 cannot be determined',
  /Teredo|cannot be determined/i.test(isSafeUrl('http://[2001:0:0:0:0:0:0:1]/').reason ?? ''),
  isSafeUrl('http://[2001:0:0:0:0:0:0:1]/').reason ?? '(none)');

// A REAL Teredo address (server IPv4 in groups 2–3) is still unwrapped: the
// client address is the last 32 bits, bit-inverted.
//   2001:0:4136:e378:8000:63bf:80ff:fffe  ->  client 127.0.0.1
check('a real Teredo address tunnelling to 127.0.0.1 is refused',
  isSafeUrl('http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/').safe === false,
  JSON.stringify(isSafeUrl('http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/')));
check('the reason names the embedded loopback address',
  /127\.0\.0\.1/.test(isSafeUrl('http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/').reason ?? ''),
  isSafeUrl('http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/').reason ?? '(none)');
// …and one tunnelling to a public address stays safe. The client IPv4 is the
// last 32 bits bit-inverted, so 8.8.8.8 is carried as f7f7:f7f7.
check('a real Teredo address tunnelling to a public address stays safe',
  isSafeUrl('http://[2001:0:4136:e378:8000:63bf:f7f7:f7f7]/').safe === true,
  JSON.stringify(isSafeUrl('http://[2001:0:4136:e378:8000:63bf:f7f7:f7f7]/')));

// The forms the audit lists as CLEAN must stay clean.
for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[2002:7f00:1::]/', 'http://[64:ff9b::127.0.0.1]/']) {
  check(`${url} is still refused`, isSafeUrl(url).safe === false, JSON.stringify(isSafeUrl(url)));
}
for (const url of ['http://8.8.8.8/', 'http://[2001:4860:4860::8888]/', 'http://example.com/']) {
  check(`${url} is still safe`, isSafeUrl(url).safe === true, JSON.stringify(isSafeUrl(url)));
}

// ── L3: pdfCandidates keeps only http(s) strings ───────────────────────────
{
  const work = {
    title: 'A paper',
    locations: [
      { is_oa: true, pdf_url: 'file:///etc/passwd' },
      { is_oa: true, pdf_url: 'ftp://x/y.pdf' },
      { is_oa: true, pdf_url: 42 },
      { is_oa: true, pdf_url: { href: 'https://x/y.pdf' } },
      { is_oa: true, pdf_url: 'https://example.org/real.pdf' },
    ],
  };
  const list = pdfCandidates(work);
  check('a file:// URL is not a candidate', !list.some((c) => c.url.startsWith('file:')),
    list.map((c) => c.url).join(' | '));
  check('an ftp:// URL is not a candidate', !list.some((c) => c.url.startsWith('ftp:')),
    list.map((c) => c.url).join(' | '));
  check('a non-string pdf_url is not a candidate', list.every((c) => typeof c.url === 'string'),
    list.map((c) => typeof c.url).join(' | '));
  check('the real https URL is still a candidate',
    list.some((c) => c.url === 'https://example.org/real.pdf'), list.map((c) => c.url).join(' | '));
}

// ── L4: the Unpaywall candidate carries no email ───────────────────────────
{
  const libRoot = join(root, 'unpaywall');
  mkdirSync(join(libRoot, 'md'), { recursive: true });
  const mock = installFetch(() => ({ status: 404, body: 'not mocked' }));
  const h = await prepareFullText({
    work: { doi: '10.1038/nature14539', title: 'A paper', publication_year: 2015 },
    identifier: '10.1038/nature14539',
    email: 'secret.person@university.edu',
    converter: { name: 'x', path: '/bin/true', from: 'test' },
    root: libRoot, findArxiv: async () => null,
  });
  mock.restore();
  const printed = (h.candidates ?? []).map((c) => c.url).join(' | ');
  check('the Unpaywall candidate is still listed', /api\.unpaywall\.org/.test(printed), printed || '(none)');
  check('the printed candidate does not contain the user\'s email',
    !/secret\.person|university\.edu|email=/i.test(printed), printed);
  check('the request itself still carried the email',
    mock.calls.some((c) => /email=secret\.person%40university\.edu/.test(c.url)),
    mock.calls.map((c) => c.url).join(' | ') || 'no calls');
}

// ── L7: no file descriptor leak when the .err path cannot be opened ────────
{
  const pdf = join(root, 'paper.pdf');
  writeFileSync(pdf, fakePdf());
  const badDir = join(root, 'bad');
  mkdirSync(badDir, { recursive: true });
  // `<md>.err` is a DIRECTORY, so `openSync(errorFile, 'w')` throws after the
  // output descriptor is already open.
  const md = join(badDir, 'x.md');
  mkdirSync(`${md}.err`, { recursive: true });

  const fdCount = () => readdirSync('/proc/self/fd').length;
  const before = fdCount();
  let threw = 0;
  for (let i = 0; i < 20; i++) {
    try { await convertToMarkdown(pdf, md, { name: 'x', path: '/bin/true', from: 'test' }); } catch { threw++; }
  }
  const after = fdCount();
  check('the unopenable .err path really does throw', threw === 20, `${threw} of 20`);
  check('20 failed calls leak no file descriptors', after - before === 0,
    `before=${before} after=${after} delta=${after - before}`);
}

rmSync(root, { recursive: true, force: true });
done('D60 fulltext LOWs: Teredo, candidate filtering, email redaction, fd leak');
