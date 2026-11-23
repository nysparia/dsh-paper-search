// lib/fulltext.js — ambil PDF akses-terbuka, lalu ubah ke Markdown.
//
// KENAPA ADA
//   Model tidak bisa membaca PDF mentah. Markdown jauh lebih hemat token dan
//   bisa dibaca UTUH oleh agen lewat tool `read` (offset/limit) — termasuk saat
//   berkasnya 40–80 ribu huruf, yang tidak mungkin dikirim dalam satu jawaban
//   tool. Jadi hasil konversi ditulis ke BERKAS, dan yang dikembalikan adalah
//   jalurnya + cuplikan.
//
// KONVERSINYA TIDAK DITULIS ULANG DI SINI
//   Dipakai alat yang sudah ada: `anydoc` (Rust, CLI, npm `@firecrawl/anydoc`)
//   lebih dulu, `markitdown` sebagai cadangan. Terukur 29 Sep 2026 di mesin ini:
//   PDF arXiv 2,1 MB -> 39,8 KB Markdown dalam **424 ms**; PDF PLOS 2,9 MB ->
//   70,8 KB dalam **363 ms**, lengkap dengan tautan rujukan.
//
// ATURAN YANG TIDAK DILANGGAR
//   - hanya salinan AKSES-TERBUKA (arXiv, lokasi OA OpenAlex/Unpaywall);
//   - TIDAK menembus paywall, tidak memakai Sci-Hub / Anna's Archive;
//   - kalau tidak ada salinan sah, dikatakan terus terang — bukan dikosongkan.
//
// JEBAKAN YANG DIHINDARI
//   Menangkap keluaran anak lewat PIPE bisa ditolak `EPERM` di mode sandbox
//   ketat (batas yang sudah terdokumentasi di proyek ini). Karena itu proses
//   anak diberi **file descriptor berkas**, bukan pipe — pola yang sudah
//   dibuktikan `arsip-dump\uji-pipe-sandbox.mjs`.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { ringkasOA, idArxivDariKarya, padananArxiv, normDoi } from './sources.js';

const UA = 'dsh-paper-search/0.1 (+https://github.com/rasyidmmz/dsh-paper-search)';
const TIMEOUT_UNDUH_MS = 120000;
const TIMEOUT_KONVERSI_MS = 180000;

/** Akar perpustakaan Markdown. Bisa ditimpa lewat config plugin `folderTeksLengkap`. */
export const AKAR_BAWAAN = join(homedir(), '.dsh', 'paper-search');

// ── Mencari konverter ────────────────────────────────────────────────────────

/** Kandidat jalur CLI yang lazim di mesin ini (PATH belum tentu memuatnya). */
function jalurLazim(nama, exeWindows) {
  const keluar = [];
  const ext = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const e of ext) keluar.push(join(dir, nama + e));
  }
  const rumah = homedir();
  const appdata = process.env.APPDATA ?? join(rumah, 'AppData', 'Roaming');
  keluar.push(
    join(appdata, 'npm', `${nama}.cmd`),                      // npm -g di Windows
    join(appdata, 'uv', 'tools', nama, 'Scripts', exeWindows), // uv tool install
    join(rumah, '.local', 'bin', exeWindows),
    join(rumah, '.local', 'bin', nama),
  );
  return [...new Set(keluar)].filter((p) => p && existsSync(p));
}

/**
 * Konverter mana yang benar-benar ADA di mesin ini.
 * `anydoc` diutamakan (cepat, Rust, tanpa Python); `markitdown` cadangan.
 * Mengembalikan `null` kalau tidak ada satu pun — dan itu dilaporkan apa adanya,
 * bukan disembunyikan sampai fitur ini tampak "rusak".
 */
export function cariKonverter(config = {}) {
  const daftar = [];
  const anydocConfig = config.anydocPath ?? config.ANYDOC_PATH;
  if (anydocConfig) daftar.push({ nama: 'anydoc', jalur: anydocConfig, dari: 'config plugin' });
  for (const p of jalurLazim('anydoc', 'anydoc.exe')) daftar.push({ nama: 'anydoc', jalur: p, dari: 'jalur lazim' });

  const mdConfig = config.markitdownPath ?? config.MARKITDOWN_PATH;
  if (mdConfig) daftar.push({ nama: 'markitdown', jalur: mdConfig, dari: 'config plugin' });
  for (const p of jalurLazim('markitdown', 'markitdown.exe')) daftar.push({ nama: 'markitdown', jalur: p, dari: 'jalur lazim' });

  for (const k of daftar) if (existsSync(k.jalur)) return k;
  return null;
}

/** `.cmd`/`.bat` di Windows tidak bisa dijalankan langsung — harus lewat cmd.exe. */
function perluShell(jalur) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(jalur);
}

/**
 * Argumen untuk `spawn`. Untuk `*.cmd` kita TIDAK memakai `shell: true`:
 * Node memperingatkan (`DEP0190`) bahwa argumen tidak di-escape di mode itu.
 * Yang dipakai: jalankan `cmd.exe /d /c <skrip> <arg…>` — perilakunya sama,
 * tetapi argumen tetap dikirim sebagai daftar dan tidak memicu peringatan itu.
 */
function perintahSpawn(konverter, args) {
  if (perluShell(konverter.jalur)) {
    return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', konverter.jalur, ...args] };
  }
  return { cmd: konverter.jalur, args };
}

/**
 * Ubah PDF menjadi Markdown di `md`.
 * Keluaran anak diarahkan ke BERKAS lewat file descriptor (bukan pipe), dan
 * stderr ditangkap terpisah supaya pesan aslinya bisa dilaporkan.
 */
export async function konversiKeMarkdown(pdf, md, konverter, { timeoutMs = TIMEOUT_KONVERSI_MS } = {}) {
  if (!existsSync(pdf)) return { ok: false, pesan: `PDF tidak ada: ${pdf}` };
  if (existsSync(md)) { try { unlinkSync(md); } catch { /* biarkan; akan ditimpa */ } }
  const berkasGalat = `${md}.err`;
  const fdOut = openSync(md, 'w');
  const fdErr = openSync(berkasGalat, 'w');
  let berhasil = false;
  try {
    // `-o <path>` dipakai anydoc DAN markitdown versi baru. Kalau konverternya
    // tidak mengenal `-o`, keluaran kosong -> dilaporkan sebagai kegagalan.
    const args = [pdf, '-o', md];
    const { cmd, args: argv } = perintahSpawn(konverter, args);
    const kode = await new Promise((selesai) => {
      let anak;
      try {
        anak = spawn(cmd, argv, { stdio: ['ignore', fdOut, fdErr], windowsHide: true });
      } catch (e) {
        selesai(`spawn-gagal: ${e?.message ?? e}`);
        return;
      }
      const jam = setTimeout(() => {
        try { anak.kill(); } catch { /* sudah mati */ }
        selesai('timeout');
      }, timeoutMs);
      anak.on('error', (e) => { clearTimeout(jam); selesai(`spawn-gagal: ${e?.message ?? e}`); });
      anak.on('close', (c) => { clearTimeout(jam); selesai(c); });
    });

    const galat = existsSync(berkasGalat) ? readFileSync(berkasGalat, 'utf8').trim().slice(0, 400) : '';
    const ukuran = existsSync(md) ? statSync(md).size : 0;
    if (kode === 0 && ukuran > 0) { berhasil = true; return { ok: true, byte: ukuran, pesan: galat }; }
    const sebab = kode === 'timeout' ? `timeout > ${Math.round(timeoutMs / 1000)} dtk`
      : typeof kode === 'number' && kode !== 0 ? `kode keluar ${kode}`
        : String(kode);
    return { ok: false, pesan: [sebab, galat].filter(Boolean).join(' — ').slice(0, 500) };
  } finally {
    closeSync(fdOut);
    closeSync(fdErr);
    // Berkas galat hanya berguna saat GAGAL. Pada sukses isinya kosong dan dulu
    // menumpuk satu per paper (terukur 29 Sep 2026: 1 berkas 0 byte per konversi).
    // Dihapus SESUDAH descriptor ditutup — di Windows, menghapus berkas yang
    // masih terbuka akan gagal.
    if (berhasil) {
      try { unlinkSync(berkasGalat); } catch { /* biarkan */ }
    } else {
      // GAGAL: buang Markdown KOSONG sisa percobaan supaya folder perpustakaan
      // tidak menyimpan berkas 0 byte. Berkas `.err` SENGAJA dibiarkan — isinya
      // pesan asli konverter, dan pemanggil sudah membacanya di atas.
      // (Pemanggil lain aman: baris 243 mensyaratkan size > 0.)
      try { if (existsSync(md) && statSync(md).size === 0) unlinkSync(md); } catch { /* biarkan */ }
    }
  }
}

// ── Mencari & mengunduh PDF ──────────────────────────────────────────────────

/**
 * Daftar PDF akses-terbuka yang layak dicoba, URUT: **arXiv lebih dulu**
 * (PR upstream #124), baru lokasi OA OpenAlex.
 *
 * `arxivId` diisi hasil `padananArxiv()` kalau karya itu sendiri tidak menyebut
 * arXiv-nya — pemanggil yang mencari, supaya fungsi ini tetap murni & bisa diuji
 * tanpa jaringan.
 */
export function kandidatPdf(work, { arxivId = null } = {}) {
  const keluar = [];
  const tambah = (url, dari, catatan) => {
    if (!url || keluar.some((k) => k.url === url)) return;
    keluar.push({ url, dari, catatan });
  };

  const idArxiv = arxivId ?? idArxivDariKarya(work);
  if (idArxiv) {
    tambah(`https://arxiv.org/pdf/${idArxiv}`, 'arxiv', `pra-cetak arXiv ${idArxiv} — biasanya paling cepat & paling sering kena`);
  }
  const oa = ringkasOA(work);
  for (const l of oa.lokasi) {
    if (!l.pdf) continue;
    const rinci = [l.license ? `lisensi ${l.license}` : null, l.version ? `versi ${l.version}` : null, l.sumber]
      .filter(Boolean).join(' · ');
    tambah(l.pdf, 'openalex', rinci || 'lokasi akses-terbuka OpenAlex');
  }
  return keluar;
}

/** Nama berkas aman dari DOI/judul — tidak pernah memuat karakter shell. */
export function slugBerkas(work, identifier) {
  const doi = normDoi(work?.doi);
  if (doi) return `doi-${doi.replace(/[^a-z0-9.]+/gi, '_').slice(0, 80)}`;
  const judul = String(work?.title ?? identifier ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${judul || 'paper'}-${work?.publication_year ?? 'x'}`;
}

/**
 * Apakah berkas ini benar-benar PDF? Syaratnya: ada, >= 1000 byte, dan diawali
 * `%PDF-`. Dipakai di DUA tempat: sebelum menulis berkas baru (menolak balasan
 * yang bukan PDF) dan sebelum memakai PDF dari cache (menyembuhkan berkas cacat
 * yang mungkin ditulis versi plugin lama, sebelum validasi ini ada).
 *
 * Dulu syaratnya ditulis ulang di dalam `unduhPdf`, jadi tidak bisa dipakai
 * untuk memeriksa berkas yang sudah ada di disk.
 */
export function periksaPdf(berkas) {
  if (!existsSync(berkas)) return { ok: false, alasan: 'berkas tidak ada' };
  let ukuran;
  try {
    ukuran = statSync(berkas).size;
  } catch (e) {
    return { ok: false, alasan: `tidak bisa dibaca: ${e?.message ?? e}` };
  }
  if (ukuran < 1000) return { ok: false, alasan: `hanya ${ukuran} byte` };
  const fd = openSync(berkas, 'r');
  try {
    const buf = Buffer.alloc(5);
    const n = readSync(fd, buf, 0, 5, 0);
    const awalan = buf.subarray(0, n).toString('latin1');
    if (awalan !== '%PDF-') return { ok: false, alasan: `awalan "${awalan.replace(/[^\x20-\x7e]/g, '.')}"` };
    return { ok: true, byte: ukuran };
  } catch (e) {
    return { ok: false, alasan: `tidak bisa dibaca: ${e?.message ?? e}` };
  } finally {
    closeSync(fd);
  }
}

/**
 * Unduh PDF ke `tujuan`; menolak balasan yang bukan PDF.
 *
 * Ditulis **atomik**: ke `<tujuan>.part` lebih dulu, baru `renameSync`. Kalau
 * proses mati di tengah tulis (listrik/matikan paksa), yang tertinggal adalah
 * berkas `.part` — bukan PDF separuh yang nanti dikonversi dan gagal dengan
 * pesan yang membingungkan.
 */
/**
 * Apakah tautan ini AMAN untuk diunduh?
 *
 * Ditambahkan 2 Okt 2026 sesudah membaca PR upstream #56 (judulnya "safety
 * improvements"; isinya ternyata pemeriksaan host memakai SUBSTRING diganti
 * parsing hostname yang benar). Audit kode kita: pola substring itu **tidak ada**
 * di sini. Tetapi audit yang sama menemukan celah SETARA milik kita —
 * `unduhPdf()` mengikuti redirect tanpa memeriksa apa pun.
 *
 * Kenapa itu penting: URL unduhan datang dari **API pihak ketiga**
 * (lokasi OA OpenAlex, Unpaywall, `openAccessPdf` Semantic Scholar, CORE). Isi
 * balasan mereka tidak kita kendalikan, jadi tautan itu harus diperlakukan
 * sebagai **data yang belum tepercaya**. Tanpa penjaga ini, satu balasan API
 * yang matang bisa menyuruh mesin ini mengambil apa saja — termasuk alamat di
 * dalam jaringan lokal yang tidak seharusnya dijangkau dari luar.
 *
 * MURNI (tanpa jaringan) supaya bisa diuji langsung.
 */
export function tautanAman(url) {
  let u;
  try {
    u = new URL(String(url ?? ''));
  } catch {
    return { aman: false, alasan: 'bukan URL yang sah' };
  }

  // 1. Skema: hanya http/https. Ini menutup `file:` (baca berkas lokal),
  //    `data:`, `ftp:`, dan skema lain yang tidak ada urusannya dengan PDF.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { aman: false, alasan: `skema "${u.protocol}" tidak diizinkan — hanya http/https` };
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { aman: false, alasan: 'URL tanpa host' };

  // 2. Nama host yang jelas menunjuk ke dalam: mesin sendiri atau jaringan lokal.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return { aman: false, alasan: `host "${host}" menunjuk ke dalam jaringan lokal` };
  }

  // 3. Alamat IP literal di ruang privat/loopback/link-local.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    const privat =
      a === 127 || a === 0 || a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127); // CGNAT
    if (privat) return { aman: false, alasan: `alamat IP privat/loopback "${host}"` };
  }
  if (host.includes(':')) {
    const h = host.toLowerCase();
    if (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)) {
      return { aman: false, alasan: `alamat IPv6 privat/loopback "${host}"` };
    }
  }

  return { aman: true };
}

/**
 * Unduh PDF dengan penjagaan tautan.
 *
 * Redirect diikuti **SENDIRI, satu per satu**, bukan diserahkan ke `fetch`.
 * Alasannya: `redirect: 'follow'` membuat hop kedua dan seterusnya tidak pernah
 * kita lihat — jadi penjaga di tautan awal saja bisa dilewati lewat satu
 * redirect. Terukur: `redirect: 'manual'` memberi status 3xx + header Location,
 * sehingga tiap lompatan bisa diperiksa dengan `tautanAman()` yang sama.
 */
export async function unduhPdf(url, tujuan, { timeoutMs = TIMEOUT_UNDUH_MS, maksLompatan = 5 } = {}) {
  const ctl = new AbortController();
  const jam = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let sekarang = String(url);
    let res = null;
    for (let lompatan = 0; lompatan <= maksLompatan; lompatan++) {
      const periksa = tautanAman(sekarang);
      if (!periksa.aman) throw new Error(`tautan ditolak: ${periksa.alasan}`);

      res = await fetch(sekarang, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
      });

      const lanjut = res.status >= 300 && res.status < 400;
      if (!lanjut) break;
      const lokasi = res.headers.get('location');
      if (!lokasi) throw new Error(`HTTP ${res.status} tanpa header Location`);
      if (lompatan === maksLompatan) throw new Error(`terlalu banyak pengalihan (lebih dari ${maksLompatan})`);
      // Location boleh relatif — selesaikan terhadap URL sekarang.
      sekarang = new URL(lokasi, sekarang).toString();
    }

    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const awalan = buf.subarray(0, 5).toString('latin1');
    if (buf.length < 1000 || awalan !== '%PDF-') {
      throw new Error(`balasannya bukan PDF (${buf.length} byte, awalan "${awalan.replace(/[^\x20-\x7e]/g, '.')}")`);
    }
    const sementara = `${tujuan}.part`;
    writeFileSync(sementara, buf);
    renameSync(sementara, tujuan);
    return { byte: buf.length };
  } finally {
    clearTimeout(jam);
  }
}

// ── Orkestrasi ───────────────────────────────────────────────────────────────

/**
 * Simpan PDF lalu ubah jadi Markdown. TIDAK PERNAH melempar untuk kegagalan yang
 * bisa diduga (tidak ada salinan OA, konverter hilang, unduhan gagal) — semuanya
 * dikembalikan sebagai `{ masalah }` supaya pemanggilnya bisa melaporkan apa
 * adanya, sesuai prinsip paket ini.
 */
export async function siapkanTeksLengkap({
  karya, identifier, email, konverter, akar = AKAR_BAWAAN, paksaUlang = false, cariArxiv = padananArxiv,
} = {}) {
  const dir = join(akar, 'md');
  const slug = slugBerkas(karya, identifier);
  const hasil = {
    slug, dir, pdf: join(dir, `${slug}.pdf`), md: join(dir, `${slug}.md`),
    konverter, dariCache: false, kandidat: [], dipakai: null, arxivId: null, arxivDariJudul: false, masalah: null,
  };

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    hasil.masalah = `tidak bisa membuat folder ${dir}: ${e?.message ?? e}`;
    return hasil;
  }

  // Sudah pernah dikonversi? Pakai itu — hemat waktu & tidak mengunduh dua kali.
  // TAPI periksa dulu PDF pasangannya: berkas itu bisa ditulis versi plugin
  // LAMA, sebelum validasi `%PDF-` ada. Kalau cacat, buang pasangan cache-nya
  // dan teruskan ke jalur unduh — sembuh sendiri, bukan menyajikan `.md` yang
  // tidak bisa dipercaya.
  if (!paksaUlang && existsSync(hasil.md) && statSync(hasil.md).size > 0) {
    const lama = existsSync(hasil.pdf) ? periksaPdf(hasil.pdf) : { ok: true, alasan: 'tidak ada PDF di cache' };
    if (lama.ok) {
      hasil.dariCache = true;
      hasil.dipakai = { dari: 'berkas lokal', catatan: 'sudah pernah dikonversi' };
      return hasil;
    }
    hasil.catatanCache = `cache dibuang: PDF-nya tidak sah (${lama.alasan}) — mengunduh ulang`;
    try { unlinkSync(hasil.md); } catch { /* biarkan; akan ditimpa */ }
    try { unlinkSync(hasil.pdf); } catch { /* biarkan */ }
  }

  if (!konverter) {
    hasil.masalah = 'tidak ada konverter PDF->Markdown di mesin ini (anydoc atau markitdown)';
    return hasil;
  }

  // 1. Versi arXiv — dari karya itu sendiri, atau dicari lewat judul.
  let arxivId = idArxivDariKarya(karya);
  if (!arxivId && karya?.title) {
    try {
      const padanan = await cariArxiv(karya.title);
      if (padanan) { arxivId = padanan.id; hasil.arxivDariJudul = true; hasil.arxivPersis = padanan.persis; }
    } catch (e) {
      hasil.catatanArxiv = `pencarian arXiv gagal: ${e?.message ?? e}`;
    }
  }
  hasil.arxivId = arxivId;

  const kandidat = kandidatPdf(karya, { arxivId });
  const doi = normDoi(karya?.doi);
  if (doi && email) {
    // Unpaywall paling akhir: ia butuh email dan satu permintaan tambahan,
    // jadi hanya dipakai kalau kandidat di atasnya tidak ada.
    kandidat.push({ url: `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, dari: 'unpaywall', catatan: 'dicari lewat Unpaywall' });
  }
  hasil.kandidat = kandidat;
  if (kandidat.length === 0) {
    hasil.masalah = 'tidak ada salinan akses-terbuka yang ditemukan untuk karya ini';
    return hasil;
  }

  // 2. Coba satu per satu sampai ada PDF yang benar-benar bisa diunduh.
  const gagal = [];
  for (const k of kandidat) {
    try {
      let url = k.url;
      if (k.dari === 'unpaywall') {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        url = j?.best_oa_location?.url_for_pdf ?? j?.best_oa_location?.url;
        if (!url) throw new Error('Unpaywall tidak menyebut salinan akses-terbuka');
      }
      const { byte } = await unduhPdf(url, hasil.pdf);
      hasil.dipakai = { ...k, url, byte };
      break;
    } catch (e) {
      gagal.push(`${k.dari}: ${e?.message ?? e}`);
    }
  }
  if (!hasil.dipakai) {
    hasil.masalah = `semua kandidat PDF gagal (${gagal.join(' | ')})`;
    return hasil;
  }

  // 3. Konversi.
  const konv = await konversiKeMarkdown(hasil.pdf, hasil.md, konverter);
  if (!konv.ok) {
    hasil.masalah = `konversi gagal lewat ${konverter.nama}: ${konv.pesan}`;
    return hasil;
  }
  hasil.byte = konv.byte;
  return hasil;
}
