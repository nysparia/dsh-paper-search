---
name: paper-search
description: "Cari literatur ilmiah dari 20 sumber internasional (Crossref, ACM, IEEE, OpenAlex, DOAJ, PubMed, arXiv, bioRxiv, medRxiv, ChemRxiv, OpenReview, SSRN, dll) dan 3 portal jurnal Indonesia (Garuda, Sinta, IOS). Plus paper_citations (siapa mengutip siapa), paper_oa (salinan gratis), dan paper_fulltext (PDF akses-terbuka -> Markdown, isinya bisa dibaca utuh). Pakai untuk mencari paper, penelitian terdahulu, literatur Indonesia, dan membaca isi paper."
whenToUse: "Saat tugas menyangkut artikel atau karya ilmiah: mencari paper/jurnal/artikel penelitian, mencari penelitian terdahulu, mencari jurnal nasional Indonesia, mencari jurnal internasional, melacak DOI, mencari salinan gratis sebuah paper, menelusuri siapa yang mengutip sebuah paper, atau saat pencarian literatur kosong dan perlu tahu sumber mana yang gagal. Bukan untuk berita, docs, atau riset web umum — itu tugas search-cascade."
---

# Paper Search — literatur internasional + jurnal Indonesia (DSH)

**Lima kemampuan**, semuanya native lewat HTTP — tidak ada CLI atau paket Python
yang perlu dipasang:

| Kemampuan | Padanan satu pintu | Gunanya |
|---|---|---|
| `paper_search` | `paper({ mode: "search" })` | mencari literatur di **23 sumber** sekaligus |
| `paper_status` | `paper({ mode: "status" })` | sumber mana yang benar-benar **hidup sekarang** + konverter mana yang ada |
| `paper_citations` | `paper({ mode: "citations" })` | **graf sitasi** OpenAlex — siapa mengutip, dan mengutip siapa |
| `paper_oa` | `paper({ mode: "oa" })` | **salinan akses-terbuka** sebuah paper (status + tautan PDF) |
| `paper_fulltext` | `paper({ mode: "fulltext" })` | **unduh PDF akses-terbuka → Markdown**, supaya ISI paper bisa dibaca utuh |

> **Bentuk tool-nya tergantung config profil — periksa daftar tool Anda dulu.**
> Bawaan = lima tool terpisah (kolom kiri; plugin ≤ 0.1.7 selalu begini). Kalau
> profil memasang `tools: "one"` (sejak 0.1.8), hanya ada **satu** tool `paper` +
> parameter `mode` — pakai kolom kanan. Di mode itu nama seperti `paper_fulltext`
> **tidak ada**, dan memanggilnya akan ditolak harness.

## Cara pakai

Bentuk **bawaan** (lima tool):

```
paper_search({ query: "machine learning" })                      # semua sumber
paper_search({ query: "pendidikan karakter", sources: "indonesia" })
paper_search({ query: "CRISPR", sources: "pubmed,europepmc,doaj", max_results: 10 })
paper_search({ query: "digital literacy", open_access_only: true, year_from: 2020 })
paper_search({ query: "eye tracking", sources: "acm" })           # hanya ACM
paper_citations({ identifier: "10.1145/3290605.3300233" })                  # siapa mengutip
paper_citations({ identifier: "10.1145/3290605.3300233", arah: "rujukan" }) # mengutip siapa
paper_oa({ identifier: "10.1371/journal.pone.0266789" })                    # ada salinan gratis?
```

Bentuk **satu pintu** (`tools: "one"`) — isinya sama, hanya namanya berbeda:

```
paper({ mode: "search", query: "machine learning" })
paper({ mode: "status", probe: false })
paper({ mode: "citations", identifier: "10.1145/3290605.3300233", arah: "pengutip" })
paper({ mode: "oa", identifier: "10.1371/journal.pone.0266789" })
paper({ mode: "fulltext", identifier: "1706.03762" })
```

Opsi:

| Opsi | Isi |
|---|---|
| `query` | kata kunci (wajib) |
| `sources` | `all` · `international` · `indonesia` · atau id dipisah koma |
| `max_results` | hasil **per sumber** (1-50, bawaan 5) |
| `open_access_only` | hanya paper akses-terbuka |
| `year_from` | hanya tahun >= nilai ini |
| `urutkan` | `relevansi` (bawaan) · `sitasi` (terbanyak dikutip dulu) · `terbaru` — pakai `sitasi` untuk menaikkan karya klasik/fondasional ke atas |
| `min_sitasi` | hanya paper dengan sitasi >= N. Karya dari sumber yang **tidak melaporkan** sitasi ikut **dibuang** (ambangnya tidak bisa diverifikasi) dan jumlahnya disebut di laporan |
| `jenis` | `article` · `review` · `preprint` (boleh dipisah koma) — diteruskan ke OpenAlex & Crossref/ACM, lalu disaring lagi setelah dedup. Karya yang jenisnya tidak dilaporkan sumber **tetap** ditampilkan |

> **Cara memakainya untuk tinjauan pustaka.** Cari dulu dengan `min_sitasi: 50` +
> `urutkan: "sitasi"` untuk menemukan karya yang benar-benar berpengaruh, lalu
> ulangi tanpa saringan untuk menangkap terbitan baru yang belum sempat dikutip.
> Dua pencarian itu menjawab dua pertanyaan berbeda: *apa yang sudah diakui* dan
> *apa yang baru*.

## 23 sumbernya

**Internasional (20)** — API JSON resmi, kecuali IACR yang diurai dari HTML:

| Sumber | Catatan |
|---|---|
| `crossref` | metadata DOI lintas penerbit; terluas |
| `acm` | **ACM Digital Library** — lewat Crossref dengan saringan prefix DOI `10.1145`; **tanpa kunci API** |
| `openalex` | metadata + abstrak; email menaikkan batas laju |
| `doaj` | jurnal akses-terbuka — **termasuk banyak jurnal Indonesia** |
| `europepmc` | biomedis, teks penuh untuk OA |
| `pubmed` | biomedis (dua panggilan: esearch + esummary) |
| `pmc` | PubMed Central — teks penuh akses-terbuka (dua panggilan juga) |
| `arxiv` | preprint; plugin membatasi sendiri 1 permintaan / 3 detik sesuai TOU mereka |
| `semantic` | Semantic Scholar; kunci gratis menaikkan batas laju |
| `core` | agregator repositori akses-terbuka — **wajib kunci** |
| `zenodo` | repositori umum: data, perangkat lunak, preprint |
| `openreview` | **konferensi ML** (ICLR/NeurIPS/ICML) — tanpa kunci; banyak karya di sini tidak ada di Crossref maupun OpenAlex |
| `ssrn` | pra-cetak ekonomi/hukum/bisnis — **lewat OpenAlex**, bukan dengan mengikis situsnya (ssrn.com menolak permintaan biasa dengan 403) |
| `ieee` | **IEEE** — lewat Crossref `member:263`, **tanpa kunci API**. ⚠️ Crossref **tidak** membawa abstrak IEEE, jadi abstraknya biasanya kosong (medan sitasinya ada) |
| `biorxiv` | pra-cetak biologi — lewat OpenAlex (repositori `S4306402567`). API bioRxiv sendiri tidak punya pencarian kata kunci |
| `medrxiv` | pra-cetak kesehatan — lewat OpenAlex (repositori `S3005729997`) |
| `chemrxiv` | pra-cetak **kimia** — lewat OpenAlex (repositori `S4393918830`); chemrxiv.org sendiri membalas 403 Cloudflare |
| `hal` | repositori akses-terbuka Prancis |
| `iacr` | IACR Cryptology ePrint Archive — pra-cetak kriptologi |
| `unpaywall` | **input DOI, bukan kata kunci** — mencari salinan akses-terbuka dari sebuah DOI; **wajib email** |

**Indonesia (3)** — penguraian halaman publik:

| Sumber | Catatan |
|---|---|
| `garuda` | artikel jurnal Indonesia (Kemdiktisaintek) |
| `sinta` | **daftar JURNAL** terakreditasi — bukan artikel |
| `ios` | IOS OneSearch, agregator repositori Indonesia (Perpusnas) |

> **Untuk topik Indonesia, pakai kata kunci BAHASA INDONESIA.** Terukur:
> `"pendidikan karakter"` mengembalikan jurnal Indonesia nyata; padanan
> Inggrisnya mengembalikan hasil internasional yang tidak relevan.

> **Yang SENGAJA tidak didaftarkan, dan alasannya terukur (28 Sep 2026):**
>
> | Sumber | Alasan |
> |---|---|
> | `moraref` | halamannya hanya halaman pendarat, tanpa markup hasil (3.964 huruf) |
> | `dblp` | API-nya di balik proteksi bot — mengembalikan halaman "Making sure you're not a bot!", bukan JSON |
> | `openaire` | permintaan uji **timeout 30 detik dan 40 detik** |
> | `biorxiv` / `medrxiv` | API-nya berbasis RENTANG TANGGAL, bukan kata kunci — tidak bisa dipakai mencari |
> | `base` | menolak: `Access denied for IP address …` — butuh pendaftaran IP institusi |
> | `citeseerx` | HTTP 404, lalu **menggantung** sampai permintaannya dibunuh |
> | `ssrn` | menolak permintaan biasa dengan HTTP 403 |
> | `google_scholar` | deteksi bot aktif; butuh proxy |
>
> Sumber yang selalu kosong lebih buruk daripada sumber yang tidak ada — jadi
> yang gagal dibuang dan **alasannya dicatat**, bukan didaftarkan supaya
> jumlahnya terlihat banyak.
>
> **`unpaywall` TIDAK ada di daftar ini** — ia sempat saya masukkan keliru,
> lalu dikeluarkan setelah diuji ulang: ia **bekerja**, hanya butuh **DOI**.
> "Bukan pencari kata kunci" ≠ "mati".

## ⚠️ ATURAN UTAMA — "0 hasil" dari satu sumber BUKAN "tidak ada literatur"

Tool ini **memisahkan** sumber yang gagal dari yang menjawab. Keluarannya selalu
menampilkan baris per sumber:

```
  v Crossref            3 hasil  (2316 ms)
  x Semantic Scholar    GAGAL — HTTP 429 (HTTP 429) — {"message": "Too Many Requests...
  v Garuda              3 hasil  (1428 ms)
```

**Aturannya:**

1. Sumber bertanda **`x`** artinya GAGAL — bukan kosong. **Sebutkan** itu saat
   melaporkan hasil ke Rasyid. Jangan pernah menulis "tidak ada literatur" dari
   sumber yang gagal.
2. Kalau semua sumber balas 0 → ulangi **sekali** (batas laju sering transien),
   lalu coba `sources` yang lain.
3. Kalau ragu, jalankan **`paper_status`** lebih dulu — ia membuktikan sumber
   mana yang benar-benar hidup **sekarang**, bukan sekadar terdaftar.

## Kalau pencarian kosong atau terasa aneh

```
paper_status()                    # kirim satu permintaan kecil ke tiap sumber
paper_status({ probe: false })    # hanya periksa konfigurasi, tanpa jaringan
```

Keluarannya menyebut: kredensial mana yang terbaca **dan dari mana asalnya**
(config plugin / variabel lingkungan / `.env` milik CLI upstream), plus status
hidup tiap sumber. Ini jawaban pertama untuk pertanyaan *"kenapa kosong?"*.

## Graf sitasi & salinan gratis (OpenAlex)

```
paper_citations({ identifier: "<DOI | id OpenAlex W… | JUDUL>", arah: "pengutip" })
paper_citations({ identifier: "…", arah: "rujukan", max_results: 20, urutkan: "terbaru" })
paper_oa({ identifier: "…" })
```

| Arah | Artinya | Untuk apa |
|---|---|---|
| **`pengutip`** (bawaan) | paper yang **MENGUTIP** karya ini | penelitian lanjutan, snowballing **maju** |
| **`rujukan`** | karya yang **DIKUTIP** paper ini | dasar teori, daftar bacaan, snowballing **mundur** |

`urutkan`: `sitasi` (bawaan, terbanyak dikutip dulu) atau `terbaru`.
`paper_oa` menyebut status (gold/green/hybrid/bronze/closed), tautan PDF & laman
tiap salinan, lisensi, dan versinya — **tanpa** perlu email Unpaywall.

**Tiga batas yang harus disebut apa adanya, bukan disembunyikan:**

1. **Masukan berupa JUDUL bisa memilih karya yang SALAH.** Terukur: judul
   *"Attention is all you need"* mengembalikan rekaman duplikat. Keluarannya
   **selalu** menyebut karya yang benar-benar dipakai — **periksa itu dulu**;
   lebih aman memberi **DOI**.
2. **Rujukan dibaca maksimal 100** per panggilan, jadi "terbanyak dikutip"
   berlaku di antara yang diperiksa. Kalau totalnya lebih besar, keluaran
   mengatakannya.
3. **Tool ini TIDAK mengunduh PDF** dan tidak menembus paywall — ia hanya
   menunjukkan tautannya. Yang mengunduh adalah **`paper_fulltext`**.

### Peta struktur sitasi — `analisis: "peta"`

Untuk **bab tinjauan pustaka**: bukan lagi "siapa mengutip siapa", melainkan
"bidang ini terbagi bagaimana, dan apa yang menyambungnya".

```
paper_citations({ identifier: "<DOI>", arah: "pengutip", analisis: "peta" })
paper_citations({ identifier: "<DOI>", arah: "pengutip", analisis: "peta",
                  max_kandidat: 50, ambang_kuat: 0.2, min_bersama_kuat: 4 })
```

Yang dilaporkannya:

| Bagian | Artinya | Gunanya |
|---|---|---|
| **paling sebidang** | coupling ke benih — seberapa banyak **rujukan yang SAMA** | "siapa yang benar-benar satu bidang dengan paper kunci saya", dihitung dari rujukan, **bukan** dari kata kunci |
| **dasar bersama** | rujukan yang paling sering dikutip **BERSAMA** oleh kandidat | bacaan wajib bidang ini — LIME `"Why Should I Trust You?"` muncul 8× pada uji nyata |
| **klaster bidang** | karya yang saling berbagi rujukan, dikelompokkan | membagi bidang jadi beberapa aliran, bukan satu daftar panjang |
| **jembatan antar-klaster** | karya yang nyaris masuk **dua** bidang sekaligus | kandidat celah riset — yang sulit terlihat dari daftar hasil biasa |

**Cara memakainya dengan jujur** — empat batas yang disebutkan sendiri oleh tool:

1. coupling & co-citation adalah **proksi** kemiripan, **bukan bukti** hubungan;
2. karya tanpa daftar rujukan di OpenAlex muncul dengan kedekatan **0** — itu
   "tidak diketahui", **bukan** "tidak mirip";
3. klaster **bergantung pada ambang** — sebutkan ambangnya saat melaporkan;
4. **jembatan** berarti nyaris masuk dua bidang *menurut rujukan*, bukan
   penilaian mutu. Rekaman wadah (prosiding dengan ratusan rujukan) **ditandai**
   karena ia "berdekatan dengan segalanya" — jangan dianggap temuan.

Biayanya tetap kecil: **2 permintaan OpenAlex** (3 bila perlu judul rujukan
bersama), sekitar 2 detik.

## Cache pencarian

Pencarian **di-cache 30 menit** di `~/.dsh/paper-search/cache-pencarian.json`.
Tujuannya sederhana: pencarian yang sama berulang dalam satu sesi itu lumrah.

- **Keluaran selalu mengatakannya** — `CATATAN: N dari M sumber dilayani dari
  CACHE (paling lama X menit lalu)`. Cache yang tidak terlihat adalah cache yang
  menyesatkan.
- **`paksa_ulang: true`** untuk mengabaikannya dan mencari ulang ke semua sumber.
- **Kegagalan tidak pernah disimpan** — hanya jawaban yang berhasil. Kalau tidak,
  gangguan sesaat akan "menular" selama 30 menit.
- Sumber **ber-kunci** (CORE, Unpaywall) **tidak** di-cache.
- Cek isi & batasnya lewat `paper_status`; bersihkan dengan
  `paper({ mode: "status", bersihkan_cache: true })`.
- Bisa dimatikan sekaligus lewat config plugin: `cache: false`.

## Teks lengkap: PDF → Markdown

```
paper_fulltext({ identifier: "1706.03762" })                    # id arXiv
paper_fulltext({ identifier: "10.1371/journal.pone.0266789" })  # DOI akses-terbuka
paper_fulltext({ identifier: "Attention Is All You Need" })     # judul
paper_fulltext({ identifier: "…", paksa_ulang: true })          # unduh & konversi ulang
```

Urutan mencari PDF: **arXiv lebih dulu** (id-nya dari DOI `10.48550/arXiv.<id>` atau
lokasi arXiv; kalau tidak ada, dicari **dari judul**), lalu lokasi OA OpenAlex,
terakhir Unpaywall. Hasilnya disimpan di `~/.dsh/paper-search/md/` (`.md` **dan**
PDF-nya) dan tool mengembalikan **jalur berkas** + isi lengkap kalau ≤ 20.000
huruf, atau cuplikan + perintah `read({ file_path, offset, limit })`.

Terukur 29 Sep 2026: PDF arXiv 2,1 MB → **39,8 KB Markdown dalam 424 ms**; PDF
PLOS 2,9 MB → **70,8 KB dalam 363 ms**. Lewat tool (termasuk unduh + cari arXiv):
**2,4–4,4 detik**, dan **0,3 detik** kalau berkasnya sudah ada.

**Konverternya harus terpasang** (tidak dibawa paket):

```sh
npm i -g @firecrawl/anydoc     # disarankan — Rust, tanpa Python
uv tool install markitdown     # cadangan
```

Kalau tidak ada, `paper_status` mengatakannya **sebelum** kamu mencoba.

**Batas yang tidak dilanggar:** hanya salinan **akses-terbuka**; tidak menembus
paywall; tidak memakai Sci-Hub/Anna's Archive; konversi **selalu lokal** (mode
`--ocr hosted` anydoc — yang mengunggah dokumen ke Firecrawl — **tidak pernah**
dipakai). Kalau tidak ada salinan sah, tool **gagal dan mengatakannya**.

## Kredensial (opsional — hampir semua sumber tetap jalan tanpanya)

Tidak ada kunci yang dibawa paket ini. Urutan pembacaan:

1. config plugin di profil DSH,
2. variabel lingkungan `PAPER_SEARCH_MCP_<NAMA>` lalu `<NAMA>`,
3. berkas `~/.config/paper-search-mcp/.env` (milik CLI upstream).

| Nama | Gunanya |
|---|---|
| `UNPAYWALL_EMAIL` | email apa pun — dipakai sebagai "polite pool" Crossref/OpenAlex |
| `OPENALEX_EMAIL` | sama, khusus OpenAlex |
| `SEMANTIC_SCHOLAR_API_KEY` | menaikkan batas laju Semantic Scholar |
| `DOAJ_API_KEY` | menaikkan batas per jam DOAJ |
| `CORE_API_KEY` | **wajib untuk sumber `core`** — tanpa kunci ia balas 429 tanpa pesan |

**Jangan** isi kunci IEEE — di upstream konektornya masih kerangka dan `search()`
selalu melempar `NotImplementedError`, jadi kuncinya tidak akan pernah berguna.

**ACM kini DIPAKAI — tetapi lewat Crossref, bukan kunci.** `PAPER_SEARCH_MCP_ACM_API_KEY`
**jangan diisi**: di upstream kunci itu tidak mungkin bernilai sah, karena ACM
tidak punya API pencarian publik. Sumber `acm` di sini bekerja tanpa kunci sama
sekali (saringan prefix DOI `10.1145`), dan hasilnya **tidak** ditandai akses
terbuka — PDF ACM masih dijawab **HTTP 403** (diukur 29 Sep 2026).

## Tidak ada CLI yang dibutuhkan

Plugin ini **berdiri sendiri**: seluruh **23 sumber** di atas native lewat HTTP —
tanpa CLI, tanpa paket Python, tanpa server pihak ketiga.

> Versi 0.1.6 ke bawah sempat menyarankan CLI `openags/paper-search-mcp` sebagai
> pelengkap, dan menyebut ia "menambah CORE, Zenodo, HAL, SSRN, Unpaywall".
> Saran itu **dihapus di 0.1.7**: keempat basis data yang disebut di situ sudah
> menjadi sumber **native** plugin ini, jadi kalimatnya menyesatkan.

## Cara melaporkan hasil ke Rasyid

Sajikan tabel: **judul, penulis, tahun, sumber (jurnal), DOI/URL**. Keluaran
tool sudah memuat semuanya, termasuk kolom `sumber:` yang menyebut **semua**
basis data yang menemukan paper itu (hasil dedup). Sebutkan juga kalau ada
sumber yang gagal pada pencarian itu.
