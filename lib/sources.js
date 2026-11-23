// lib/sources.js — konektor sumber literatur untuk dsh-paper-search.
//
// DUA JENIS SUMBER, dan bedanya penting (jangan disamarkan):
//
//   kind: 'api'  — REST API publik yang mengembalikan JSON. Stabil, ada skema.
//   kind: 'html' — halaman web publik yang HARUS diurai. Rapuh menurut sifatnya:
//                  operator bisa mengubah markup kapan saja dan pengurai ini
//                  akan mengembalikan 0 hasil. Karena itu kegagalannya WAJIB
//                  dilaporkan apa adanya (lihat `searchSource`), bukan diubah
//                  menjadi "tidak ada hasil".
//
// ATURAN YANG DIPAKAI SELURUH BERKAS INI: kegagalan tidak boleh menyamar jadi
// kekosongan. Semua non-2xx melempar error beserta status dan cuplikan body;
// `searchSource` menangkapnya dan mengembalikannya sebagai `error`, terpisah
// dari `papers`. Ini pelajaran dari `paper-search-mcp` upstream, yang
// mengembalikan `[]` untuk SETIAP status != 200 tanpa jejak — sehingga arXiv
// yang menjawab 406 tampak seperti "tidak ada paper".

const UA = 'dsh-paper-search/0.1 (+https://github.com/rasyidmmz/dsh-paper-search)';
const TIMEOUT_MS = 25000;

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function getText(url, { headers = {}, accept, timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const jam = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}), ...headers },
    });
    const teks = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      // `body` untuk PESAN (pendek). `bodyPenuh` disimpan TERPISAH supaya isi
      // balasan yang masih berguna bisa diselamatkan — terukur di arXiv:
      // HTTP 406 kadang justru membawa Atom feed yang SAH (issue #121).
      err.body = teks.slice(0, 160).replace(/\s+/g, ' ');
      err.bodyPenuh = teks.slice(0, 512 * 1024);
      throw err;
    }
    return teks;
  } finally {
    clearTimeout(jam);
  }
}

async function getJson(url, opts) {
  return JSON.parse(await getText(url, { ...opts, accept: 'application/json' }));
}

// ── Bentuk hasil seragam ─────────────────────────────────────────────────────

const ENTITAS = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function bersihTeks(s) {
  if (!s) return null;
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m, k) => ENTITAS[k.toLowerCase()] ?? (k[0] === '#' ? String.fromCharCode(Number(k.slice(1))) : m))
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function potong(s, n) {
  const t = bersihTeks(s);
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Normalkan daftar penulis dari bentuk apa pun menjadi ARRAY nama. Tidak pernah
 * melempar; selalu mengembalikan array (boleh kosong).
 *
 * Ini jawaban atas tiga bug upstream yang sudah benar-benar terjadi
 * (issue #109, #110, #112): konektor mengoper **string** ke medan yang bertipe
 * daftar, lalu pemakainya meng-`join` string itu sehingga setiap nama terpecah
 * per huruf — `"TAN, Kwan Hong"` menjadi `"T; A; N; ,;  ; K; w; a; n; …"`.
 * Bentuk lain yang juga muncul di lapangan: array objek (`{name}`,
 * `{display_name}`, `{given, family}`), dan medan yang hilang sama sekali.
 *
 * SENGAJA TIDAK memecah pada KOMA: `"TAN, Kwan Hong"` adalah SATU penulis, dan
 * memecahnya justru merusak nama. Hanya titik koma yang dipakai sebagai pemisah.
 */
export function daftarPenulis(x) {
  const keluaran = [];
  const tambah = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach(tambah); return; }
    if (typeof v === 'object') {
      // Bentuk bersarang yang nyata di lapangan: OpenAlex membungkus penulis
      // sebagai `{ author: { display_name } }`.
      if (v.author) { tambah(v.author); return; }
      tambah(v.name ?? v.display_name ?? v.raw_author_name ?? v.fullName ?? v.fullname ?? v.full_name
        ?? [v.given, v.family].filter(Boolean).join(' '));
      return;
    }
    if (typeof v === 'string') {
      for (const bagian of v.split(';')) {
        const b = bersihTeks(bagian);
        if (b) keluaran.push(b);
      }
      return;
    }
    const s = bersihTeks(v);
    if (s) keluaran.push(s);
  };
  tambah(x);
  return keluaran.slice(0, 50);
}

/** DOI dinormalkan tanpa awalan URL — supaya dedup bekerja. */
export function normDoi(doi) {
  if (!doi) return null;
  const d = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return d.length > 3 ? d.toLowerCase() : null;
}

/**
 * Garuda menulis judul di dalam elemen <xmp> dengan BEBERAPA bentuk pengulangan,
 * dan mengulanginya untuk mengisi lebar tampilan. Keempatnya diukur 28 Sep 2026
 * dari **50 judul sungguhan** (5 kueri):
 *
 *   A. periode persis        "X X X X X X"                         (255 huruf)
 *   B. diulang sesudah ": "   "X: X"                                (194 huruf)
 *   C. awalan lalu "X: X"     "NLP, Machine Learning X: X"          (270 huruf)
 *   D. frasa diulang di awal  "IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI …"
 *
 * Yang TIDAK boleh disentuh — dan sudah diperiksa pada 50 sampel itu: judul SAH
 * berformat "Judul: subjudul", "Judul: (studi kasus)", dan "Judul: kata kunci".
 * Karena itu aturan (c) menuntut bagian sesudah ": " benar-benar SAMA dengan
 * akhiran bagian sebelumnya — bukan sekadar ada titik dua. Pada 50 sampel,
 * tidak satu pun judul sah ikut terpotong.
 *
 * Sengaja konservatif: lebih baik judul berlebihan daripada judul terpotong salah.
 */
export function runtuhkanJudul(s) {
  let t = (s ?? '').trim();
  for (let putaran = 0; putaran < 4; putaran++) {
    const sebelum = t;

    // (A) periode persis: cari periode terkecil, sisakan satu salinan.
    const n = t.length;
    for (let p = 10; p <= Math.floor(n / 2); p++) {
      let cocok = true;
      for (let i = p; i < n; i++) {
        if (t[i] !== t[i % p]) { cocok = false; break; }
      }
      if (cocok) { t = t.slice(0, p).trim(); break; }
    }

    // (D) frasa yang diulang di awal: "A A sisa" -> "A sisa".
    // `A` harus berakhir di batas kata, supaya tidak memotong di tengah kata.
    for (let p = 8; p <= Math.floor(t.length / 2); p++) {
      const a = t.slice(0, p);
      if (!/[\s.)\]]$/.test(a)) continue;
      if (t.startsWith(a + a)) { t = (a + t.slice(2 * p)).trim(); break; }
    }

    // (B)/(C) diulang sesudah ": " terakhir — dibandingkan TANPA peduli huruf
    // besar/kecil, karena Garuda sering mengulang judul dengan kapitalisasi beda.
    const pisah = t.lastIndexOf(': ');
    if (pisah > 0) {
      const ekor = t.slice(pisah + 2).trim();
      const kepala = t.slice(0, pisah).trim();
      if (ekor.length >= 20 && kepala.toLowerCase().endsWith(ekor.toLowerCase())) t = kepala;
    }

    if (t === sebelum) break;
  }
  return t;
}

function buatPaper(p) {
  const doi = normDoi(p.doi);
  const sitasi = Number(p.citedBy);
  return {
    title: potong(runtuhkanJudul(bersihTeks(p.title) ?? ''), 300),
    authors: daftarPenulis(p.authors).slice(0, 15),
    year: Number.isFinite(Number(p.year)) && Number(p.year) > 1500 ? Number(p.year) : null,
    source: p.source,
    doi,
    url: p.url || (doi ? `https://doi.org/${doi}` : null),
    journal: bersihTeks(p.journal),
    abstract: potong(p.abstract, 900),
    openAccess: !!p.openAccess,
    // Jumlah sitasi hanya dilaporkan sebagian sumber (OpenAlex, Semantic Scholar).
    // `null` = TIDAK DIKETAHUI, dan itu berbeda dari 0 — jangan ditampilkan
    // sebagai "0 sitasi" oleh pemakainya.
    citedBy: Number.isFinite(sitasi) ? sitasi : null,
    // Jenis karya — HANYA kalau sumbernya benar-benar melaporkannya. `null`
    // berarti "tidak dilaporkan", dan itu BERBEDA dari "bukan artikel": penyaring
    // `jenis` sengaja tetap menampilkan yang null (lihat `saringDanUrutkan`).
    type: p.type ? String(p.type).toLowerCase() : null,
  };
}

// ── Sumber INTERNASIONAL (API JSON) ──────────────────────────────────────────

const KOLOM_CROSSREF = 'DOI,title,container-title,author,issued,abstract,URL,type';

/**
 * Terjemahkan `jenis` (kosakata kita: article/review/preprint) ke kosakata
 * Crossref. Crossref **tidak punya** jenis "review" — artikel tinjauan di sana
 * tetap `journal-article` — jadi permintaan `review` sengaja TIDAK dipaksakan:
 * menyaringnya dengan `journal-article` akan mengembalikan SEMUA artikel, yaitu
 * kebalikan dari yang diminta. Penyaringan `review` dilakukan setelah hasilnya
 * datang, dari medan yang sumbernya benar-benar laporkan.
 *
 * Filter yang sama ditulis BERULANG untuk beberapa jenis — itu cara Crossref
 * menyatakan ATAU (OR) pada satu medan.
 */
function saringKrossref(jenis) {
  const map = { article: 'journal-article', preprint: 'posted-content' };
  const t = (jenis ?? []).map((j) => map[j]).filter(Boolean);
  return t.length ? t.map((x) => `type:${x}`).join(',') : null;
}

/**
 * Satu item Crossref -> satu paper. DIPAKAI DUA SUMBER (`crossref` dan `acm`),
 * supaya keduanya tidak bisa menyimpang satu sama lain.
 */
function dariItemCrossref(it, source) {
  return buatPaper({
    title: it.title?.[0],
    authors: daftarPenulis(it.author),
    year: it.issued?.['date-parts']?.[0]?.[0],
    source,
    doi: it.DOI,
    url: it.URL,
    type: it.type,
    journal: it['container-title']?.[0],
    abstract: it.abstract,
  });
}

async function crossref(query, { rows, email, jenis = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  u.searchParams.set('select', KOLOM_CROSSREF);
  const saringJenis = saringKrossref(jenis);
  if (saringJenis) u.searchParams.set('filter', saringJenis);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => dariItemCrossref(it, 'crossref')).filter((p) => p.title);
}

/**
 * ACM Digital Library — lewat Crossref, disaring ke prefix DOI `10.1145`.
 * **Tanpa kunci API.** Ini adopsi PR upstream **#123**: di sana `acm.py` adalah
 * kerangka yang selalu melempar `NotImplementedError`, jadi sumbernya mustahil
 * dihidupkan dengan kunci (`PAPER_SEARCH_MCP_ACM_API_KEY` tidak akan pernah bisa
 * diisi nilai sah). ACM tidak punya API pencarian publik — tetapi seluruh
 * terbitannya terdaftar di Crossref dengan satu prefix DOI, dan prefix itu bisa
 * disaring.
 *
 * Terukur 28 Sep 2026: `filter=prefix:10.1145` menjawab HTTP 200 dan **setiap**
 * hasilnya ber-DOI `10.1145/…` (7.6 juta karya di Crossref).
 *
 * YANG SENGAJA **TIDAK** DIKLAIM: bahwa hasilnya akses terbuka. Upstream PR #123
 * menyebut ACM DL terbuka sejak 1 Jan 2026, tetapi **diukur ulang di sini**:
 * `HEAD https://dl.acm.org/doi/pdf/<doi 2026>` dijawab **HTTP 403**, dan hanya
 * **9 dari 20** ACM terbitan 2026 punya medan `license` di Crossref. Jadi
 * `openAccess` dibiarkan apa adanya (false) — sumber yang mengklaim OA tanpa
 * bukti lebih buruk daripada yang tidak mengklaim.
 */
async function acm(query, { rows, email, jenis = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  const saringJenis = saringKrossref(jenis);
  // Bentuk literal `'prefix:10.1145'` SENGAJA dipertahankan: uji lama memeriksa
  // persis string itu, dan filter `jenis` hanya DITAMBAHKAN di belakangnya —
  // menyimpang dari bentuk itu akan membuat penjaganya buta tanpa alasan.
  u.searchParams.set('filter', 'prefix:10.1145' + (saringJenis ? `,${saringJenis}` : ''));
  u.searchParams.set('select', KOLOM_CROSSREF);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => dariItemCrossref(it, 'acm')).filter((p) => p.title);
}

/** OpenAlex menyimpan abstrak sebagai indeks terbalik — harus disusun ulang. */
function abstrakOpenAlex(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const pos = [];
  for (const [kata, idxs] of Object.entries(inv)) for (const i of idxs) pos[i] = kata;
  return pos.filter(Boolean).join(' ') || null;
}

/** Satu karya OpenAlex -> bentuk paper seragam. Dipakai pencarian DAN graf sitasi. */
function dariKaryaOpenAlex(w, source = 'openalex') {
  return buatPaper({
    title: w.title,
    authors: daftarPenulis(w.authorships),
    year: w.publication_year,
    source,
    doi: w.doi,
    url: w.doi || w.id,
    journal: w.primary_location?.source?.display_name,
    abstract: abstrakOpenAlex(w.abstract_inverted_index),
    openAccess: !!w.open_access?.is_oa,
    citedBy: w.cited_by_count,
    type: w.type,
  });
}

async function openalex(query, { rows, email, minSitasi = null, jenis = null }) {
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', query);
  u.searchParams.set('per-page', String(rows));
  // Push-down: ambang sitasi dan jenis dikerjakan OpenAlex sendiri, supaya
  // `max_results` tetap terisi hasil yang LOLOS filter — bukan dipangkas setelah
  // datang (yang membuat hasilnya tinggal sedikit).
  const filter = [];
  if (Number.isFinite(minSitasi) && minSitasi > 0) filter.push(`cited_by_count:>${Math.max(0, Math.floor(minSitasi) - 1)}`);
  const t = (jenis ?? []).filter((j) => ['article', 'review', 'preprint'].includes(j));
  if (t.length) filter.push(`type:${t.join('|')}`);
  if (filter.length) u.searchParams.set('filter', filter.join(','));
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((w) => dariKaryaOpenAlex(w)).filter((p) => p.title);
}

// ── Graf sitasi OpenAlex (PR upstream #96) ───────────────────────────────────
//
// TIGA hal yang ditambahkan PR #96 di upstream, dan di sini diwujudkan menjadi
// DUA tool + satu fungsi `paper_oa`:
//   get_citing_papers     -> `paper_citations` arah "pengutip"
//   get_referenced_papers -> `paper_citations` arah "rujukan"
//   find_open_access_pdf  -> `paper_oa`
//
// Kenapa TIDAK tiga tool terpisah seperti upstream: setiap tool yang didaftarkan
// ikut dikirim ULANG ke model pada SETIAP permintaan. Upstream tidak menghitung
// biaya itu (PR #97 di sana mengekspos 57 tool). Di sini dua arah sitasi berbagi
// satu skema karena bentuk masukannya identik.

const OPENALEX = 'https://api.openalex.org';

/** Batas jumlah rujukan yang benar-benar diambil — pagar biaya, bukan batas API. */
export const BATAS_RUJUKAN = 100;

function urlOpenAlex(path, params = {}, email) {
  const u = new URL(OPENALEX + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (email) u.searchParams.set('mailto', email);
  return u.toString();
}

/**
 * Semua panggilan OpenAlex lewat sini supaya pesan galatnya konsisten.
 * HTTP 429 dari OpenAlex itu **transien** dan sudah beberapa kali terukur di
 * proyek ini; "HTTP 429" mentah tidak memberi tahu pemakainya harus apa.
 * 404 sengaja TIDAK diterjemahkan di sini — tiap pemanggil punya pesan sendiri
 * yang lebih tepat (DOI vs id OpenAlex vs judul).
 */
async function openalexJson(path, params, email) {
  try {
    return await getJson(urlOpenAlex(path, params, email));
  } catch (e) {
    if (e?.status === 429) {
      throw new Error('OpenAlex membatasi laju (HTTP 429) — tunggu sekitar 10 detik lalu ulangi. Mengisi OPENALEX_EMAIL atau UNPAYWALL_EMAIL menaikkan batas "polite pool".');
    }
    // Terukur 29 Sep 2026: `works/doi:…` sempat dijawab HTTP 504 "Gateway
    // timeout" dengan body JSON yang menjelaskan (`reason: query_timeout`).
    // Tanpa diterjemahkan, pemakainya hanya melihat "HTTP 504" tanpa tahu
    // bahwa itu transien dan cukup diulang.
    if (e?.status === 504 || e?.status === 503) {
      throw new Error(`OpenAlex sedang lambat (HTTP ${e.status}) — ini transien, ulangi sebentar lagi`);
    }
    throw e;
  }
}

/** Id pendek OpenAlex: "https://openalex.org/W123" -> "W123". */
export function idKarya(w) {
  return String(w?.id ?? '').split('/').pop() || null;
}

/** Apakah masukan ini id OpenAlex (W…), bukan DOI dan bukan judul. */
export function apakahIdKarya(t) {
  return /^(?:https?:\/\/openalex\.org\/)?W\d+$/i.test(String(t ?? '').trim());
}

/** Ringkasan satu karya OpenAlex — dipakai header keluaran graf sitasi & OA. */
export function ringkasKarya(w) {
  const sitasi = Number(w?.cited_by_count);
  return {
    id: idKarya(w),
    title: bersihTeks(w?.title),
    year: w?.publication_year ?? null,
    doi: normDoi(w?.doi),
    journal: bersihTeks(w?.primary_location?.source?.display_name),
    authors: daftarPenulis(w?.authorships),
    citedBy: Number.isFinite(sitasi) ? sitasi : null,
  };
}

/**
 * DOI / id OpenAlex / JUDUL -> SATU karya OpenAlex.
 *
 * Judul diterima karena model sering hanya punya judulnya. Tetapi pemilihan
 * lewat judul bisa SALAH — terukur 28 Sep 2026: kueri judul
 * *"Attention is all you need"* mengembalikan `W2626778328`, sebuah rekaman
 * duplikat ber-DOI aneh, bukan rekaman aslinya. Karena itu pemanggil WAJIB
 * menampilkan karya yang benar-benar terpilih (lihat `ringkasKarya`), supaya
 * salah pilih terlihat, bukan tersamar.
 */
export async function resolusiKarya(identifier, { email } = {}) {
  const t = String(identifier ?? '').trim();
  if (!t) throw new Error('identifier wajib diisi: DOI (10.…), id OpenAlex (W…), atau judul paper');

  if (apakahIdKarya(t)) {
    const id = t.split('/').pop();
    try {
      return await openalexJson(`/works/${id}`, {}, email);
    } catch (e) {
      if (e.status === 404) throw new Error(`id OpenAlex ${id} tidak ditemukan`);
      throw e;
    }
  }

  // PENTING: yang menentukan "ini DOI" adalah `apakahDoi()`, BUKAN `normDoi()`.
  // `normDoi()` hanya membuang awalan URL lalu memeriksa panjang — ia menerima
  // HAMPIR semua teks, jadi memakainya di sini membuat setiap judul diperlakukan
  // sebagai DOI (tertangkap smoke test 29 Sep 2026: "zzzqqqxxyy tidak mungkin
  // ada" dijawab "DOI … tidak ditemukan", bukan dicari sebagai judul).
  // `normDoi()` dipakai SETELAH lolos, untuk membuang awalan `https://doi.org/`.
  const doi = apakahDoi(normDoi(t) ?? '') ? normDoi(t) : null;
  if (doi) {
    try {
      return await openalexJson(`/works/doi:${encodeURI(doi)}`, {}, email);
    } catch (e) {
      // 404 OpenAlex berbentuk halaman HTML, bukan JSON — pesannya harus
      // diterjemahkan, kalau tidak pemakainya melihat "<!doctype html>".
      if (e.status === 404) throw new Error(`DOI ${doi} tidak ditemukan di OpenAlex — coba berikan judulnya, atau periksa DOI-nya`);
      throw e;
    }
  }

  const j = await openalexJson('/works', { search: t, 'per-page': 1 }, email);
  const w = j?.results?.[0];
  if (!w) throw new Error(`tidak ada karya OpenAlex yang cocok dengan "${potong(t, 80)}"`);
  return w;
}

/**
 * Kolom OpenAlex yang dibutuhkan peta sitasi. `referenced_works` WAJIB ada —
 * itulah bahan perhitungan coupling — dan `select` menjaga balasannya tetap
 * kecil (terukur 2 Okt 2026: ~52 kB untuk 50 karya lengkap dengan daftar
 * rujukannya, versus ratusan kB tanpa `select`).
 */
const KOLOM_PETA = 'id,doi,title,publication_year,cited_by_count,referenced_works';

/**
 * Kandidat untuk PETA SITASI (issue upstream #122) — karya yang mengutip benih,
 * atau rujukan benih — LENGKAP dengan `referenced_works`-nya.
 *
 * Mengembalikan karya MENTAH, bukan bentuk paper seragam: peta memerlukan daftar
 * rujukan tiap karya, dan bentuk seragam sengaja tidak menyimpannya.
 *
 * Pagar biaya yang disengaja: maksimal 50 kandidat dan maksimal SATU permintaan
 * daftar (karya-karya itu diambil sekaligus lewat `filter=openalex_id:W1|W2|…`,
 * bukan satu per satu).
 */
export async function kandidatPeta(work, { arah = 'pengutip', max = 40, email } = {}) {
  const id = idKarya(work);
  if (!id) throw new Error('karya ini tidak punya id OpenAlex — peta sitasi tidak bisa dijalankan');
  const batas = Math.min(Math.max(Number(max) || 40, 2), 50);

  if (arah === 'rujukan') {
    const semua = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
    const ids = semua.slice(0, batas).map((x) => String(x).split('/').pop()).filter(Boolean);
    if (ids.length === 0) return { works: [], total: semua.length, diperiksa: 0, permintaan: 0 };
    const j = await openalexJson('/works', { filter: `openalex_id:${ids.join('|')}`, 'per-page': ids.length, select: KOLOM_PETA }, email);
    return { works: j?.results ?? [], total: semua.length, diperiksa: ids.length, permintaan: 1 };
  }

  const j = await openalexJson('/works', { filter: `cites:${id}`, sort: 'cited_by_count:desc', 'per-page': batas, select: KOLOM_PETA }, email);
  return { works: j?.results ?? [], total: Number(j?.meta?.count ?? 0), diperiksa: batas, permintaan: 1 };
}

/**
 * Karya berdasarkan daftar id OpenAlex — dipakai untuk memberi JUDUL pada
 * rujukan bersama (yang di peta hanya muncul sebagai id). Satu permintaan,
 * maksimal 50 id.
 */
export async function karyaDariIds(ids, { email } = {}) {
  const bersih = [...new Set((ids ?? []).map((x) => String(x).split('/').pop()).filter(Boolean))].slice(0, 50);
  if (bersih.length === 0) return [];
  const j = await openalexJson('/works', { filter: `openalex_id:${bersih.join('|')}`, 'per-page': bersih.length, select: KOLOM_PETA }, email);
  return j?.results ?? [];
}

/** Karya yang MENGUTIP sebuah karya — snowballing maju. */
export async function karyaMengutip(work, { rows = 10, urutkan = 'sitasi', email } = {}) {
  const id = idKarya(work);
  if (!id) throw new Error('karya ini tidak punya id OpenAlex — penelusuran sitasi tidak bisa dijalankan');
  const sort = urutkan === 'terbaru' ? 'publication_date:desc' : 'cited_by_count:desc';
  const j = await openalexJson('/works', { filter: `cites:${id}`, sort, 'per-page': rows }, email);
  const total = Number(j?.meta?.count ?? 0);
  return {
    total,
    diperiksa: total,
    papers: (j?.results ?? []).map((w) => dariKaryaOpenAlex(w)).filter((p) => p.title),
  };
}

/**
 * Karya yang DIKUTIP oleh sebuah karya — daftar rujukannya (snowballing mundur).
 *
 * DUA BATAS YANG HARUS DILAPORKAN APA ADANYA, bukan disembunyikan:
 *   1. rujukan diambil maksimal `BATAS_RUJUKAN` (100) buah;
 *   2. penyaringan/penyortiran dilakukan SETELAH pengambilan, jadi "terbanyak
 *      dikutip" hanya berlaku di antara yang diperiksa.
 */
export async function karyaDikutip(work, { rows = 10, urutkan = 'sitasi', email } = {}) {
  const semua = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
  const diambil = semua.slice(0, BATAS_RUJUKAN).map((x) => String(x).split('/').pop()).filter(Boolean);
  if (diambil.length === 0) return { total: semua.length, diperiksa: 0, papers: [] };

  const kumpulan = [];
  for (let i = 0; i < diambil.length; i += 50) {
    const j = await openalexJson('/works', {
      filter: `openalex_id:${diambil.slice(i, i + 50).join('|')}`,
      'per-page': 50,
    }, email);
    kumpulan.push(...(j?.results ?? []));
  }

  const papers = kumpulan
    .map((w) => dariKaryaOpenAlex(w))
    .filter((p) => p.title)
    .sort((a, b) => (urutkan === 'terbaru'
      ? (b.year ?? 0) - (a.year ?? 0)
      : (b.citedBy ?? -1) - (a.citedBy ?? -1)));

  return { total: semua.length, diperiksa: diambil.length, papers: papers.slice(0, rows) };
}

/**
 * Salinan akses-terbuka sebuah karya. Murni (tanpa jaringan) supaya bisa diuji
 * tanpa memanggil API.
 *
 * Medan lokasi OpenAlex terukur: `is_oa, pdf_url, landing_page_url, license,
 * version, source.display_name` — lokasi duplikat dibuang berdasarkan URL.
 */
export function ringkasOA(work) {
  const oa = work?.open_access ?? {};
  const lokasi = [];
  const terlihat = new Set();
  for (const l of work?.locations ?? []) {
    if (!l?.is_oa) continue;
    const url = l.pdf_url || l.landing_page_url;
    if (!url || terlihat.has(url)) continue;
    terlihat.add(url);
    lokasi.push({
      pdf: l.pdf_url ?? null,
      landing: l.landing_page_url ?? null,
      license: l.license ?? null,
      version: l.version ?? null,
      sumber: l.source?.display_name ?? null,
    });
    if (lokasi.length >= 10) break;
  }
  return { isOa: !!oa.is_oa, status: oa.oa_status ?? null, oaUrl: oa.oa_url ?? null, lokasi };
}

// ── Cadangan arXiv (PR upstream #124) ────────────────────────────────────────
//
// PR #124 menambahkan arXiv ke rantai cadangan repositori OA: salinan arXiv
// sering menjadi versi gratis satu-satunya untuk paper ber-DOI yang tidak OA.
//
// YANG DIUKUR 29 Sep 2026, dan bentuknya menentukan kode di bawah:
//   - OpenAlex **tidak** menyimpan id arXiv (`ids` hanya openalex/doi/mag), jadi
//     id-nya harus diturunkan dari DOI `10.48550/arXiv.<id>` atau dari URL lokasi;
//   - kalau tidak ada, versi arXiv dicari **berdasarkan JUDUL** — dan di situ
//     bahayanya: penyaring longgar menerima paper yang BERBEDA. Terukur dengan
//     aturan "memuat" (contains): judul *"Attention Is All You Need"* menerima
//     juga *"Not All Attention Is All You Need"* dan *"Element-wise Attention Is
//     All You Need"*. Karena itu `kemiripanJudul()` di bawah **ketat**: sama
//     persis setelah normalisasi, atau memuat dengan rasio panjang >= 0,92.

function normJudul(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 1 = judul sama persis setelah normalisasi · 0,95 = memuat tapi hampir sepanjang · 0 = tidak mirip. */
export function kemiripanJudul(a, b) {
  const x = normJudul(a);
  const y = normJudul(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const pendek = x.length <= y.length ? x : y;
  const panjang = x.length <= y.length ? y : x;
  if (pendek.length >= 20 && panjang.includes(pendek) && pendek.length / panjang.length >= 0.92) return 0.95;
  return 0;
}

/** Ambang penerimaan padanan arXiv. Ketat dengan sengaja — lihat catatan di atas. */
export const AMBANG_JUDUL_ARXIV = 0.9;

/**
 * Metadata satu karya arXiv dari ID-nya (`1706.03762` atau `1706.03762v7`).
 * Dipakai saat pengguna langsung memberi id arXiv — tanpa ini judulnya tidak
 * diketahui dan laporannya hanya berbunyi "arXiv:1706.03762".
 */
export async function karyaArxiv(id) {
  const bersih = String(id ?? '').trim();
  if (!bersih) return null;
  await arxivTunggu();
  try {
    const xml = await getText(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bersih)}&max_results=1`,
      { accept: 'application/atom+xml' },
    );
    return uraikanArxiv(xml, 1)[0] ?? null;
  } finally {
    arxivTerakhir = Date.now();
  }
}

/** Apakah masukan berbentuk id arXiv (`1706.03762`, `arXiv:1706.03762v2`)? */
export function apakahArxivId(t) {
  const m = /^(?:arxiv[:/\s]*)?(\d{4}\.\d{4,5})(v\d+)?$/i.exec(String(t ?? '').trim());
  return m ? { id: m[1] + (m[2] ?? '') } : null;
}
/** Id arXiv dari sebuah URL arxiv.org (abs atau pdf). */
export function idArxivDariUrl(url) {
  const m = /arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/** Id arXiv yang SUDAH tercantum di karya OpenAlex — tanpa perlu mencari. */
export function idArxivDariKarya(work) {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(normDoi(work?.doi) ?? '');
  if (m) return m[1];
  for (const l of work?.locations ?? []) {
    const id = idArxivDariUrl(l?.pdf_url) ?? idArxivDariUrl(l?.landing_page_url);
    if (id) return id;
  }
  return null;
}

/**
 * Cari padanan arXiv dari JUDUL. `null` = tidak ada yang cukup mirip.
 * Sengaja memakai pemacu laju arXiv yang sama dengan pencarian biasa
 * (TOU mereka: 1 permintaan / 3 detik).
 */
export async function padananArxiv(judul, { rows = 5 } = {}) {
  const t = String(judul ?? '').trim();
  if (t.length < 8) return null;
  await arxivTunggu();
  let hasil;
  try {
    hasil = await ambilArxiv(`ti:"${t}"`, rows);
  } finally {
    arxivTerakhir = Date.now();
  }
  for (const p of hasil) {
    const skor = kemiripanJudul(t, p.title);
    if (skor < AMBANG_JUDUL_ARXIV) continue;
    const id = idArxivDariUrl(p.url);
    if (id) return { id, judul: p.title, tahun: p.year, skor, persis: skor === 1 };
  }
  return null;
}

async function doaj(query, { rows }) {
  // Query DOAJ ada di PATH, bukan query string.
  const j = await getJson(`https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${rows}`);
  return (j?.results ?? []).map((r) => {
    const b = r.bibjson ?? {};
    return buatPaper({
      title: b.title,
      authors: daftarPenulis(b.author),
      year: b.year,
      source: 'doaj',
      doi: (b.identifier ?? []).find((x) => x.type === 'doi')?.id,
      url: (b.link ?? []).find((x) => x.type === 'fulltext')?.url,
      journal: b.journal?.title,
      abstract: b.abstract,
      openAccess: true,
    });
  }).filter((p) => p.title);
}

async function europepmc(query, { rows, jenis = null }) {
  // Push-down pra-cetak: Europe PMC menandai pra-cetak dengan `SRC:PPR`.
  // Terukur 1 Okt 2026 — "digital literacy AND SRC:PPR" → 2.775 hasil;
  // "digital literacy AND NOT SRC:PPR" → 85.096. Penambahan ini HANYA terjadi
  // saat pra-cetak memang diminta lewat `jenis`; tidak ada logika "NOT" yang
  // bisa membuang hasil diam-diam.
  const tambahan = (jenis ?? []).includes('preprint') ? ' AND SRC:PPR' : '';
  const u = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query + tambahan)}&format=json&pageSize=${rows}`;
  const j = await getJson(u);
  return (j?.resultList?.result ?? []).map((r) => buatPaper({
    title: r.title,
    // DOAJ memberi `authorString` yang MEMANG dipisah koma ("A, B, C"), jadi
    // pemecahan dilakukan di sini dulu — `daftarPenulis` sendiri sengaja tidak
    // memecah koma, supaya "TAN, Kwan Hong" (satu penulis) tidak rusak.
    authors: daftarPenulis((r.authorString ?? '').split(/,\s*/)),
    year: r.pubYear,
    source: 'europepmc',
    doi: r.doi,
    url: r.doi ? `https://doi.org/${r.doi}` : `https://europepmc.org/article/${r.source ?? 'MED'}/${r.id}`,
    journal: r.journalTitle,
    abstract: r.abstractText,
    openAccess: r.isOpenAccess === 'Y',
  })).filter((p) => p.title);
}

async function pubmed(query, { rows }) {
  // E-utilities butuh DUA panggilan: esearch (id) lalu esummary (metadata).
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const s = await getJson(`${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${rows}&sort=relevance&term=${encodeURIComponent(query)}`);
  const ids = s?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const d = await getJson(`${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`);
  return ids.map((id) => {
    const r = d?.result?.[id];
    if (!r) return null;
    return buatPaper({
      title: r.title,
      authors: daftarPenulis(r.authors),
      year: String(r.pubdate ?? '').slice(0, 4),
      source: 'pubmed',
      doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      journal: r.fulljournalname || r.source,
    });
  }).filter((p) => p && p.title);
}

// arXiv meminta TIDAK LEBIH dari 1 permintaan / 3 detik (TOU mereka). Karena
// sumber dijalankan paralel, permintaan arXiv diserialkan sendiri di sini.
let arxivTerakhir = 0;
async function arxivTunggu() {
  const jeda = 3000 - (Date.now() - arxivTerakhir);
  if (jeda > 0) await new Promise((r) => setTimeout(r, jeda));
  arxivTerakhir = Date.now();
}

/** Uraikan Atom feed arXiv menjadi daftar paper. */
function uraikanArxiv(xml, rows) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const blok = m[1];
    const ambil = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(blok);
      return r ? r[1] : null;
    };
    out.push(buatPaper({
      title: ambil('title'),
      authors: [...blok.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((x) => x[1]),
      year: String(ambil('published') ?? '').slice(0, 4),
      source: 'arxiv',
      doi: ambil('arxiv:doi'),
      url: ambil('id'),
      journal: 'arXiv (preprint)',
      abstract: ambil('summary'),
      openAccess: true,
    }));
  }
  return out.filter((p) => p.title).slice(0, rows);
}

/**
 * Ambil Atom feed arXiv, dengan DUA perbaikan yang diambil dari issue upstream:
 *
 * 1. **HTTP 406 kadang masih membawa feed yang SAH** (issue #121). Dilaporkan
 *    terukur: 406 dengan body 5250 byte ber-`Content-Type: application/atom+xml`
 *    berisi 2 entri. Jadi 406 tidak langsung digagalkan — isinya dicoba dibaca
 *    dulu. Kalau body-nya benar-benar kosong, barulah itu kegagalan sungguhan.
 * 2. **Kueri multi-kata tanpa kutip bisa MENGGANTUNG** di backend arXiv
 *    (issue #101). Karena itu bentuk presisi dipakai lebih dulu (lihat `arxiv`).
 */
async function ambilArxiv(kueri, rows) {
  const u = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(kueri)}&max_results=${rows}&sortBy=relevance`;
  try {
    return uraikanArxiv(await getText(u, { accept: 'application/atom+xml' }), rows);
  } catch (e) {
    if (e.status === 406 && /<entry>/.test(e.bodyPenuh ?? '')) return uraikanArxiv(e.bodyPenuh, rows);
    throw e;
  }
}

/**
 * Bentuk kueri arXiv. Presisi dulu (`all:kata1 AND all:kata2`), longgar
 * (`all:kata1 kata2`) sebagai cadangan.
 *
 * Kenapa TIDAK sekadar meniru perbaikan upstream yang mengutip frasa:
 * **diukur 28 Sep 2026** — untuk kueri Indonesia `"literasi digital"`, bentuk
 * terkutip dan bentuk AND sama-sama memberi **0 hasil**, sedangkan bentuk
 * longgar memberi **50**. arXiv memang korpus berbahasa Inggris. Mengutip buta
 * akan menghapus SELURUH hasil untuk topik non-Inggris, jadi yang dipakai adalah
 * presisi-dengan-cadangan, bukan kutip-membabi-buta.
 */
export function kueriArxiv(query, presisi) {
  const kata = String(query).trim().split(/\s+/).filter(Boolean);
  if (kata.length === 0) return `all:${query}`;
  if (kata.length === 1) return `all:${kata[0]}`;
  return presisi ? kata.map((k) => `all:${k}`).join(' AND ') : `all:${kata.join(' ')}`;
}

async function arxiv(query, { rows }) {
  await arxivTunggu();
  let hasil;
  try {
    hasil = await ambilArxiv(kueriArxiv(query, true), rows);
  } finally {
    arxivTerakhir = Date.now();
  }
  if (hasil.length > 0) return hasil;

  // Cadangan longgar. Hanya dijalankan kalau bentuk presisi benar-benar kosong,
  // supaya permintaan arXiv tetap hemat (TOU mereka: 1 permintaan / 3 detik).
  await arxivTunggu();
  try {
    return await ambilArxiv(kueriArxiv(query, false), rows);
  } finally {
    arxivTerakhir = Date.now();
  }
}

async function semantic(query, { rows, apiKey }) {
  const u = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${rows}&fields=title,year,authors,externalIds,venue,abstract,openAccessPdf`;
  const j = await getJson(u, apiKey ? { headers: { 'x-api-key': apiKey } } : {});
  return (j?.data ?? []).map((d) => buatPaper({
    title: d.title,
    authors: daftarPenulis(d.authors),
    year: d.year,
    source: 'semantic',
    doi: d.externalIds?.DOI,
    url: d.openAccessPdf?.url || (d.externalIds?.DOI ? `https://doi.org/${d.externalIds.DOI}` : null),
    journal: d.venue,
    abstract: d.abstract,
    openAccess: !!d.openAccessPdf,
  })).filter((p) => p.title);
}

/** Beberapa API mengembalikan medan yang bisa berupa nilai tunggal ATAU array. */
function pertama(x) {
  return Array.isArray(x) ? x[0] : x;
}

async function pmc(query, { rows }) {
  // PubMed Central memakai E-utilities yang sama dengan PubMed:
  // esearch (id) lalu esummary (metadata).
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const s = await getJson(`${base}/esearch.fcgi?db=pmc&retmode=json&retmax=${rows}&sort=relevance&term=${encodeURIComponent(query)}`);
  const ids = s?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const d = await getJson(`${base}/esummary.fcgi?db=pmc&retmode=json&id=${ids.join(',')}`);
  return ids.map((id) => {
    const r = d?.result?.[id];
    if (!r) return null;
    const pmcid = (r.articleids ?? []).find((a) => a.idtype === 'pmcid')?.value ?? `PMC${id}`;
    return buatPaper({
      title: r.title,
      authors: daftarPenulis(r.authors),
      year: String(r.pubdate ?? '').slice(0, 4),
      source: 'pmc',
      doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
      url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
      journal: r.fulljournalname || r.source,
      openAccess: true,
    });
  }).filter((p) => p && p.title);
}

async function core(query, { rows, coreApiKey }) {
  // CORE TIDAK bisa dipakai tanpa kunci: terukur 28 Sep 2026, permintaan tanpa
  // `Bearer` dijawab HTTP 429 dengan body KOSONG — bukan 401. Karena itu kunci
  // yang hilang dilaporkan sebagai pesan yang bisa ditindaklanjuti, bukan
  // dibiarkan menjadi 429 yang membingungkan.
  if (!coreApiKey) {
    throw new Error('butuh CORE_API_KEY — tanpa kunci CORE menjawab HTTP 429 dengan body kosong');
  }
  const j = await getJson(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${rows}`, {
    headers: { Authorization: `Bearer ${coreApiKey}` },
  });
  return (j?.results ?? []).map((c) => buatPaper({
    title: c.title,
    authors: daftarPenulis(c.authors),
    year: c.yearPublished,
    source: 'core',
    doi: c.doi,
    url: c.downloadUrl || (c.doi ? `https://doi.org/${c.doi}` : null),
    journal: c.publisher,
    abstract: c.abstract,
    openAccess: !!c.downloadUrl,
  })).filter((p) => p.title);
}

async function zenodo(query, { rows }) {
  const j = await getJson(`https://zenodo.org/api/records?q=${encodeURIComponent(query)}&size=${rows}`);
  return (j?.hits?.hits ?? []).map((z) => buatPaper({
    title: z.metadata?.title,
    authors: daftarPenulis(z.metadata?.creators),
    year: String(z.metadata?.publication_date ?? '').slice(0, 4),
    source: 'zenodo',
    doi: z.metadata?.doi ?? z.doi,
    url: z.links?.self_html ?? z.links?.self,
    journal: z.metadata?.imprint?.publisher ?? 'Zenodo',
    abstract: z.metadata?.description,
    openAccess: true,
  })).filter((p) => p.title);
}

async function hal(query, { rows }) {
  const fl = 'title_s,authFullName_s,producedDateY_i,doiId_s,uri_s,journalTitle_s,abstract_s';
  const j = await getJson(`https://api.archives-ouvertes.fr/search/?q=${encodeURIComponent(query)}&wt=json&rows=${rows}&fl=${fl}`);
  return (j?.response?.docs ?? []).map((a) => buatPaper({
    title: pertama(a.title_s),
    authors: daftarPenulis(a.authFullName_s),
    year: a.producedDateY_i,
    source: 'hal',
    doi: pertama(a.doiId_s),
    url: pertama(a.uri_s),
    journal: pertama(a.journalTitle_s),
    abstract: pertama(a.abstract_s),
    openAccess: true,
  })).filter((p) => p.title);
}

/** IACR Cryptology ePrint Archive — arsip pra-cetak kriptologi (HTML). */
async function iacr(query, { rows }) {
  const html = await getText(`https://eprint.iacr.org/search?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const tautan = [...html.matchAll(/<a title="(\d{4}\/\d+)" class="paperlink" href="\/(\d{4}\/\d+)"/g)];
  if (tautan.length === 0) {
    if (!/class="paperlink"/.test(html)) throw new Error('markup IACR berubah: tautan ber-class "paperlink" tidak ditemukan lagi');
    return [];
  }
  const out = [];
  for (let i = 0; i < tautan.length && out.length < rows; i++) {
    // Potong per hasil memakai posisi tautan berikutnya sebagai batas, supaya
    // regex tidak menyeberang ke hasil lain.
    const blok = html.slice(tautan[i].index, i + 1 < tautan.length ? tautan[i + 1].index : html.length);
    const ambil = (re) => { const m = re.exec(blok); return m ? m[1] : null; };
    const id = tautan[i][1];
    out.push(buatPaper({
      title: ambil(/<strong>([\s\S]*?)<\/strong>/),
      authors: daftarPenulis((ambil(/<span class="fst-italic">([\s\S]*?)<\/span>/) ?? '').split(/,\s*/)),
      year: id.slice(0, 4),
      source: 'iacr',
      url: `https://eprint.iacr.org/${id}`,
      journal: 'IACR Cryptology ePrint Archive',
      abstract: ambil(/<p class="mb-0 mt-1 search-abstract">([\s\S]*?)<\/p>/),
      openAccess: true,
    }));
  }
  return out.filter((p) => p.title);
}

/**
 * Unpaywall — pencari akses-terbuka **berdasarkan DOI**, BUKAN pencari kata
 * kunci. Diverifikasi 28 Sep 2026: dengan DOI ia menjawab HTTP 200 dan
 * menemukan papernya; dengan kata kunci ia memang mengembalikan 0.
 *
 * Query yang bukan DOI dikembalikan KOSONG TANPA error — itu bukan kegagalan,
 * itu memang cara kerjanya. Kalau ini dilempar sebagai error, setiap pencarian
 * kata kunci akan menulis baris GAGAL palsu.
 */
async function unpaywall(query, { rows, email }) {
  const doi = normDoi(query);
  if (!doi) return [];
  if (!email) throw new Error('butuh UNPAYWALL_EMAIL — Unpaywall menolak permintaan tanpa email');
  const j = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`);
  if (!j?.title) return [];
  const oa = j.best_oa_location ?? null;
  const hasil = buatPaper({
    title: j.title,
    authors: daftarPenulis(j.z_authors),
    year: j.year,
    source: 'unpaywall',
    doi: j.doi ?? doi,
    url: oa?.url_for_pdf ?? oa?.url ?? (j.doi ? `https://doi.org/${j.doi}` : null),
    journal: j.journal_name,
    openAccess: !!j.is_oa,
  });
  return hasil.title ? [hasil].slice(0, Math.max(1, Math.min(rows, 1))) : [];
}

// ── Sumber INDONESIA (penguraian HTML) ───────────────────────────────────────
//
// Pola di bawah DIUKUR langsung dari halaman hidupnya (28 Sep 2026), bukan
// ditebak. Kalau operator mengubah markup, sumbernya akan melaporkan 0 hasil —
// dan itu akan terlihat, bukan tersamar, karena kita pisahkan `error` dari
// `papers` (lihat `searchSource`).

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function ambilHtml(html, pola, batas) {
  const out = [];
  for (const m of html.matchAll(pola)) {
    if (out.length >= batas) break;
    out.push(m);
  }
  return out;
}

/**
 * Saat penanda hasil tidak ditemukan, ada TIGA kemungkinan yang BERBEDA:
 *   1. portal menjawab "nol hasil"  -> `[]`, itu hasil yang SAH
 *   2. markup portal berubah        -> error
 *   3. portal memblokir/mengalihkan -> error
 *
 * Sebelum ini (1) dan (2) diperlakukan sama, sehingga portal yang benar-benar
 * kosong dilaporkan sebagai **GAGAL**. Itu keliru dengan arah berlawanan:
 * melaporkan kegagalan padahal hasilnya sah-sah saja kosong — sama
 * menyesatkannya dengan menyembunyikan kegagalan.
 *
 * Penanda nol-hasil diukur 28 Sep 2026 memakai kueri omong kosong, lalu
 * dibandingkan dengan kueri yang ada hasilnya:
 *
 *   Garuda : "Found 0 documents"                (halaman 11.181 huruf)
 *   Sinta  : header `Results for "<q>"` tetap ada, tautan profil nol
 *            (halaman 34.063 huruf) — Sinta TIDAK menulis pesan kosong
 *   IOS    : "No Results!"                      (halaman 23.041 huruf)
 */
function portalNolHasil(html, ...penanda) {
  return penanda.some((re) => re.test(html));
}

const GARUDA_BASE = 'https://garuda.kemdiktisaintek.go.id';

/** Garuda — indeks artikel jurnal Indonesia (Kemdiktisaintek). */
async function garuda(query, { rows }) {
  const html = await getText(`${GARUDA_BASE}/documents?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const pola = /<a[^>]*class="title-article"[^>]*href="\/documents\/detail\/(\d+)"[^>]*>\s*<xmp>([\s\S]*?)<\/xmp>/g;
  const hasil = ambilHtml(html, pola, rows).map((m) => buatPaper({
    title: m[2],
    source: 'garuda',
    url: `${GARUDA_BASE}/documents/detail/${m[1]}`,
    journal: 'Garuda (jurnal Indonesia)',
    openAccess: true,
  })).filter((p) => p.title);
  // Penguraian HTML yang tidak menemukan satu pun pola bisa berarti DUA hal yang
  // berlawanan. Bedakan: Garuda menulis "Found 0 documents" saat memang kosong.
  if (hasil.length === 0 && !/title-article/.test(html)) {
    if (portalNolHasil(html, /Found\s+0\s+document/i)) return [];
    throw new Error('markup Garuda berubah: penanda "title-article" tidak ditemukan lagi');
  }
  return hasil;
}

/** Sinta — daftar JURNAL Indonesia terakreditasi (bukan artikel). */
async function sinta(query, { rows }) {
  const html = await getText(`https://sinta.kemdiktisaintek.go.id/journals?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const pola = /href="https:\/\/sinta\.kemdiktisaintek\.go\.id\/journals\/profile\/(\d+)"[^>]*>([\s\S]{3,220}?)<\/a>/g;
  const hasil = ambilHtml(html, pola, rows).map((m) => buatPaper({
    title: m[2],
    source: 'sinta',
    url: `https://sinta.kemdiktisaintek.go.id/journals/profile/${m[1]}`,
    journal: 'Sinta (jurnal terakreditasi)',
    openAccess: true,
  })).filter((p) => p.title);
  // Sinta TIDAK menulis pesan kosong — ia tetap menampilkan header
  // `Results for "<kueri>"` lalu daftar yang kosong. Jadi header itu yang
  // dipakai sebagai bukti "halaman dimuat, hasilnya memang nol".
  // (Sinta mendaftar JURNAL, bukan artikel, jadi kueri spesifik memang sering nol.)
  if (hasil.length === 0 && !/journals\/profile\//.test(html)) {
    if (portalNolHasil(html, /Results for/i)) return [];
    throw new Error('markup Sinta berubah: tautan "journals/profile" tidak ditemukan lagi');
  }
  return hasil;
}

/** IOS OneSearch — agregator repositori Indonesia (Perpusnas). */
async function ios(query, { rows }) {
  const html = await getText(`https://onesearch.id/Search/Results?lookfor=${encodeURIComponent(query)}&type=AllFields`, { headers: { 'User-Agent': UA_BROWSER } });
  const pola = /<a[^>]*href="\/Record\/([^"]+)"[^>]*class="title"[^>]*>([\s\S]*?)<\/a>/g;
  const hasil = ambilHtml(html, pola, rows).map((m) => buatPaper({
    title: m[2],
    source: 'ios',
    url: `https://onesearch.id/Record/${m[1]}`,
    journal: 'IOS OneSearch (repositori Indonesia)',
    openAccess: true,
  })).filter((p) => p.title);
  if (hasil.length === 0 && !/class="title"/.test(html)) {
    if (portalNolHasil(html, /No Results!/i)) return [];
    throw new Error('markup IOS berubah: tautan hasil ber-class "title" tidak ditemukan lagi');
  }
  return hasil;
}

// ── Registry ─────────────────────────────────────────────────────────────────

// ── Sumber yang lahir dari issue/PR upstream (0.2.0) ─────────────────────────

/** DOI di dalam BibTeX OpenReview — dipakai supaya karya yang SAMA ikut ter-dedup. */
function doiDariBibtex(bib) {
  const m = /doi\s*=\s*[{"]([^}"]+)[}"]/i.exec(String(bib ?? ''));
  return m?.[1]?.trim() ?? null;
}

/**
 * OpenReview (issue upstream #83) — ajang konferensi ML: ICLR, NeurIPS, ICML.
 * **Tanpa kunci API.**
 *
 * Bentuk yang BEKERJA, diukur 1 Okt 2026:
 *   `GET api2.openreview.net/notes/search?term=<q>&content=all&source=forum&limit=N`
 * Endpoint generik `/notes` justru dijawab **HTTP 403 `ChallengeRequiredError`**
 * (verifikasi bot), jadi JANGAN pakai itu; hanya `notes/search` yang lolos
 * tanpa challenge. Kueri `query=` juga ditolak: parameternya bernama `term`.
 *
 * DUA bentuk penulis muncul di lapangan dan keduanya nyata: array STRING
 * (submisi ICLR) dan array objek `{fullname}` (rekaman ORCID/DBLP). `daftarPenulis`
 * menangani keduanya — bentuk `fullname` sempat TIDAK dikenali dan nama penulis
 * hilang diam-diam, lalu diperbaiki bersamaan dengan sumber ini.
 *
 * `pdf` bisa berupa jalur relatif (`/pdf/<hash>.pdf`) atau URL luar (IEEE);
 * yang relatif dilengkapi ke openreview.net. Banyak karya ICLR hanya punya
 * salinan di sini — bukan di Crossref maupun OpenAlex.
 */
async function openreview(query, { rows }) {
  const u = new URL('https://api2.openreview.net/notes/search');
  u.searchParams.set('term', query);
  u.searchParams.set('content', 'all');
  u.searchParams.set('source', 'forum');
  u.searchParams.set('limit', String(rows));
  const j = await getJson(u.toString());
  return (j?.notes ?? [])
    .map((n) => {
      const c = n.content ?? {};
      const nilai = (k) => (c[k] && typeof c[k] === 'object' ? c[k].value : c[k]);
      const pdf = nilai('pdf');
      const tautanPdf = typeof pdf === 'string' && pdf.startsWith('/') ? `https://openreview.net${pdf}` : (pdf ?? null);
      const undangan = JSON.stringify(n.invitations ?? n.invitation ?? '');
      const pdate = Number(nilai('pdate') ?? nilai('cdate') ?? n.pdate ?? n.cdate);
      const judul = nilai('title');
      const venue = nilai('venue') ?? nilai('venueid');
      return buatPaper({
        title: judul,
        authors: daftarPenulis(nilai('authors') ?? nilai('authorids')),
        year: Number.isFinite(pdate) && pdate > 0 ? new Date(pdate).getUTCFullYear() : null,
        source: 'openreview',
        doi: doiDariBibtex(nilai('_bibtex')),
        url: tautanPdf ?? `https://openreview.net/forum?id=${encodeURIComponent(n.forum ?? n.id ?? '')}`,
        // Di rekaman ORCID/DBLP, medan `venue` kadang berisi JUDULNYA SENDIRI
        // (terukur 1 Okt 2026). Menampilkannya akan mengulang judul di baris
        // venue — jadi diperlakukan sebagai "tidak dilaporkan".
        journal: bersihTeks(venue) && bersihTeks(venue) !== bersihTeks(judul) ? venue : null,
        abstract: nilai('abstract'),
        // Penanda jenis diambil dari fakta yang API-nya laporkan, bukan tebakan:
        // catatan yang masuk lewat jalur "…/-/Submission" adalah makalah konferensi.
        type: /\/-\/Submission/i.test(undangan) ? 'article' : null,
      });
    })
    .filter((p) => p.title);
}

/**
 * SSRN (PR upstream #60) — **lewat OpenAlex**, bukan dengan mengikis situsnya.
 *
 * Mengapa tidak mengikis: `ssrn.com` menolak permintaan biasa (**HTTP 403**),
 * sebab itu SSRN dulu masuk daftar "sengaja tidak dipakai". Tetapi seluruh
 * karya SSRN terindeks OpenAlex sebagai SATU sumber — `S4210172589`,
 * "SSRN Electronic Journal", **1.656.021 karya** — jadi bisa dicari dengan
 * filter biasa, tanpa satu pun halaman SSRN diambil.
 *
 * Terukur 1 Okt 2026: `search=digital literacy` + filter sumber itu menjawab
 * **3.836 karya**; contoh hasil nyata ikut muncul di halaman pertama.
 *
 * Nilainya untuk ekonomi/hukum/bisnis: banyak pra-cetak SSRN tidak ada di
 * Crossref, jadi mereka tidak akan pernah muncul lewat sumber lain.
 */
const SSRN_OPENALEX_ID = 'S4210172589';

/**
 * Sumber yang isinya adalah SATU repositori OpenAlex — jalur yang sama untuk
 * SSRN (0.2.0), bioRxiv, dan medRxiv (0.3.0).
 *
 * Mengapa begini: ketiganya menuntut perlakuan khusus kalau ditempuh langsung —
 * ssrn.com menolak permintaan biasa (403), bioRxiv/medRxiv tidak punya
 * pencarian kata kunci sama sekali (hanya rentang tanggal/kategori) — sedangkan
 * seluruh isi ketiganya sudah terindeks OpenAlex sebagai satu sumber. Jadi kita
 * memakai API yang SUDAH kita pakai: tanpa pengikis baru, tanpa kunci, dan
 * push-down `min_sitasi`/`jenis` ikut bekerja gratis.
 *
 * Terukur 1 Okt 2026: bioRxiv `S4306402567` 345.976 karya ("digital literacy"
 * 159; + jenis preprint & sitasi>4 → 141) · medRxiv `S3005729997` 87.941 karya
 * ("digital literacy" 1.352) · SSRN 1.656.021 karya.
 */
async function openalexRepositori(query, { rows, email, minSitasi = null, jenis = null }, idSumber, source) {
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', query);
  u.searchParams.set('per-page', String(rows));
  const filter = [`primary_location.source.id:${idSumber}`];
  if (Number.isFinite(minSitasi) && minSitasi > 0) filter.push(`cited_by_count:>${Math.max(0, Math.floor(minSitasi) - 1)}`);
  const t = (jenis ?? []).filter((j) => ['article', 'review', 'preprint'].includes(j));
  if (t.length) filter.push(`type:${t.join('|')}`);
  u.searchParams.set('filter', filter.join(','));
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((w) => dariKaryaOpenAlex(w, source)).filter((p) => p.title);
}

const ssrn = (query, opsi) => openalexRepositori(query, opsi, SSRN_OPENALEX_ID, 'ssrn');
const biorxiv = (query, opsi) => openalexRepositori(query, opsi, 'S4306402567', 'biorxiv');
const medrxiv = (query, opsi) => openalexRepositori(query, opsi, 'S3005729997', 'medrxiv');

/**
 * ChemRxiv (0.3.1) — pra-cetak kimia, juga lewat OpenAlex.
 *
 * Sumber OpenAlex `S4393918830` memuat **64.495** karya; "catalysis" memberi
 * **13.594** hasil nyata (diukur 2 Okt 2026).
 *
 * MENGAPA BUKAN SITUSNYA: chemrxiv.org membalas **HTTP 403** dengan halaman
 * Cloudflare ("Just a moment...") — diukur 2 Okt 2026, baik untuk halaman
 * pencariannya maupun gateway API-nya. Modul upstream mengambil HTML dari sana,
 * jadi jalur itu akan diblokir; jalur OpenAlex ini tidak.
 */
const chemrxiv = (query, opsi) => openalexRepositori(query, opsi, 'S4393918830', 'chemrxiv');

/**
 * IEEE — lewat Crossref, **tanpa kunci API**: trik yang sama dengan ACM (#123).
 *
 * Diukur 1 Okt 2026: `filter=member:263` menjawab **136.771** karya; dengan
 * `type:proceedings-article` **106.734**; setiap hasil ber-DOI `10.1109/…`.
 * Upstream (PR #138) tetap membuat IEEE butuh kunci — jalur ini tidak.
 *
 * BATAS YANG SENGAJA TIDAK DIKLAIM: Crossref **tidak** membawa abstrak IEEE
 * (terukur 0 dari 5 rekaman). Medan sitasinya ADA (5 dari 5). Jadi abstrak
 * biasanya kosong — lebih baik jujur daripada mengarang. Kalau abstraknya
 * dibutuhkan, ambil lewat `paper({ mode: 'search' })` dengan sumber `openalex`
 * memakai DOI-nya.
 */
async function ieee(query, { rows, email, jenis = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  const saringJenis = saringKrossref(jenis);
  u.searchParams.set('filter', `member:263${saringJenis ? `,${saringJenis}` : ''}`);
  u.searchParams.set('select', KOLOM_CROSSREF);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => dariItemCrossref(it, 'ieee')).filter((p) => p.title);
}

export const SUMBER = [
  // Internasional
  { id: 'crossref', label: 'Crossref', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: crossref },
  { id: 'acm', label: 'ACM DL', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: acm, catatan: 'ACM Digital Library lewat Crossref (prefix DOI 10.1145) — tanpa kunci (PR upstream #123)' },
  { id: 'openalex', label: 'OpenAlex', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: openalex },
  { id: 'doaj', label: 'DOAJ', region: 'international', kind: 'api', credit: 'opsional', fn: doaj, catatan: 'mencakup jurnal akses-terbuka Indonesia juga' },
  { id: 'europepmc', label: 'Europe PMC', region: 'international', kind: 'api', credit: null, fn: europepmc },
  { id: 'pubmed', label: 'PubMed', region: 'international', kind: 'api', credit: null, fn: pubmed, catatan: 'dua panggilan per pencarian (esearch + esummary)' },
  { id: 'arxiv', label: 'arXiv', region: 'international', kind: 'api', credit: null, fn: arxiv, catatan: 'preprint; dibatasi sendiri 1 permintaan / 3 detik' },
  { id: 'semantic', label: 'Semantic Scholar', region: 'international', kind: 'api', credit: 'menaikkan batas laju', fn: semantic },
  { id: 'pmc', label: 'PubMed Central', region: 'international', kind: 'api', credit: null, fn: pmc, catatan: 'teks penuh akses-terbuka; dua panggilan per pencarian' },
  { id: 'core', label: 'CORE', region: 'international', kind: 'api', credit: 'WAJIB — tanpa kunci balas 429', fn: core, catatan: 'agregator repositori akses-terbuka' },
  { id: 'zenodo', label: 'Zenodo', region: 'international', kind: 'api', credit: null, fn: zenodo, catatan: 'repositori umum: data, perangkat lunak, preprint' },
  { id: 'hal', label: 'HAL', region: 'international', kind: 'api', credit: null, fn: hal, catatan: 'repositori akses-terbuka Prancis' },
  { id: 'iacr', label: 'IACR ePrint', region: 'international', kind: 'html', credit: null, fn: iacr, catatan: 'arsip pra-cetak kriptologi' },
  { id: 'openreview', label: 'OpenReview', region: 'international', kind: 'api', credit: null, fn: openreview, catatan: 'konferensi ML (ICLR/NeurIPS/ICML) — tanpa kunci (issue upstream #83)' },
  { id: 'ssrn', label: 'SSRN', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: ssrn, catatan: 'lewat OpenAlex, bukan mengikis situsnya yang menolak 403 (PR upstream #60)' },
  { id: 'ieee', label: 'IEEE', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: ieee, catatan: 'lewat Crossref member:263 — TANPA kunci API; Crossref tidak membawa abstrak IEEE' },
  { id: 'biorxiv', label: 'bioRxiv', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: biorxiv, catatan: 'pra-cetak biologi — lewat OpenAlex (repositori S4306402567), bukan API tanggal mereka' },
  { id: 'medrxiv', label: 'medRxiv', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: medrxiv, catatan: 'pra-cetak kesehatan — lewat OpenAlex (repositori S3005729997)' },
  { id: 'chemrxiv', label: 'ChemRxiv', region: 'international', kind: 'api', credit: 'disarankan (polite pool)', fn: chemrxiv, catatan: 'pra-cetak kimia — lewat OpenAlex (repositori S4393918830); chemrxiv.org sendiri membalas 403 Cloudflare' },
  { id: 'unpaywall', label: 'Unpaywall', region: 'international', kind: 'api', input: 'doi', credit: 'WAJIB email', fn: unpaywall, catatan: 'butuh DOI — bukan pencari kata kunci' },
  // Indonesia
  { id: 'garuda', label: 'Garuda', region: 'indonesia', kind: 'html', credit: null, fn: garuda, catatan: 'artikel jurnal Indonesia' },
  { id: 'sinta', label: 'Sinta', region: 'indonesia', kind: 'html', credit: null, fn: sinta, catatan: 'daftar JURNAL terakreditasi, bukan artikel' },
  { id: 'ios', label: 'IOS OneSearch', region: 'indonesia', kind: 'html', credit: null, fn: ios, catatan: 'agregator repositori Indonesia' },
];

export const ID_SUMBER = SUMBER.map((s) => s.id);
export const ID_INTERNASIONAL = SUMBER.filter((s) => s.region === 'international').map((s) => s.id);
export const ID_INDONESIA = SUMBER.filter((s) => s.region === 'indonesia').map((s) => s.id);
export const ID_DOI = SUMBER.filter((s) => s.input === 'doi').map((s) => s.id);

/**
 * Apakah query ini berbentuk DOI? Dipakai untuk memutuskan apakah sumber
 * ber-input DOI (unpaywall) ikut dijalankan saat pengguna memilih "all".
 * Tanpa ini, setiap pencarian kata kunci membayar satu permintaan yang pasti
 * kosong — dan menampilkan baris yang tidak menjelaskan apa pun.
 */
export function apakahDoi(q) {
  return /^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(String(q ?? '').trim());
}

export function cariSumber(id) {
  return SUMBER.find((s) => s.id === id) ?? null;
}

/**
 * Jalankan satu sumber. SELALU mengembalikan { id, papers, error, ms } —
 * tidak pernah melempar — supaya satu sumber yang mati tidak membatalkan
 * seluruh pencarian, dan kegagalannya tetap terlihat oleh pemanggil.
 */
export async function searchSource(id, query, opts) {
  const s = cariSumber(id);
  if (!s) return { id, papers: [], error: `sumber tidak dikenal: ${id}`, ms: 0 };
  const mulai = Date.now();
  try {
    const papers = await s.fn(query, opts);
    return { id, papers: Array.isArray(papers) ? papers : [], error: null, ms: Date.now() - mulai };
  } catch (e) {
    const pesan = e?.name === 'AbortError'
      ? 'timeout'
      : `${e?.message ?? 'gagal'}${e?.status ? ` (HTTP ${e.status})` : ''}${e?.body ? ` — ${e.body}` : ''}`;
    return { id, papers: [], error: pesan, ms: Date.now() - mulai };
  }
}

// ── Dedup ────────────────────────────────────────────────────────────────────

const kunciJudul = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);

/**
 * Buang duplikat: DOI lebih dulu, lalu judul yang dinormalkan.
 * `sources` mencatat SEMUA sumber yang menemukan paper itu — supaya pengguna
 * tahu sebuah paper muncul di beberapa basis, bukan disembunyikan.
 */
export function dedup(papers) {
  const peta = new Map();
  for (const p of papers) {
    const kunci = p.doi ? `doi:${p.doi}` : `t:${kunciJudul(p.title)}`;
    const ada = peta.get(kunci);
    if (!ada) {
      peta.set(kunci, { ...p, sources: [p.source] });
      continue;
    }
    if (!ada.sources.includes(p.source)) ada.sources.push(p.source);
    // Lengkapi medan yang kosong dari salinan lain — jangan buang informasinya.
    for (const f of ['abstract', 'journal', 'doi', 'url', 'year']) {
      if (!ada[f] && p[f]) ada[f] = p[f];
    }
    if (!ada.openAccess && p.openAccess) ada.openAccess = true;
    if (p.authors?.length > (ada.authors?.length ?? 0)) ada.authors = p.authors;
    // Jumlah sitasi diambil yang TERBESAR, bukan yang terakhir: satu sumber bisa
    // melaporkannya sementara yang lain tidak (`null`), dan `null` bukan 0.
    if (p.citedBy != null && (ada.citedBy == null || p.citedBy > ada.citedBy)) ada.citedBy = p.citedBy;
  }
  return [...peta.values()];
}
