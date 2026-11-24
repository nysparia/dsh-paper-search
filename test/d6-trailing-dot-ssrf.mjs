// test/d6-trailing-dot-ssrf.mjs — D6: a trailing dot on the host bypassed the guard.
//
// Measured on baseline 864a6e8:
//   http://localhost/   -> BLOCK
//   http://localhost./  -> SAFE      <- and `dns.lookup('localhost.')` returns ::1
//   http://foo.local./  -> SAFE
//
// A trailing dot is a valid FQDN root, so `localhost.` is the same host as
// `localhost` — the guard has to compare the name WITHOUT it.
import { isSafeUrl } from '../lib/fulltext.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const blocked = [
  'http://localhost/',
  'http://localhost./',
  'http://LOCALHOST./',
  'http://localhost.:8080/x.pdf',
  'http://foo.local./',
  'http://foo.internal./',
  'http://foo.home.arpa./',
  'http://a.b.localhost./',
];
for (const url of blocked) {
  const v = isSafeUrl(url);
  check(`blocked: ${url}`, v.safe === false, v.safe ? 'guard said SAFE' : v.reason);
}

// The fix must not turn into "block everything": a public host stays safe, and a
// single trailing dot on it is still the same public host.
for (const url of ['https://example.com/paper.pdf', 'https://example.com./paper.pdf']) {
  const v = isSafeUrl(url);
  check(`safe: ${url}`, v.safe === true, v.safe ? '' : v.reason);
}

// Existing rules must not be weakened by the stripping.
check('still blocks a private IPv4', isSafeUrl('http://127.0.0.1/x.pdf').safe === false);
check('still blocks a private IPv6', isSafeUrl('http://[::1]/x.pdf').safe === false);
check('still blocks a non-http scheme', isSafeUrl('file:///etc/passwd').safe === false);

done('D6 trailing-dot SSRF bypass');
