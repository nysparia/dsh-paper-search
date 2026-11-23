// lib/index.js — plugin DSH `dsh-paper-search`.
//
// LIMA HAL YANG DILAKUKAN PLUGIN INI:
//   1. mendaftarkan skill `paper-search` lewat `ctx.get('skills')`, di rank 450
//      supaya KALAH dari berkas di `~/.dsh/skills` (rank 400) — jadi suntingan
//      pengguna selalu menang, dan registrasi ini hanya cadangan untuk keadaan
//      provider preset mati (mis. preset "Creator mode");
//   2. tool `paper_search` — pencarian literatur lintas sumber;
//   3. tool `paper_status` — "doctor": sumber mana yang menjawab, kredensial mana
//      yang terbaca, dan konverter PDF->Markdown mana yang terpasang;
//   4. tool `paper_citations` + `paper_oa` — graf sitasi dan salinan
//      akses-terbuka lewat OpenAlex (adopsi PR upstream #96);
//   5. tool `paper_fulltext` — unduh PDF akses-terbuka (arXiv lebih dulu, PR #124)
//      lalu ubah ke Markdown supaya agen bisa membaca ISI LENGKAPnya.
//
// JUMLAH TOOL SENGAJA KECIL. Upstream `openags/paper-search-mcp` mengekspos 57
// tool lewat MCP (PR #97), dan itu **12.342 token pada SETIAP permintaan** —
// terukur 28 Sep 2026. Di sini lima tool, dan dua di antaranya berbagi skema.
//
// KREDENSIAL: tidak ada kunci yang dibawa paket ini. Urutan pembacaannya
//   1. config plugin (dari profil pengguna)
//   2. variabel lingkungan PAPER_SEARCH_MCP_<NAMA>, lalu <NAMA>
//   3. berkas ~/.config/paper-search-mcp/.env  (milik CLI upstream)
// Langkah 3 ada supaya mesin yang sudah disetel untuk `paper-search-mcp` tidak
// perlu konfigurasi ulang.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUMBER, ID_SUMBER, ID_INTERNASIONAL, ID_INDONESIA, searchSource, dedup, cariSumber, apakahDoi,
  resolusiKarya, ringkasKarya, ringkasOA, karyaMengutip, karyaDikutip, apakahIdKarya, BATAS_RUJUKAN, karyaArxiv, apakahArxivId,
  kandidatPeta, karyaDariIds } from './sources.js';
import { AKAR_BAWAAN, cariKonverter, siapkanTeksLengkap } from './fulltext.js';
import { buatCache, kunciCache, bolehDiCache, berkasCacheBawaan, TTL_BAWAAN_MS } from './cache.js';
import { kedekatanKeBenih, coCitasi, klasterkan, jembatan, ringkasKlaster, idPendek, himpunanRujukan, petaBerguna } from './peta.js';

export const name = 'paper-search';
// `skills` dan `fs` sengaja TIDAK di-inject: keduanya opsional, dibaca lewat
// ctx.get(). Tanpa itu plugin tetap harus mendaftarkan tool-nya.
export const inject = ['tools'];

const DIR_PAKET = dirname(dirname(fileURLToPath(import.meta.url)));
const BERKAS_SKILL = join(DIR_PAKET, 'skills', 'paper-search', 'SKILL.md');
const PREFIX = 'PAPER_SEARCH_MCP_';

// ── Kredensial ───────────────────────────────────────────────────────────────

/** Baca .env milik CLI upstream, kalau ada. Tidak pernah melempar. */
function bacaEnvUpstream() {
  const keluaran = {};
  try {
    const p = join(homedir(), '.config', 'paper-search-mcp', '.env');
    if (!existsSync(p)) return keluaran;
    for (const baris of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(baris);
      if (m && m[2].trim()) keluaran[m[1]] = m[2].trim();
    }
  } catch {
    // Berkas tidak terbaca = tidak ada kredensial dari jalur ini. Bukan galat.
  }
  return keluaran;
}

function buatPembacaKredensial(config) {
  const dariBerkas = bacaEnvUpstream();
  return function ambil(nama) {
    if (config && config[nama]) return { nilai: String(config[nama]), dari: 'config plugin' };
    const env = process.env[PREFIX + nama] ?? process.env[nama];
    if (env) return { nilai: String(env), dari: 'variabel lingkungan' };
    if (dariBerkas[PREFIX + nama]) return { nilai: dariBerkas[PREFIX + nama], dari: '.env upstream' };
    if (dariBerkas[nama]) return { nilai: dariBerkas[nama], dari: '.env upstream (nama lama)' };
    return { nilai: null, dari: null };
  };
}

/** Email apa pun yang tersedia — dipakai untuk "polite pool" Crossref/OpenAlex. */
function emailPolite(ambil) {
  return ambil('UNPAYWALL_EMAIL').nilai || ambil('OPENALEX_EMAIL').nilai || null;
}

// ── Pencarian ────────────────────────────────────────────────────────────────

/** Terjemahkan pilihan pengguna menjadi daftar id sumber. */
function pilihSumber(permintaan) {
  const t = String(permintaan ?? '').trim().toLowerCase();
  if (!t || t === 'all' || t === 'semua' || t === '*') return { sah: ID_SUMBER, takDikenal: [], eksplisit: false };
  if (t === 'international' || t === 'internasional') return { sah: ID_INTERNASIONAL, takDikenal: [], eksplisit: false };
  if (t === 'indonesia' || t === 'lokal') return { sah: ID_INDONESIA, takDikenal: [], eksplisit: false };
  const sah = [];
  const takDikenal = [];
  for (const id of t.split(/[,\s]+/).filter(Boolean)) (cariSumber(id) ? sah : takDikenal).push(id);
  return { sah, takDikenal, eksplisit: true };
}

/** Jenis karya yang boleh diminta lewat parameter `jenis`. */
export const JENIS_SAH = ['article', 'review', 'preprint'];

/** "article, REVIEW" -> { jenis: ['article','review'], takDikenal: [] }. Kosong -> null. */
export function normalkanJenis(nilai) {
  const mentah = String(nilai ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (mentah.length === 0) return null;
  return {
    jenis: mentah.filter((s) => JENIS_SAH.includes(s)),
    takDikenal: mentah.filter((s) => !JENIS_SAH.includes(s)),
  };
}

/**
 * Angka dari sebuah karya, atau `null` kalau TIDAK dilaporkan.
 *
 * `Number(null)` bernilai **0** dan `Number.isFinite(0)` BENAR — jadi tanpa
 * penjagaan ini, "sitasi tidak diketahui" terbaca sebagai "0 sitasi" lalu ikut
 * terbuang oleh `min_sitasi`, padahal kita cuma tidak tahu. Uji
 * `uji-cari-saring.mjs` menangkapnya; jangan disederhanakan kembali.
 */
function angkaKarya(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Saring (`min_sitasi`, `jenis`) lalu urutkan (`urutkan`) — **murni**, tanpa
 * jaringan, supaya bisa diuji langsung tanpa memanggil satu pun sumber.
 *
 * Dua aturan yang disengaja BERBEDA, dan bedanya dijelaskan ke pengguna:
 *  - `min_sitasi` adalah ambang angka yang tegas: karya tanpa laporan sitasi
 *    **dibuang**, karena kita tidak bisa membuktikan ia lolos.
 *  - `jenis` adalah kelas yang kasar: karya tanpa laporan jenis **dibiarkan**,
 *    karena "tidak disebut" bukan berarti "bukan artikel" — membuangnya akan
 *    menghapus sumber yang tidak menyebut jenis sama sekali (Garuda, PubMed, …).
 *
 * Semua yang dibuang DIHITUNG dan dikembalikan, bukan hilang diam-diam.
 */
export function saringDanUrutkan(papers, { minSitasi = null, jenis = null, urutkan = 'relevansi' } = {}) {
  let keluaran = [...papers];
  const buang = { tanpaSitasi: 0, sitasiRendah: 0, jenisTakCocok: 0, jenisTakDiketahui: 0 };

  if (minSitasi !== null) {
    const sisa = [];
    for (const p of keluaran) {
      const s = angkaKarya(p.citedBy);
      if (s === null) { buang.tanpaSitasi++; continue; }
      if (s < minSitasi) { buang.sitasiRendah++; continue; }
      sisa.push(p);
    }
    keluaran = sisa;
  }

  if (jenis !== null && jenis.length > 0) {
    const sisa = [];
    for (const p of keluaran) {
      const t = String(p.type ?? '').toLowerCase();
      if (!t) { buang.jenisTakDiketahui++; sisa.push(p); continue; }
      if (jenis.some((j) => t.includes(j))) sisa.push(p);
      else buang.jenisTakCocok++;
    }
    keluaran = sisa;
  }

  if (urutkan === 'sitasi' || urutkan === 'terbaru') {
    const kunci = urutkan === 'sitasi' ? (p) => angkaKarya(p.citedBy) : (p) => angkaKarya(p.year);
    keluaran = keluaran
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        const va = kunci(a.p);
        const vb = kunci(b.p);
        if (va === null && vb === null) return a.i - b.i;
        if (va === null) return 1; // tanpa angka selalu di belakang, bukan dianggap nol
        if (vb === null) return -1;
        return ((vb - va) || (a.i - b.i));
      })
      .map((x) => x.p);
  }

  return { papers: keluaran, buang };
}

async function jalankanPencarian(args, kredensial, cache = null) {
  const query = String(args?.query ?? '').trim();
  if (!query) throw new Error('parameter "query" wajib diisi');

  const queryDoi = apakahDoi(query);
  const pilihan = pilihSumber(args?.sources);
  if (pilihan.sah.length === 0) {
    throw new Error(`tidak ada sumber yang sah. Yang tersedia: ${ID_SUMBER.join(', ')}`);
  }

  // Sumber ber-input DOI (unpaywall) hanya ikut kalau query-nya memang DOI.
  // Kalau diminta EKSPLISIT, ia tetap dijalankan — hasilnya kosong dan itu
  // dijelaskan kepada pengguna, bukan dibuang diam-diam.
  const ids = [];
  const dilewati = [];
  for (const id of pilihan.sah) {
    if (!queryDoi && cariSumber(id)?.input === 'doi' && !pilihan.eksplisit) { dilewati.push(id); continue; }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error(
      `semua sumber yang dipilih ber-input DOI (${dilewati.join(', ')}), sedangkan query ini bukan DOI. `
      + 'Sertakan sumber lain, atau berikan DOI-nya.',
    );
  }

  const rows = Math.min(Math.max(Number(args?.max_results) || 5, 1), 50);
  const email = emailPolite(kredensial);

  // Penyaringan: nilai yang tidak masuk akal dianggap TIDAK diminta, dan itu
  // dilaporkan — bukan dipakai diam-diam sebagai angka lain.
  const mintaSitasi = Number(args?.min_sitasi);
  const minSitasi = Number.isFinite(mintaSitasi) && mintaSitasi > 0 ? Math.floor(mintaSitasi) : null;
  const sitasiTakSah = args?.min_sitasi !== undefined && minSitasi === null;
  const mintaJenis = normalkanJenis(args?.jenis);
  const jenis = mintaJenis?.jenis?.length ? mintaJenis.jenis : null;
  const mintaUrut = String(args?.urutkan ?? '').toLowerCase().trim();
  const urutkan = ['sitasi', 'terbaru'].includes(mintaUrut) ? mintaUrut : 'relevansi';
  const urutTakSah = args?.urutkan !== undefined && mintaUrut !== '' && urutkan === 'relevansi' && mintaUrut !== 'relevansi';

  const opsi = {
    rows,
    email,
    apiKey: kredensial('SEMANTIC_SCHOLAR_API_KEY').nilai,
    doajApiKey: kredensial('DOAJ_API_KEY').nilai,
    coreApiKey: kredensial('CORE_API_KEY').nilai,
    // Diteruskan ke sumber yang mendukung, supaya ambangnya disaring di sisi
    // mereka (recall terjaga), bukan hanya dipangkas setelah hasilnya datang.
    minSitasi,
    jenis,
  };

  // ── CACHE PENCARIAN ────────────────────────────────────────────────────────
  // Hanya sumber yang LOLOS `bolehDiCache` yang di-cache (sumber ber-kunci dan
  // ber-DOI dilewati), dan HANYA jawaban yang berhasil yang disimpan — kegagalan
  // sesaat tidak boleh "menular" selama TTL.
  const paksaUlang = args?.paksa_ulang === true;
  const perSumber = await Promise.all(ids.map(async (id) => {
    const sumber = cariSumber(id);
    if (!cache || !bolehDiCache(sumber)) return searchSource(id, query, opsi);

    const kunci = kunciCache(id, query, { rows, minSitasi, jenis });
    if (!paksaUlang) {
      const hit = cache.ambil(kunci);
      if (hit) return { id, papers: hit.nilai, error: null, ms: 0, dariCache: true, umurMs: hit.umurMs };
    }
    const h = await searchSource(id, query, opsi);
    if (!h.error) cache.simpan(kunci, h.papers, { jumlah: h.papers.length });
    return h;
  }));

  let papers = dedup(perSumber.flatMap((h) => h.papers));
  if (args?.open_access_only) papers = papers.filter((p) => p.openAccess);
  const tahun = Number(args?.year_from);
  if (Number.isFinite(tahun) && tahun > 1500) papers = papers.filter((p) => !p.year || p.year >= tahun);

  const disaring = saringDanUrutkan(papers, { minSitasi, jenis, urutkan });
  papers = disaring.papers;

  return {
    query,
    rows,
    ids,
    takDikenal: pilihan.takDikenal,
    dilewati,
    perSumber,
    papers,
    paksaUlang,
    dariCache: perSumber.filter((h) => h.dariCache).length,
    saring: {
      minSitasi,
      sitasiTakSah,
      jenis,
      jenisTakDikenal: mintaJenis?.takDikenal ?? [],
      urutkan,
      urutTakSah,
      urutTakSahNilai: urutTakSah ? String(args?.urutkan) : null,
      buang: disaring.buang,
    },
  };
}

/**
 * Satu baris status sumber — DIPAKAI KEDUA TOOL supaya penandaannya identik.
 * Sebelumnya tool pencarian memakai "v/x" dan tool status memakai "✓/✗", dan
 * ketidakcocokan itu membuat uji sendiri gagal. Teks polos juga lebih aman di
 * terminal mana pun.
 */
function barisSumber(label, h, keterangan = '') {
  const l = String(label).padEnd(18);
  return h.error
    ? `  GAGAL ${l} ${keterangan}${h.error}`
    : `  OK    ${l} ${keterangan}${String(h.papers.length).padStart(3)} hasil  (${h.ms} ms)`;
}

function formatHasil(hasil) {
  const { perSumber, papers } = hasil;
  const gagal = perSumber.filter((h) => h.error);
  const baris = [];

  baris.push(`query: ${hasil.query}`);
  baris.push(`${perSumber.length} sumber dicari · ${perSumber.length - gagal.length} menjawab · ${papers.length} paper unik setelah dedup`);
  // Cache yang tidak terlihat adalah cache yang menyesatkan: umurnya disebut,
  // dan `paksa_ulang` ditawarkan sebagai jalan keluarnya.
  if (hasil.dariCache > 0) {
    const umur = perSumber.filter((h) => h.dariCache).map((h) => h.umurMs ?? 0);
    const tertua = Math.max(...umur);
    baris.push(`CATATAN: ${hasil.dariCache} dari ${perSumber.length} sumber dilayani dari CACHE (paling lama ${Math.round(tertua / 60000)} menit lalu) — bukan pencarian baru. Pakai paksa_ulang:true untuk memaksa mencari ulang.`);
  } else if (hasil.paksaUlang) {
    baris.push('CATATAN: paksa_ulang aktif — cache dilewati, semua sumber dicari ulang.');
  }
  // Penyaringan & pengurutan: SELALU dilaporkan apa adanya, termasuk yang
  // dibuang dan yang diminta tapi tidak dikenal — supaya "hasilnya sedikit"
  // tidak pernah menjadi misteri bagi pembaca laporan.
  const s = hasil.saring;
  if (s?.sitasiTakSah) baris.push('CATATAN: min_sitasi diabaikan — harus angka lebih besar dari 0.');
  if (s && s.minSitasi !== null && s.minSitasi !== undefined) {
    baris.push(`Saringan: sitasi >= ${s.minSitasi} — ${s.buang.sitasiRendah} di bawah ambang · ${s.buang.tanpaSitasi} DIBUANG karena sumbernya tidak melaporkan jumlah sitasi.`);
  }
  if (s?.jenis?.length) {
    baris.push(`Saringan jenis: ${s.jenis.join('/')} — ${s.buang.jenisTakCocok} tidak cocok · ${s.buang.jenisTakDiketahui} tetap ditampilkan (sumbernya tidak menyebut jenisnya).`);
  }
  if (s?.jenisTakDikenal?.length) {
    baris.push(`PERHATIAN: jenis tidak dikenal (diabaikan): ${s.jenisTakDikenal.join(', ')} — yang sah: ${JENIS_SAH.join(', ')}.`);
  }
  if (s?.urutTakSah) baris.push(`PERHATIAN: urutkan "${s.urutTakSahNilai}" tidak dikenal — dipakai "relevansi". Pilihan: relevansi, sitasi, terbaru.`);
  if (s?.urutkan && s.urutkan !== 'relevansi') {
    baris.push(`Urutan: ${s.urutkan === 'sitasi' ? 'terbanyak dikutip dulu' : 'terbaru dulu'} — karya yang angkanya tidak dilaporkan sumber ditaruh paling belakang.`);
  }
  if (hasil.takDikenal?.length) baris.push(`PERHATIAN: sumber tidak dikenal (diabaikan): ${hasil.takDikenal.join(', ')}`);
  if (hasil.dilewati?.length) {
    baris.push(`CATATAN: ${hasil.dilewati.join(', ')} dilewati karena query ini bukan DOI — sumber itu memang mencari dengan DOI, bukan kata kunci.`);
  }
  baris.push('');
  baris.push('per sumber:');
  for (const h of [...perSumber].sort((a, b) => (b.papers.length - a.papers.length) || a.id.localeCompare(b.id))) {
    const s = cariSumber(h.id);
    const jenis = `${s?.kind ?? ''}${s?.input === 'doi' ? '/doi' : ''}`.padEnd(8);
    baris.push(barisSumber(s?.label ?? h.id, h, jenis));
  }

  if (gagal.length) {
    baris.push('');
    baris.push('PERHATIAN: sumber bertanda GAGAL di atas HARUS disebutkan saat melaporkan hasil —');
    baris.push('jangan menyimpulkan "tidak ada literatur" dari sumber yang gagal.');
  }

  baris.push('');
  if (papers.length === 0) {
    baris.push('TIDAK ADA hasil yang lolos filter.');
    baris.push('Sebelum menyimpulkan "tidak ada literatur": ulangi sekali, lalu coba sumber lain.');
    return baris.join('\n');
  }

  papers.slice(0, 40).forEach((p, i) => {
    const penulis = p.authors.length ? p.authors.slice(0, 3).join('; ') + (p.authors.length > 3 ? ' dkk' : '') : '(penulis tidak dilaporkan)';
    baris.push(`${i + 1}. ${p.title}`);
    baris.push(`   ${p.year ?? '?'} · ${p.journal ?? 'jurnal tidak dilaporkan'} · ${penulis}`);
    baris.push(`   sumber: ${p.sources.join(', ')}${p.openAccess ? ' · akses terbuka' : ''}${p.citedBy != null ? ` · ${p.citedBy} sitasi` : ''}`);
    if (p.doi) baris.push(`   doi: ${p.doi}`);
    else if (p.url) baris.push(`   url: ${p.url}`);
    if (p.abstract) baris.push(`   abstrak: ${p.abstract}`);
  });
  if (papers.length > 40) baris.push(`… dan ${papers.length - 40} lagi (persempit query atau turunkan max_results).`);
  return baris.join('\n');
}

// ── Tool ─────────────────────────────────────────────────────────────────────

/**
 * Bentuk `output` yang DIWAJIBKAN DSH untuk setiap tool.
 *
 * Ditemukan lewat uji boot sungguhan (`test/uji-di-dsh.mjs`) — dan ini bug yang
 * lolos dari `ctx` tiruan, karena `register` tiruan hanya menampung definisinya.
 * DSH melempar:
 *
 *   TypeError: tool "paper_search" must declare output { schema, render,
 *   presentationMeta? }
 *
 * Karena lemparan itu terjadi di dalam `apply()`, SELURUH plugin gagal dimuat —
 * tool maupun skill-nya sama sekali tidak terdaftar.
 *
 * Kedua tool di sini mengembalikan TEKS yang sudah diformat, jadi `schema`
 * menyatakan string dan `render` membungkusnya menjadi blok konten — bentuk
 * yang sama dengan `txt()` milik `dsh-search-cascade`
 * (`[{ type: 'text', text: '...' }]`).
 */
function keluaranTeks(deskripsi) {
  return {
    schema: { type: 'string', description: deskripsi },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  };
}

function toolSearch(kredensial, cache = null) {
  return {
    name: 'paper_search',
    description:
      'Cari literatur ilmiah dari 20 sumber internasional (Crossref, ACM Digital Library, IEEE, OpenAlex, DOAJ, Europe PMC, PubMed, PubMed Central, arXiv, bioRxiv, medRxiv, ChemRxiv, Semantic Scholar, CORE, Zenodo, HAL, IACR ePrint, OpenReview, SSRN, Unpaywall) dan 3 portal jurnal Indonesia (Garuda, Sinta, IOS OneSearch) sekaligus, lalu buang duplikatnya berdasarkan DOI/judul. '
      + 'Semua native lewat HTTP — tidak butuh CLI atau paket luar. '
      + 'Pakai untuk: mencari paper/jurnal, penelitian terdahulu, literatur Indonesia, atau melacak DOI. '
      + 'Bisa disaring (min_sitasi, jenis) dan diurutkan (urutkan: sitasi/terbaru) — pakai ini untuk menaikkan karya klasik/fondasional ke atas, alih-alih membaca hasil terbaru yang tangensial. '
      + 'Keluaran memisahkan sumber yang GAGAL dari yang menjawab, jadi "0 hasil" dari satu sumber tidak boleh disimpulkan sebagai "tidak ada literatur".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Kata kunci. Untuk topik Indonesia pakai kata kunci bahasa Indonesia — hasilnya jauh lebih relevan.' },
        sources: { type: 'string', description: `Daftar id dipisah koma, atau "all" / "international" / "indonesia". Id yang tersedia: ${ID_SUMBER.join(', ')}. Bawaan: semua.` },
        max_results: { type: 'number', description: 'Hasil per sumber (1-50, bawaan 5).' },
        open_access_only: { type: 'boolean', description: 'Hanya kembalikan paper akses-terbuka (bila sumber melaporkannya).' },
        year_from: { type: 'number', description: 'Hanya paper dengan tahun >= nilai ini.' },
        paksa_ulang: { type: 'boolean', description: 'Lewati cache dan ulangi dari awal (bawaan false). Pada mode search: cari ulang ke semua sumber, mengabaikan cache pencarian. Pada mode fulltext: unduh & konversi ulang walau hasilnya sudah ada.' },
        urutkan: { type: 'string', description: 'Urutan hasil SETELAH dedup: "relevansi" (bawaan — urutan asli per sumber), "sitasi" (terbanyak dikutip dulu; karya yang sitasinya tidak dilaporkan sumber ditaruh paling belakang), atau "terbaru".' },
        min_sitasi: { type: 'number', description: 'Hanya paper dengan jumlah sitasi >= nilai ini. Karya dari sumber yang TIDAK melaporkan sitasi akan DIBUANG — ambangnya tidak bisa diverifikasi — dan jumlahnya dilaporkan di keluaran, bukan disembunyikan.' },
        jenis: { type: 'string', description: 'Saring jenis karya: "article", "review", "preprint" (boleh dipisah koma). Diteruskan ke sumber yang mendukung (OpenAlex, Crossref/ACM) supaya recall tidak habis, lalu disaring lagi setelah dedup. Karya yang jenisnya tidak dilaporkan sumbernya TETAP ditampilkan, dan jumlahnya disebut.' },
      },
      required: ['query'],
    },
    output: keluaranTeks('Laporan teks: query, jumlah sumber yang menjawab, jumlah paper setelah dedup, baris status per sumber (OK/GAGAL), lalu daftar paper.'),
    execute: async (args) => {
      const hasil = await jalankanPencarian(args ?? {}, kredensial, cache);
      return formatHasil(hasil);
    },
  };
}

function toolStatus(kredensial, config, cache = null) {
  return {
    name: 'paper_status',
    description:
      'Periksa kesehatan pencarian literatur: sumber mana yang benar-benar MENJAWAB sekarang (bukan sekadar terdaftar), kredensial mana yang terbaca dan dari mana asalnya, dan konverter PDF->Markdown mana yang tersedia untuk paper_fulltext. '
      + 'Pakai sebelum melaporkan "tidak ada hasil", atau saat pengguna bertanya kenapa pencarian kosong. '
      + 'Secara bawaan ia mengirim satu permintaan kecil ke setiap sumber; setel probe:false untuk memeriksa konfigurasi saja tanpa jaringan.',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'Kirim satu permintaan kecil ke tiap sumber untuk membuktikan ia hidup (bawaan true). Setel false untuk memeriksa konfigurasi saja tanpa jaringan.' },
        sources: { type: 'string', description: 'Batasi pemeriksaan ke sebagian sumber (id dipisah koma). Bawaan: semua.' },
        bersihkan_cache: { type: 'boolean', description: 'Hapus SELURUH cache pencarian (bawaan false). Berguna kalau hasil pencarian terasa basi dan Anda ingin mulai bersih.' },
      },
      required: [],
    },
    output: keluaranTeks('Laporan teks: daftar kredensial yang terbaca beserta asalnya, baris status tiap sumber (OK/GAGAL beserta waktu respons), dan catatan tambahan.'),
    execute: async (args) => {
      const probe = args?.probe !== false;
      const barisPilihan = pilihSumber(args?.sources);
      const ids = barisPilihan.sah.length ? barisPilihan.sah : ID_SUMBER;
      const keluar = [];
      if (cache && args?.bersihkan_cache === true) {
        const berhasil = cache.bersihkan();
        keluar.push(`cache pencarian ${berhasil ? 'DIBERSIHKAN' : 'GAGAL dibersihkan'}.`);
        keluar.push('');
      }
      keluar.push('== kredensial ==');
      for (const nama of ['UNPAYWALL_EMAIL', 'OPENALEX_EMAIL', 'SEMANTIC_SCHOLAR_API_KEY', 'DOAJ_API_KEY', 'CORE_API_KEY']) {
        const k = kredensial(nama);
        const nilaiTampil = k.nilai
          ? (nama.endsWith('EMAIL') ? k.nilai : `terisi (${k.nilai.length} huruf)`)
          : 'KOSONG';
        keluar.push(`  ${nama.padEnd(30)} ${nilaiTampil}${k.dari ? `  ← ${k.dari}` : ''}`);
      }
      keluar.push('  catatan: OpenAIRE dan CiteSeerX tidak dipakai plugin ini.');
      keluar.push('  catatan: IEEE DIPAKAI sejak 0.3.0 — lewat Crossref (member:263), tanpa kunci API. Abstraknya tidak tersedia di Crossref.');
      keluar.push('  catatan: ACM DIPAKAI — lewat Crossref (prefix DOI 10.1145), tanpa kunci API. Jangan isi PAPER_SEARCH_MCP_ACM_API_KEY: di upstream kunci itu tidak akan pernah bernilai sah.');

      if (cache) {
        const cs = cache.status();
        keluar.push('');
        keluar.push('== cache pencarian ==');
        keluar.push(`  berkas   : ${cs.berkas}`);
        keluar.push(`  isi      : ${cs.jumlahSah} entri sah dari ${cs.jumlah} tersimpan · ${Math.round(cs.byte / 1024)} kB`);
        keluar.push(`  batas    : TTL ${Math.round(cs.ttlMs / 60000)} menit · maks ${cs.maksEntri} entri · maks ${Math.round(cs.maksByte / 1024)} kB`);
        if (cs.jumlahSah > 0) {
          keluar.push(`  umur     : terbaru ${Math.round(cs.terbaruMs / 60000)} menit · tertua ${Math.round(cs.tertuaMs / 60000)} menit`);
        } else {
          keluar.push('  umur     : (belum ada entri sah)');
        }
        keluar.push(`  sumber yang DI-CACHE: ${SUMBER.filter(bolehDiCache).length} · DILEWATI (ber-kunci/ber-DOI): ${SUMBER.filter((s) => !bolehDiCache(s)).map((s) => s.id).join(', ') || '(tidak ada)'}`);
        keluar.push('  catatan: kegagalan sumber TIDAK PERNAH disimpan — yang di-cache hanya jawaban yang berhasil.');
      }

      keluar.push('');
      keluar.push('== sumber ==');
      const email = emailPolite(kredensial);
      const opsi = { rows: 1, email, apiKey: kredensial('SEMANTIC_SCHOLAR_API_KEY').nilai, doajApiKey: kredensial('DOAJ_API_KEY').nilai, coreApiKey: kredensial('CORE_API_KEY').nilai };
      for (const id of ids) {
        const s = cariSumber(id);
        const jenis = `${s.kind}${s.input === 'doi' ? '/doi' : ''}`.padEnd(8);
        if (!probe) {
          keluar.push(`  ?     ${s.label.padEnd(18)} ${jenis} terdaftar (probe dimatikan)`);
          continue;
        }
        // Sumber ber-input DOI diuji dengan DOI sungguhan — kalau diuji dengan
        // kata kunci ia selalu 0 dan itu terbaca seolah sumbernya rusak.
        const kueri = s.input === 'doi' ? '10.1038/s41580-023-00697-6' : 'literature';
        const h = await searchSource(id, kueri, opsi);
        keluar.push(barisSumber(s.label, h, jenis));
      }

      // Angkanya memakai jumlah yang BENAR-BENAR diperiksa (`ids`), bukan jumlah
// seluruh sumber. Terukur 2 Okt 2026: dengan `sources: "doaj"` keluarannya
// menulis "23 sumber di atas" padahal daftarnya cuma satu baris — angka yang
// tidak cocok dengan isi daftarnya sendiri.
      keluar.push(`catatan: ${ids.length} dari ${SUMBER.length} sumber diperiksa di atas — semuanya NATIVE, tanpa CLI atau server pihak ketiga.`);

      keluar.push('');
      keluar.push('== konverter PDF->Markdown (untuk tool paper_fulltext) ==');
      const konv = cariKonverter(config ?? {});
      if (konv) {
        keluar.push(`  ADA      ${konv.nama.padEnd(12)} ${konv.jalur}  ← ${konv.dari}`);
        if (konv.nama === 'markitdown') {
          keluar.push('  catatan: anydoc tidak ditemukan — markitdown dipakai. Pasang anydoc lebih cepat:');
          keluar.push('           npm i -g @firecrawl/anydoc');
        }
      } else {
        keluar.push('  TIDAK ADA — paper_fulltext belum bisa mengubah PDF ke Markdown.');
        keluar.push('  pasang salah satu, lalu jalankan ulang paper_status:');
        keluar.push('    npm i -g @firecrawl/anydoc     (disarankan — Rust, tanpa Python, terukur ~0,4 dtk/paper)');
        keluar.push('    uv tool install markitdown     (Python)');
      }
      keluar.push(`  folder perpustakaan: ${config?.folderTeksLengkap ?? config?.FOLDER_TEKS_LENGKAP ?? AKAR_BAWAAN}`);
      return keluar.join('\n');
    },
  };
}

// ── Graf sitasi & salinan akses-terbuka (adopsi PR upstream #96) ─────────────

function batasAngka(n, bawaan, min = 1, max = 50) {
  const v = Number(n);
  if (!Number.isFinite(v)) return bawaan;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

/** "pengutip" vs "rujukan" — beserta sinonim yang wajar dipakai model. */
function normArah(a) {
  const t = String(a ?? '').trim().toLowerCase();
  const mundur = ['rujukan', 'referensi', 'reference', 'references', 'referenced', 'dikutip', 'dikutip oleh', 'mundur', 'backward'];
  return mundur.includes(t) ? 'rujukan' : 'pengutip';
}

/** Header "karya yang dipakai" — WAJIB ditampilkan supaya salah pilih terlihat. */
function headerKarya(k, masukan, { dariArxiv = null } = {}) {
  const b = [];
  b.push('karya yang dipakai:');
  b.push(`  ${k.title ?? '(judul tidak dilaporkan)'}${k.year ? ` (${k.year})` : ''}`);
  b.push(`  id: ${k.id ?? '-'}${k.doi ? ` · doi: ${k.doi}` : ''}`);
  b.push(`  ${k.journal ?? 'jurnal tidak dilaporkan'}${k.citedBy != null ? ` · dikutip ${k.citedBy} kali` : ''}`);
  if (dariArxiv) {
    // Masukan memang id arXiv — TIDAK boleh diberi peringatan "dipilih dari judul".
    b.push(`  arXiv: ${dariArxiv}`);
  } else if (!apakahDoi(masukan) && !apakahIdKarya(masukan)) {
    b.push('  CATATAN: karya ini dipilih dari JUDUL — periksa dulu apakah memang paper yang dimaksud.');
  }
  return b;
}

function barisPaper(p, i) {
  const penulis = p.authors?.length
    ? p.authors.slice(0, 3).join('; ') + (p.authors.length > 3 ? ' dkk' : '')
    : null;
  const b = [`${String(i + 1).padStart(2)}. ${p.title}`];
  b.push(`    ${p.year ?? '?'} · ${p.journal ?? 'jurnal tidak dilaporkan'}${p.citedBy != null ? ` · ${p.citedBy} sitasi` : ''}`);
  if (penulis) b.push(`    ${penulis}`);
  if (p.doi) b.push(`    doi: ${p.doi}`);
  else if (p.url) b.push(`    url: ${p.url}`);
  return b;
}

/**
 * Potong teks panjang untuk laporan + buang pembungkus HTML sisa.
 *
 * `potong()` yang asli ada di `lib/sources.js` (tidak diekspor karena dipakai
 * internal di sana). Sempat saya panggil dari sini dan langsung tertangkap uji
 * nyata: `ReferenceError: potong is not defined`. Helper ini sengaja kecil dan
 * lokal supaya tidak perlu mengekspor apa pun dari sources.js.
 */
function potong(teks, n) {
  const t = String(teks ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '(tanpa judul)';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * PETA STRUKTUR SITASI (issue upstream #122) — coupling, co-citation,
 * pengelompokan, jembatan.
 *
 * MATEMATIKANYA ada di `lib/peta.js` (murni, diuji tanpa jaringan); di sini
 * hanya pengambilan data + penyusunan laporan.
 *
 * PAGAR BIAYA yang disengaja dan DILAPORKAN ke pengguna:
 *   • kandidat maksimal 50;
 *   • maksimal 3 permintaan OpenAlex (benih + kandidat + judul rujukan bersama);
 *   • tidak ada penelusuran berantai tanpa batas — `kedalaman` hanya 1 atau 2.
 */
async function petaStruktur({ karya, k, masukan, arah, email, args }) {
  const batas = Math.min(Math.max(Number(args?.max_kandidat) || 40, 5), 50);
  const ambangKuat = Number.isFinite(Number(args?.ambang_kuat)) && Number(args.ambang_kuat) > 0 ? Number(args.ambang_kuat) : 0.15;
  const minBersamaKuat = Number.isFinite(Number(args?.min_bersama_kuat)) && Number(args.min_bersama_kuat) > 0 ? Math.floor(Number(args.min_bersama_kuat)) : 3;

  const keluar = headerKarya(k, masukan);
  let permintaan = 0;

  const ban = await kandidatPeta(karya, { arah, max: batas, email });
  permintaan += ban.permintaan;

  keluar.push('');
  keluar.push('== peta struktur sitasi ==');
  keluar.push(`arah kandidat: ${arah === 'rujukan' ? 'rujukan benih (snowballing mundur)' : 'karya yang mengutip benih (snowballing maju)'}`);
  keluar.push(`kandidat diperiksa: ${ban.works.length} dari ${ban.total} yang tercatat OpenAlex` + (ban.total > ban.works.length ? ` (dibatasi ${batas})` : ''));
  keluar.push(`ambang pengelompokan: cosine >= ${ambangKuat} DAN >= ${minBersamaKuat} rujukan sama`);

  if (ban.works.length < 2) {
    keluar.push('');
    keluar.push('Kandidat kurang dari 2, jadi struktur tidak bisa dibentuk.');
    keluar.push('Kalau arah "pengutip" hasilnya sedikit: itu wajar untuk paper baru — indeks sitasi selalu tertinggal beberapa bulan.');
    return keluar.join('\n');
  }

  const refBenih = himpunanRujukan([karya]).get(idPendek(karya?.id)) ?? new Set();
  keluar.push(`rujukan tercatat pada benih: ${refBenih.size}` + (refBenih.size === 0 ? ' (OpenAlex TIDAK mencatatnya)' : ''));

  // Kejadian nyata 2 Okt 2026: peta dijalankan pada artikel jurnal Indonesia
  // yang baru terbit — OpenAlex mencatat 0 rujukan dan hanya 2 pengutip, jadi
  // SELURUH bagian peta kosong. Keluaran yang hanya bilang "0" membuat pemakainya
  // mengira alatnya rusak. Karena itu dikatakan terus terang + diberi jalan keluar.
  if (!petaBerguna({ refBenih: refBenih.size, kandidat: ban.works.length }).berguna) {
    keluar.push('');
    keluar.push('!! PETA TIDAK BERGUNA UNTUK BENIH INI !!');
    keluar.push(`   OpenAlex mencatat ${refBenih.size} rujukan untuk karya ini dan hanya ${ban.works.length} pengutip.`);
    keluar.push('   Coupling & co-citation dihitung DARI DAFTAR RUJUKAN, jadi tanpa rujukan tidak ada yang bisa diukur.');
    keluar.push('   Ini bukan kerusakan alat, dan bukan berarti papernya tidak punya daftar pustaka —');
    keluar.push('   artinya OpenAlex belum mengindeks rujukan karya ini (lazim untuk terbitan baru/daerah).');
    keluar.push('');
    keluar.push('   YANG BISA DILAKUKAN:');
    keluar.push('   1. Pakai benih yang lebih mapan (karya internasional yang lebih tua & banyak dikutip) —');
    keluar.push('      cari dulu dengan paper({ mode: "search", urutkan: "sitasi", min_sitasi: 50 }).');
    keluar.push('   2. Atau pakai mode biasa: paper({ mode: "citations", arah: "pengutip" }) — daftar pengutip');
    keluar.push('      tetap berguna walau cuma sedikit.');
    return keluar.join('\n');
  }

  // ── 1. Kedekatan ke benih (bibliographic coupling) ──
  const dek = kedekatanKeBenih(ban.works, refBenih);
  const adaCoupling = dek.filter((d) => d.coupling > 0);
  keluar.push('');
  keluar.push('-- paling sebidang dengan benih (rujukan yang SAMA) --');
  if (adaCoupling.length === 0) {
    keluar.push('  (tidak ada satu pun kandidat yang berbagi rujukan dengan benih)');
  } else {
    for (const [i, d] of adaCoupling.slice(0, 8).entries()) {
      keluar.push(`  ${String(i + 1).padStart(2)}. [${d.coupling.toFixed(3)}] ${potong(d.title, 78)}`);
      keluar.push(`      ${d.year ?? '?'} · ${d.citedBy ?? '?'} sitasi · ${d.bersama} rujukan sama dari ${d.refs} · ${d.id}`);
    }
  }

  // ── 2. Co-citation: dasar bersama bidang ini ──
  const cc = coCitasi(ban.works, refBenih);
  const ccAda = cc.filter((x) => x.oleh > 0);
  keluar.push('');
  keluar.push('-- dasar bersama (paling sering dikutip BERSAMA oleh kandidat) --');
  if (ccAda.length === 0) {
    keluar.push('  (tidak ada rujukan benih yang dikutip bersama oleh kandidat)');
  } else {
    // Judul rujukan bersama butuh SATU permintaan tambahan — dan itu sepadan:
    // tanpa judul, daftar id OpenAlex hampir tidak berguna bagi pembaca.
    const perluJudul = ccAda.slice(0, 10);
    const karyaRef = await karyaDariIds(perluJudul.map((x) => x.id), { email });
    permintaan += 1;
    const judulPer = new Map(karyaRef.map((w) => [idPendek(w.id), w]));
    for (const [i, x] of perluJudul.entries()) {
      const w = judulPer.get(x.id);
      keluar.push(`  ${String(i + 1).padStart(2)}. [${x.oleh}x] ${potong(w?.title ?? '(judul tidak terbaca)', 76)}`);
      keluar.push(`      ${w?.publication_year ?? '?'} · ${w?.cited_by_count ?? '?'} sitasi · ${x.id}`);
    }
  }

  // ── 3. Klaster ──
  const kl = klasterkan(ban.works, { ambang: ambangKuat, minBersama: minBersamaKuat });
  keluar.push('');
  keluar.push(`-- klaster bidang: ${kl.klaster.length} kelompok --`);
  const judulKarya = new Map(ban.works.map((w) => [idPendek(w.id), w]));
  kl.klaster.slice(0, 6).forEach((anggota, i) => {
    const r = ringkasKlaster(ban.works, anggota);
    keluar.push(`  klaster ${i + 1}: ${r.ukuran} karya · ${r.tahunMin ?? '?'}-${r.tahunMaks ?? '?'} · total ${r.sitasiTotal} sitasi`);
    for (const w of r.teratas.slice(0, 3)) keluar.push(`      · ${potong(w.title, 74)} (${w.publication_year ?? '?'})`);
  });
  const besar = kl.klaster.filter((x) => x.length > 1).length;
  if (besar === 0) {
    keluar.push('  Catatan: TIDAK ADA dua kandidat pun yang cukup berdekatan — coba turunkan ambang_kuat/min_bersama_kuat.');
  }

  // ── 4. Jembatan antar-klaster ──
  const jem = jembatan(ban.works, { ambangKuat, minBersamaKuat });
  keluar.push('');
  keluar.push('-- jembatan antar-klaster (nyaris masuk dua bidang sekaligus) --');
  keluar.push(`   (syarat: cosine >= ${jem.ambangLemah} DAN >= ${jem.minBersamaLemah} rujukan sama pada ambang longgar)`);
  if (jem.jembatan.length === 0) {
    keluar.push('  (tidak ada — semua kandidat jelas berada di satu bidang)');
  } else {
    const dicurigai = jem.jembatan.filter((j) => j.mencurigakan);
    for (const j of jem.jembatan.slice(0, 6)) {
      const w = judulKarya.get(j.id);
      keluar.push(`  · ${potong(w?.title ?? '(judul tidak terbaca)', 76)}`);
      keluar.push(`      menyambung ${j.klasterLain} klaster · ${j.derajat} karya berdekatan · ${j.refs} rujukan · ${w?.publication_year ?? '?'}${j.mencurigakan ? ' · ⚠️ DAFTAR RUJUKAN SANGAT PANJANG' : ''}`);
      keluar.push(`      ${j.id}`);
    }
    if (dicurigai.length) {
      keluar.push(`  ⚠️ ${dicurigai.length} di antaranya punya > ${jem.batasRujukanWajar} rujukan — biasanya rekaman WADAH (prosiding/bundel konferensi),`);
      keluar.push('     bukan paper tunggal. Wadah memang "berdekatan dengan segalanya", jadi JANGAN diperlakukan sebagai temuan.');
    }
  }

  // ── 5. Batas yang WAJIB dibaca, bukan disembunyikan ──
  keluar.push('');
  keluar.push(`permintaan OpenAlex: ${permintaan} (pagar: maksimal 3)`);
  keluar.push('BATAS YANG HARUS DISADARI sebelum menyimpulkan apa pun:');
  keluar.push('  · coupling & co-citation adalah PROKSI kemiripan, bukan bukti hubungan. Dua karya bisa sangat mirip tanpa saling mengutip, dan sebaliknya.');
  keluar.push('  · yang TIDAK punya daftar rujukan di OpenAlex muncul dengan kedekatan 0 — itu "tidak diketahui", bukan "tidak mirip".');
  keluar.push('  · klaster bergantung pada ambang. Sebutkan ambangnya saat melaporkan, karena angka klaster bukan fakta alam.');
  keluar.push('  · "jembatan" berarti nyaris masuk dua bidang MENURUT rujukan — bukan penilaian mutu atau kebaruan.');
  return keluar.join('\n');
}

function toolCitations(kredensial) {
  return {
    name: 'paper_citations',
    description:
      'Telusuri GRAF SITASI satu paper lewat OpenAlex — gratis, tanpa kunci, tanpa email. '
      + 'Dua arah: "pengutip" = paper yang MENGUTIP karya ini (penelitian lanjutan, snowballing maju) · "rujukan" = karya yang DIKUTIP oleh paper ini (dasar teori, daftar bacaan, snowballing mundur). '
      + 'Terima DOI, id/tautan OpenAlex (W…), atau JUDUL. '
      + 'Pakai untuk: memperluas literatur dari satu paper kunci, mencari penelitian lanjutan, atau memeriksa dasar teori sebuah paper. '
      + 'Kalau yang diberikan hanya JUDUL, OpenAlex bisa memilih karya yang salah — keluarannya selalu menyebut karya mana yang benar-benar dipakai, jadi periksa itu dulu sebelum menyimpulkan.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'DOI (10.…), id/tautan OpenAlex (W…), atau JUDUL paper.' },
        arah: { type: 'string', description: '"pengutip" (bawaan) = paper yang mengutip karya ini · "rujukan" = karya yang dikutip paper ini.' },
        max_results: { type: 'number', description: 'Jumlah hasil (1-50, bawaan 10).' },
        urutkan: { type: 'string', description: '"sitasi" (bawaan) = terbanyak dikutip dulu · "terbaru" = terbitan terbaru dulu.' },
        analisis: { type: 'string', description: '"daftar" (bawaan) = daftar paper seperti biasa · "peta" = PETA STRUKTUR SITASI: mengelompokkan karya jadi klaster bidang, mengukur kedekatan tiap karya dengan benih lewat rujukan yang SAMA (bibliographic coupling), menghitung co-citation, dan menandai karya JEMBATAN antar-klaster — berguna untuk mencari celah riset di tinjauan pustaka.' },
        ambang_kuat: { type: 'number', description: 'Khusus analisis "peta": ambang cosine (0-1) untuk pengelompokan KETAT, bawaan 0,15. Naikkan bila klaster terlalu longgar.' },
        min_bersama_kuat: { type: 'number', description: 'Khusus analisis "peta": minimal rujukan yang sama untuk mengelompokkan, bawaan 3. Inilah pagar terhadap cosine tinggi yang hanya dari 1 rujukan.' },
        max_kandidat: { type: 'number', description: 'Khusus analisis "peta": jumlah karya yang diperiksa (5-50, bawaan 40). Lebih banyak = klaster lebih kaya, tetapi biayanya tetap satu permintaan tambahan.' },
      },
      required: ['identifier'],
    },
    output: keluaranTeks('Laporan teks: karya yang dipakai (judul, id, DOI, jumlah sitasi), arah penelusuran, jumlah total di OpenAlex, lalu daftar paper (judul, tahun, jurnal, penulis, DOI, sitasi).'),
    execute: async (args) => {
      const masukan = args?.identifier;
      const email = emailPolite(kredensial);
      const karya = await resolusiKarya(masukan, { email });
      const k = ringkasKarya(karya);
      const rows = batasAngka(args?.max_results, 10);
      const urutkan = String(args?.urutkan ?? '').trim().toLowerCase() === 'terbaru' ? 'terbaru' : 'sitasi';
      const arah = normArah(args?.arah);
      const urutTeks = urutkan === 'terbaru' ? 'terbaru dulu' : 'terbanyak dikutip dulu';

      const keluar = headerKarya(k, masukan);
      keluar.push('');

      // Peta struktur sitasi (issue upstream #122) — dijalankan SEBELUM daftar
      // biasa, karena keluarannya berbeda bentuk sepenuhnya.
      if (String(args?.analisis ?? '').trim().toLowerCase() === 'peta') {
        return petaStruktur({ karya, k, masukan, arah, email, args });
      }

      if (arah === 'rujukan') {
        const h = await karyaDikutip(karya, { rows, urutkan, email });
        keluar.push('arah: rujukan — karya yang DIKUTIP oleh paper di atas');
        keluar.push(`karya ini mencatat ${h.total} rujukan di OpenAlex · diperiksa ${h.diperiksa} · menampilkan ${h.papers.length} (${urutTeks})`);
        if (h.total === 0) {
          keluar.push('');
          keluar.push('OpenAlex TIDAK mencatat satu pun rujukan untuk karya ini.');
          keluar.push('Itu berarti datanya kosong di OpenAlex — BUKAN berarti papernya tidak mengutip apa pun.');
          return keluar.join('\n');
        }
        if (h.total > h.diperiksa) {
          keluar.push(`CATATAN: hanya ${h.diperiksa} rujukan pertama yang diperiksa (batas ${BATAS_RUJUKAN} per panggilan), jadi "terbanyak dikutip" berlaku di antara yang diperiksa.`);
        }
        keluar.push('');
        h.papers.forEach((p, i) => keluar.push(...barisPaper(p, i)));
        return keluar.join('\n');
      }

      const h = await karyaMengutip(karya, { rows, urutkan, email });
      keluar.push('arah: pengutip — paper yang MENGUTIP karya di atas');
      keluar.push(`total di OpenAlex: ${h.total} · menampilkan ${h.papers.length} (${urutTeks})`);
      if (h.total === 0) {
        keluar.push('');
        keluar.push('Belum ada yang mengutip menurut OpenAlex. Untuk paper baru itu wajar — indeks sitasi selalu tertinggal beberapa bulan.');
        return keluar.join('\n');
      }
      keluar.push('');
      h.papers.forEach((p, i) => keluar.push(...barisPaper(p, i)));
      return keluar.join('\n');
    },
  };
}

function toolOa(kredensial) {
  return {
    name: 'paper_oa',
    description:
      'Cari salinan AKSES-TERBUKA (gratis & sah) dari satu paper lewat OpenAlex — tanpa perlu email Unpaywall. '
      + 'Terima DOI, id/tautan OpenAlex (W…), atau JUDUL. '
      + 'Keluarannya menyebut status akses (gold/green/hybrid/bronze/closed) dan tautan PDF atau laman tiap salinan, beserta lisensinya. '
      + 'Pakai untuk: memeriksa apakah sebuah paper bisa dibaca gratis, mengambil PDF yang sah, atau saat Unpaywall menolak karena email belum diisi. '
      + 'Plugin ini TIDAK mengunduh PDF — ia hanya menunjukkan tautannya.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'DOI (10.…), id/tautan OpenAlex (W…), atau JUDUL paper.' },
      },
      required: ['identifier'],
    },
    output: keluaranTeks('Laporan teks: karya yang dipakai, status akses terbuka (gold/green/hybrid/bronze/closed), dan daftar salinan OA (tautan PDF/laman, lisensi, versi, sumber).'),
    execute: async (args) => {
      const masukan = args?.identifier;
      const email = emailPolite(kredensial);
      const karya = await resolusiKarya(masukan, { email });
      const oa = ringkasOA(karya);
      const keluar = headerKarya(ringkasKarya(karya), masukan);
      keluar.push('');

      if (!oa.isOa) {
        keluar.push(`status akses: TIDAK AKSES TERBUKA${oa.status ? ` (${oa.status})` : ''} — OpenAlex tidak melihat salinan gratisnya.`);
        keluar.push('');
        keluar.push('langkah berikutnya:');
        keluar.push('  - paper_search dengan DOI ini (sumber unpaywall) — butuh UNPAYWALL_EMAIL terisi');
        keluar.push('  - paper_search dengan judulnya (sumber arxiv) — versi pra-cetak sering tersedia');
        keluar.push('  - sisanya lewat perpustakaan kampus; plugin ini TIDAK menembus paywall');
        return keluar.join('\n');
      }

      keluar.push(`status akses: AKSES TERBUKA${oa.status ? ` (${oa.status})` : ''}`);
      if (oa.lokasi.length === 0) {
        keluar.push('salinan: OpenAlex menandainya akses terbuka, tetapi tidak merinci lokasinya.');
        if (oa.oaUrl) keluar.push(`tautan: ${oa.oaUrl}`);
        return keluar.join('\n');
      }
      keluar.push(`salinan ditemukan: ${oa.lokasi.length}`);
      oa.lokasi.forEach((l, i) => {
        keluar.push(`${String(i + 1).padStart(2)}. ${l.pdf ? 'PDF  ' : 'laman'} ${l.pdf ?? l.landing}`);
        const ket = [l.license, l.version, l.sumber].filter(Boolean).join(' · ');
        if (ket) keluar.push(`    ${ket}`);
        if (l.pdf && l.landing) keluar.push(`    laman: ${l.landing}`);
      });
      keluar.push('');
      keluar.push('CATATAN: plugin ini tidak mengunduh PDF — tautan di atas untuk dibuka sendiri.');
      return keluar.join('\n');
    },
  };
}

// ── Teks lengkap: PDF -> Markdown ───────────────────────────────────────────
//
// Adopsi PR upstream #124 (arXiv sebagai cadangan repositori OA) DITAMBAH satu
// langkah yang upstream tidak punya: PDF-nya diubah ke Markdown, karena model
// tidak bisa membaca PDF mentah dan satu paper utuh tidak muat dikirim sekaligus.

const MUAT_DIKIRIM_SEKALIGUS = 20000;
const CUPLIKAN_AWAL = 1500;

function toolFulltext(kredensial, config) {
  const akar = config?.folderTeksLengkap ?? config?.FOLDER_TEKS_LENGKAP ?? AKAR_BAWAAN;
  return {
    name: 'paper_fulltext',
    description:
      'Ambil ISI LENGKAP sebuah paper: cari salinan AKSES-TERBUKA-nya (versi arXiv lebih dulu, lalu lokasi OA OpenAlex/Unpaywall), unduh PDF-nya, lalu ubah ke Markdown dengan anydoc supaya bisa dibaca UTUH oleh agen. '
      + 'Terima DOI, id/tautan OpenAlex (W…), id arXiv (1706.03762), atau JUDUL. '
      + 'Pakai untuk: membaca isi paper, mengambil metodologi/hasil/angka, mengutip bagian tertentu, atau memeriksa klaim sebuah paper. '
      + 'Berkas Markdown dan PDF-nya disimpan di folder perpustakaan lalu jalurnya dikembalikan — kalau isinya panjang, bacalah bertahap dengan tool read (offset/limit). '
      + 'TIDAK menembus paywall: kalau tidak ada salinan yang sah, itu dikatakan apa adanya.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'DOI (10.…), id/tautan OpenAlex (W…), id arXiv (1706.03762), atau JUDUL paper.' },
        paksa_ulang: { type: 'boolean', description: 'Lewati cache dan ulangi dari awal (bawaan false). Pada mode search: cari ulang ke semua sumber, mengabaikan cache pencarian. Pada mode fulltext: unduh & konversi ulang walau hasilnya sudah ada.' },
      },
      required: ['identifier'],
    },
    output: keluaranTeks('Laporan teks: karya yang dipakai, jalur berkas Markdown + PDF beserta ukurannya, sumber PDF dan konverter yang dipakai, lalu ISI LENGKAP (kalau muat) atau cuplikan + cara membaca sisanya dengan tool read.'),
    execute: async (args) => {
      const masukan = String(args?.identifier ?? '').trim();
      if (!masukan) throw new Error('identifier wajib diisi: DOI, id OpenAlex (W…), id arXiv, atau judul paper');
      const email = emailPolite(kredensial);
      const konverter = cariKonverter(config ?? {});

      // Id arXiv langsung: jangan tanya OpenAlex (belum tentu ada di sana).
      const mArxiv = apakahArxivId(masukan);
      let karya;
      let arxivDiminta = null;
      if (mArxiv) {
        arxivDiminta = mArxiv.id;
        const p = await karyaArxiv(mArxiv.id);
        karya = {
          title: p?.title ?? `arXiv:${mArxiv.id}`,
          doi: p?.doi ?? null,
          publication_year: p?.year ?? null,
          open_access: { is_oa: true, oa_status: 'green' },
          locations: [{ is_oa: true, pdf_url: `https://arxiv.org/pdf/${mArxiv.id}`, landing_page_url: p?.url ?? null, source: { display_name: 'arXiv' } }],
        };
      } else {
        karya = await resolusiKarya(masukan, { email });
      }

      const keluar = headerKarya(ringkasKarya(karya), masukan, { dariArxiv: arxivDiminta });
      keluar.push('');

      const h = await siapkanTeksLengkap({
        karya, identifier: masukan, email, konverter, akar, paksaUlang: args?.paksa_ulang === true,
      });

      if (h.masalah) {
        keluar.push(`GAGAL: ${h.masalah}`);
        if (h.kandidat?.length) {
          keluar.push('');
          keluar.push('kandidat PDF yang dicoba:');
          for (const c of h.kandidat) keluar.push(`  - ${c.dari}: ${c.url}`);
        }
        keluar.push('');
        keluar.push('yang TIDAK dilakukan plugin ini: menembus paywall, Sci-Hub, atau Anna\'s Archive.');
        keluar.push('langkah berikutnya: paper_oa (periksa salinan lain) · paper_search dengan DOI ini (sumber unpaywall) · perpustakaan kampus.');
        return keluar.join('\n');
      }

      const teks = readFileSync(h.md, 'utf8');
      const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
      keluar.push('berkas:');
      keluar.push(`  markdown : ${h.md}`);
      keluar.push(`             ${kb(statSync(h.md).size)} · ${teks.length} huruf`);
      keluar.push(`  pdf      : ${h.pdf}${existsSync(h.pdf) ? ` (${kb(statSync(h.pdf).size)})` : ' (tidak tersimpan)'}`);
      keluar.push(`sumber PDF : ${h.dipakai?.dari ?? '-'}${h.dipakai?.catatan ? ` — ${h.dipakai.catatan}` : ''}`);
      keluar.push(`konverter  : ${h.konverter?.nama ?? '-'} (${h.konverter?.dari ?? '-'})`);
      if (h.dariCache) {
        keluar.push('catatan    : berkas ini SUDAH ADA dari sebelumnya — tidak mengunduh ulang.');
        keluar.push('             pakai paksa_ulang: true kalau memang ingin menyegarkan.');
      }
      if (h.arxivId) {
        keluar.push(`arsip arXiv: ${h.arxivId}${h.arxivDariJudul
          ? ` (DICARI DARI JUDUL${h.arxivPersis === false ? ', kemiripan sebagian' : ''} — periksa dulu apakah ini paper yang sama)`
          : ''}`);
      }
      if (h.catatanArxiv) keluar.push(`catatan    : ${h.catatanArxiv}`);
      keluar.push('');

      if (teks.length <= MUAT_DIKIRIM_SEKALIGUS) {
        keluar.push(`--- ISI LENGKAP (${teks.length} huruf — muat dikirim sekaligus) ---`);
        keluar.push(teks);
        return keluar.join('\n');
      }
      keluar.push(`--- cuplikan ${CUPLIKAN_AWAL} huruf pertama (isi lengkap ${teks.length} huruf) ---`);
      keluar.push(teks.slice(0, CUPLIKAN_AWAL));
      keluar.push('');
      keluar.push('cara membaca sisanya — JANGAN minta seluruh isi sekaligus:');
      keluar.push(`  read({ file_path: "${h.md.replace(/\\/g, '/')}", offset: 1, limit: 400 })`);
      keluar.push('  lalu lanjutkan offset-nya sampai selesai.');
      return keluar.join('\n');
    },
  };
}

// ── Skill ────────────────────────────────────────────────────────────────────

/** Pengurai frontmatter datar — cukup untuk SKILL.md milik paket ini. */
function uraiFrontmatter(mentah) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(mentah);
  if (!m) return null;
  const blok = m[1];
  const badan = mentah.slice(m[0].length).trim();
  const ambil = (kunci) => {
    const a = new RegExp(`^${kunci}:\\s*"([^"]*)"`, 'm').exec(blok);
    if (a) return a[1].trim();
    const b = new RegExp(`^${kunci}:\\s*(.+)$`, 'm').exec(blok);
    return b ? b[1].trim() : '';
  };
  const nama = ambil('name');
  if (!nama) return null;
  return {
    nama,
    deskripsi: ambil('description'),
    kapanPakai: ambil('whenToUse'),
    // Kebijakan invocation dihormati DARI BERKAS, jangan dipaksakan `true`.
    modelInvocable: ambil('disable-model-invocation').toLowerCase() !== 'true',
    userInvocable: ambil('user-invocable').toLowerCase() !== 'false',
    badan,
  };
}

function daftarkanSkill(ctx, notes, modeAlat = 'five') {
  const skills = ctx.get('skills');
  if (!skills || typeof skills.registerProvider !== 'function') {
    notes.push('service skills tidak tersedia — skill hanya terbaca dari berkas');
    return;
  }
  const baca = async () => {
    try {
      const fsSvc = ctx.get('fs');
      let mentah;
      if (fsSvc && typeof fsSvc.readText === 'function') {
        mentah = await fsSvc.readText(await fsSvc.resolve(BERKAS_SKILL));
      } else {
        if (!existsSync(BERKAS_SKILL)) return null;
        mentah = readFileSync(BERKAS_SKILL, 'utf8');
      }
      const isi = uraiFrontmatter(mentah);
      // Nama di frontmatter harus cocok — kalau tidak, ini bukan skill kita.
      return isi && isi.nama === 'paper-search' ? isi : null;
    } catch {
      return null;
    }
  };
  const ringkas = (isi) => ({
    name: isi.nama,
    // Pada mode satu pintu, deskripsi katalog diberi keterangan singkat supaya
    // model tidak mencari nama tool yang memang tidak ada di profil ini.
    // Panjangnya dijaga <= 500 huruf (batas katalog) — diuji di
    // test/uji-satu-pintu.mjs.
    description: modeAlat === 'one'
      ? `${isi.deskripsi || ''} (profil ini: satu tool \`paper\` + parameter mode)`
      : (isi.deskripsi || ''),
    ...(isi.kapanPakai ? { whenToUse: isi.kapanPakai } : {}),
    invocation: { modelInvocable: isi.modelInvocable, userInvocable: isi.userInvocable },
    source: 'runtime',
    provider: 'paper-search-runtime',
    // Rank 450: DI ATAS 400 (~/.dsh/skills) supaya kalah dari berkas yang
    // disunting pengguna, tetapi masih menang atas user-agents/bundled (500/600).
    rank: 450,
    locator: { berkas: BERKAS_SKILL },
  });

  ctx.effect(() => skills.registerProvider(() => ({
    name: 'paper-search-runtime',
    // Dibaca SETIAP kali (tidak di-cache) supaya suntingan SKILL.md langsung
    // terpakai tanpa restart DSH.
    list: async () => {
      const isi = await baca();
      return isi ? [ringkas(isi)] : [];
    },
    get: async (kandidat) => {
      if (kandidat?.name !== 'paper-search') return undefined;
      const isi = await baca();
      if (!isi) return undefined;
      return {
        ...ringkas(isi),
        // Catatan mode DISISIPKAN di sini (bukan di berkas SKILL.md) supaya
        // berkas aslinya tetap menggambarkan perilaku BAWAAN lima tool, sedang
        // profil yang memakai `tools: "one"` tetap diberi tahu.
        content: (modeAlat === 'one' ? CATATAN_SATU : '') + isi.badan,
        resourceBase: { kind: 'directory', path: dirname(BERKAS_SKILL) },
      };
    },
  })));
  notes.push('skill paper-search terdaftar di layer global (rank 450, cadangan)');
}

// ── Mode "satu pintu" (opsi config `tools: 'one'`) ───────────────────────────

/** Label pendek tiap mode untuk deskripsi pintu tunggal. */
const LABEL_MODE = {
  search: 'cari literatur di 23 sumber',
  status: 'periksa kesehatan sumber, kredensial, dan konverter',
  citations: 'graf sitasi (siapa mengutip / mengutip siapa)',
  oa: 'cari salinan akses-terbuka',
  fulltext: 'unduh PDF akses-terbuka lalu ubah ke Markdown',
};

/** Catatan yang DISISIPKAN ke badan skill saat profil memakai mode satu pintu. */
const CATATAN_SATU =
  '> ⚠️ **Profil ini memasang plugin dengan `tools: "one"`.** Kelima kemampuan '
  + 'dipanggil lewat **SATU tool bernama `paper`** dengan parameter `mode` '
  + '(`search` · `status` · `citations` · `oa` · `fulltext`). Nama tool terpisah '
  + 'seperti `paper_fulltext` **tidak ada** di profil ini — di mana pun dokumen '
  + 'ini menyebut `paper_xxx`, panggil `paper({ mode: "xxx" })`.\n\n';

/**
 * `tools`: `'five'` (bawaan — perilaku lama) atau `'one'` (satu pintu).
 * Nilai tak dikenal JANGAN diam-diam dipakai: kembalikan bawaan + catatan.
 */
function normalkanTools(nilai) {
  const v = String(nilai ?? '').trim().toLowerCase();
  if (v === 'one' || v === 'satu') return { mode: 'one', catatan: null };
  if (v === '' || v === 'five' || v === 'lima') return { mode: 'five', catatan: null };
  return {
    mode: 'five',
    catatan: `config tools="${nilai}" tidak dikenal — dipakai bawaan "five" (pilih "five" atau "one")`,
  };
}

/**
 * Gabungkan lima definisi tool jadi SATU pintu berparameter `mode`.
 *
 * KENAPA ADA. Kelima definisi tool ikut dikirim ke model SETIAP permintaan —
 * terukur 29 Sep 2026: 4.877 huruf ≈ 1.219 token. Satu pintu memangkasnya
 * sekitar 70%, dengan harga yang harus disadari: nama tool berhenti menjelaskan
 * dirinya, dan skema jadi longgar sehingga penjagaan parameter wajib berpindah
 * dari DSH ke fungsi ini.
 *
 * Skema (`properties`) dan parameter wajib DITURUNKAN dari definisi aslinya,
 * bukan disalin — supaya keduanya tidak bisa menyimpang saat tool aslinya
 * berubah. Karena satu skema tidak bisa mewajibkan parameter berbeda per mode,
 * kewajiban itu diperiksa di `execute` dengan pesan yang menyerupai penolakan
 * skema DSH.
 */
function gabungJadiSatu(daftar) {
  const namaMode = (n) => n.replace(/^paper_/, '');
  const peta = new Map(daftar.map((t) => [namaMode(t.name), t]));
  const sifat = {};
  const wajib = {};
  for (const [mode, t] of peta) {
    Object.assign(sifat, t.parameters?.properties ?? {});
    const perlu = t.parameters?.required ?? [];
    if (perlu.length) wajib[mode] = perlu;
  }
  const daftarMode = [...peta].map(([mode, t]) => {
    const perlu = (t.parameters?.required ?? []).join(' + ');
    const label = LABEL_MODE[mode] ?? t.description.split('.')[0];
    return `${mode} = ${label}${perlu ? ` (butuh ${perlu})` : ' (tanpa parameter wajib)'}`;
  }).join(' · ');

  return {
    name: 'paper',
    description:
      `Satu pintu literatur ilmiah — WAJIB sebut \`mode\`. Pilihan: ${daftarMode}. `
      + 'Jalankan `mode: "search"` lebih dulu; kalau hasilnya kosong, jalankan `mode: "status"` sebelum menyimpulkan "tidak ada hasil". '
      + 'Untuk citations/oa/fulltext, `identifier` boleh DOI, id arXiv, id OpenAlex (W…), atau judul. '
      + 'Mode `fulltext` hanya bekerja untuk salinan akses-terbuka dan tidak menembus paywall.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: [...peta.keys()],
          description: 'Kemampuan yang dipanggil. Wajib.',
        },
        ...sifat,
      },
      required: ['mode'],
    },
    output: keluaranTeks('Laporan teks — bentuknya mengikuti `mode` yang dipilih (sama dengan laporan tool terpisahnya).'),
    execute: async (args) => {
      const mode = String(args?.mode ?? '').trim();
      const t = peta.get(mode);
      if (!t) {
        return `mode tidak dikenal: "${mode}" — pilih salah satu: ${[...peta.keys()].join(', ')}.`;
      }
      const kurang = (wajib[mode] ?? []).filter((k) => args?.[k] === undefined || args?.[k] === '');
      if (kurang.length) {
        // Meniru penolakan skema DSH: parameter wajib per mode tidak bisa
        // diwajibkan lewat satu skema, jadi diperiksa di sini.
        return `mode "${mode}" membutuhkan ${kurang.map((k) => `\`${k}\``).join(' dan ')} — belum diisi.`;
      }
      return t.execute(args);
    },
  };
}

// ── apply ────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const notes = [];
  const kredensial = buatPembacaKredensial(config);

  // Cache pencarian: AKTIF secara bawaan (TTL 30 menit). Kalau mati secara
  // bawaan, fiturnya tidak akan pernah terpakai — dan pencarian yang sama
  // berulang dalam satu sesi itu justru hal yang paling sering terjadi.
  // Bisa dimatikan lewat config `cache: false`, dan setiap pemakaiannya
  // SELALU dilaporkan + bisa dipaksa ulang per panggilan.
  const akarPerpus = config?.folderTeksLengkap ?? config?.FOLDER_TEKS_LENGKAP ?? AKAR_BAWAAN;
  const cacheMati = config?.cache === false || String(config?.cache ?? '').toLowerCase() === 'off';
  const cache = cacheMati ? null : buatCache({
    berkas: config?.berkasCache ?? berkasCacheBawaan(akarPerpus),
    ttlMs: Number(config?.cacheTtlMs) > 0 ? Number(config.cacheTtlMs) : TTL_BAWAAN_MS,
  });
  if (cache) notes.push(`cache pencarian aktif: ${cache.berkas} (TTL ${Math.round(cache.ttlMs / 60000)} menit; matikan dengan config cache=false)`);
  else notes.push('cache pencarian DIMATIKAN lewat config');

  const lima = [
    toolSearch(kredensial, cache),
    toolStatus(kredensial, config, cache),
    toolCitations(kredensial),
    toolOa(kredensial),
    toolFulltext(kredensial, config),
  ];
  const pilihan = normalkanTools(config?.tools);
  if (pilihan.catatan) notes.push(pilihan.catatan);
  if (pilihan.mode === 'one') {
    const pintu = gabungJadiSatu(lima);
    ctx.effect(() => ctx.tools.register(pintu));
    notes.push(`tool ${pintu.name} (satu pintu) terdaftar — config tools="one"`);
  } else {
    for (const t of lima) {
      ctx.effect(() => ctx.tools.register(t));
      notes.push(`tool ${t.name} terdaftar`);
    }
  }
  const konv = cariKonverter(config ?? {});
  notes.push(konv ? `konverter PDF->Markdown: ${konv.nama} (${konv.dari})` : 'PERINGATAN: tidak ada konverter PDF->Markdown — paper_fulltext akan menolak dengan pesan yang jelas');

  daftarkanSkill(ctx, notes, pilihan.mode);

  if (SUMBER.length !== 23) {
    // Penjaga: deskripsi paket, README, SKILL.md, CHANGELOG, dan entri katalog
    // semuanya menyebut JUMLAH sumber. Kalau daftar ini berubah, kelimanya harus
    // ikut — dan penilai katalog memang mencocokkan angka di deskripsi ke kode.
    notes.push(`PERINGATAN: jumlah sumber ${SUMBER.length}, bukan 19 — perbarui deskripsi package.json, README, SKILL.md, CHANGELOG, entri katalog, dan uji/uji-sumber.mjs`);
  }
  notes.push(`${ID_INTERNASIONAL.length} sumber internasional + ${ID_INDONESIA.length} sumber Indonesia`);
  return notes.join(' · ');
}
