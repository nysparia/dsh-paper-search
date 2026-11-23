# Changelog

## Compatibility

| dsh-paper-search | DeepSeek Harness | Diuji pada |
|---|---|---|
| 0.4.1 | 0.2.0-rc.2 | 2 Okt 2026, Windows, Node 24 |
| 0.4.0 | 0.2.0-rc.2 | 2 Okt 2026, Windows, Node 24 |
| 0.3.1 | 0.2.0-rc.2 | 2 Okt 2026, Windows, Node 24 |
| 0.3.0 | 0.2.0-rc.2 | 1 Okt 2026, Windows, Node 24 |
| 0.2.0 | 0.2.0-rc.2 | 1 Okt 2026, Windows, Node 24 |
| 0.1.9 | 0.2.0-rc.2 | 1 Okt 2026, Windows, Node 24 |
| 0.1.8 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.7 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.6 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.5 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.4 | 0.1.7-rc.2 | 28 Sep 2026, Windows, Node 24 |
| ~~0.1.0~~ | — | **JANGAN DIPAKAI — plugin gagal dimuat, lihat 0.1.1** |

Paket ini tidak memakai API internal DSH selain `ctx.tools.register` dan
`ctx.get('skills').registerProvider` — keduanya sudah dipakai plugin lain yang
berjalan di profil ini (`dsh-search-cascade`), jadi titik patahnya sama dan sudah
diketahui.

## [0.4.1] - 2026-10-02

### Fixed — penjagaan tautan unduhan PDF

Ditemukan **sesudah membaca PR upstream #56** ("safety improvements", +3.963/−669,
terbuka sejak 16 April 2026). Judul PR itu **menyesatkan**: mayoritas isinya
infrastruktur transport HTTP, bukan keamanan. Yang benar-benar berharga ada di
enam konektor: pemeriksaan host memakai **substring** (`if 'doi.org' in url`,
`if 'web.archive.org' in resp.url`) diganti parsing hostname yang benar.

Itu kelas bug nyata — `https://jahat.example/?x=doi.org` lolos pemeriksaan
substring. **Audit kode kita: pola itu tidak ada** (0 pemeriksaan host berbasis
substring, 7 pemakaian `new URL()`).

Tetapi audit yang sama menemukan celah **setara milik kita**: `unduhPdf()`
mengikuti redirect **tanpa memeriksa apa pun**. URL unduhan datang dari API
pihak ketiga (lokasi OA OpenAlex, Unpaywall, `openAccessPdf` Semantic Scholar,
CORE), jadi isinya harus diperlakukan sebagai **data yang belum tepercaya**.

Yang diperbaiki:

- **`tautanAman(url)`** (baru, fungsi murni sehingga bisa diuji tanpa jaringan):
  hanya `http`/`https`; menolak `localhost`, `*.local`, `*.internal`,
  `*.home.arpa`, dan alamat IP privat/loopback/link-local termasuk
  `169.254.169.254` (endpoint metadata cloud) serta IPv6 `::1`/`fc00::/7`/`fe80::`.
- **Redirect diikuti satu per satu** (`redirect: 'manual'`) dengan penjaga yang
  sama pada **setiap lompatan**. Sebelumnya `redirect: 'follow'` membuat hop
  kedua dan seterusnya tidak pernah terlihat — jadi penjaga di tautan awal saja
  bisa dilewati lewat satu redirect. `Location` relatif diselesaikan dengan
  benar, dan lompatan dibatasi 5 supaya lingkaran redirect tidak menggantung.

Batas yang harus disadari: ini **bukan** penjagaan menyeluruh. Ia menutup kelas
"tautan menuju ke dalam", bukan semua kemungkinan. Yang tetap dipertahankan dan
tidak diubah: balasan wajib benar-benar PDF (magic `%PDF-` dan ≥ 1.000 byte) dan
penulisan tetap atomik (`.part` → rename).

Diverifikasi: **uji nyata** mengunduh PDF arXiv sungguhan lewat `paper_fulltext`
dan mengubahnya jadi Markdown (39,8 KB) dalam 2 detik — penjaganya tidak
menghalangi jalur yang sah.

### Uji

`uji-teks-lengkap` **16 → 43 asersi** (27 baru: 4 tautan yang harus diizinkan,
12 yang harus ditolak, 3 batas anti-over-blocking, dan 5 skenario redirect
termasuk Location relatif serta lingkaran tak berujung).

## [0.4.0] - 2026-10-02

**Dua kemampuan baru, dan tetap SATU pintu.** Tidak ada tool baru: peta sitasi
masuk sebagai `analisis: "peta"` pada `paper_citations`, dan cache masuk sebagai
perilaku `paper_search`.

### Added — peta struktur sitasi (issue upstream #122)

`paper({ mode: "citations", identifier, analisis: "peta" })` membangun peta
bidang dari **rujukan**, bukan dari kata kunci:

- **Bibliographic coupling** — kedekatan tiap karya dengan benih lewat rujukan
  yang SAMA. Menjawab "siapa yang paling sebidang dengan paper ini".
- **Co-citation** — rujukan yang paling sering dikutip BERSAMA oleh kandidat;
  inilah "dasar bersama" sebuah bidang.
- **Pengelompokan klaster** — dua syarat sekaligus (cosine DAN jumlah rujukan
  sama), karena masing-masing punya lubang: cosine saja menyambungkan karya
  berdaftar-rujukan sangat pendek, jumlah saja menyambungkan karya besar yang
  kebetulan beririsan. Ambangnya **dilaporkan** di keluaran.
- **Jembatan antar-klaster** — karya yang nyaris masuk dua bidang sekaligus.
  Dihitung **dua tingkat** (klaster ketat + keterkaitan longgar), karena dengan
  satu tingkat sebuah jembatan justru MELEBUR kedua klaster sehingga tidak
  pernah terdeteksi. Rekaman wadah (prosiding) yang punya ratusan rujukan
  **ditandai**, bukan dianggap temuan.

Uji nyata pada "Guidelines for Human-AI Interaction": coupling menemukan
*Questioning the AI* (0,143), co-citation menemukan LIME *"Why Should I Trust
You?"* (dikutip bersama 8×), klaster XAI terbentuk, dan jembatan teratas adalah
survey sungguhan yang menyambung 4 klaster. **2 permintaan OpenAlex**, 2,2 detik.

### Added — cache pencarian berbatas (semangat #94/#140)

`paper_search` kini memakai cache lokal (`~/.dsh/paper-search/cache-pencarian.json`):

- **Kegagalan TIDAK PERNAH disimpan** — hanya jawaban yang berhasil. Kalau tidak,
  gangguan sesaat akan "menular" selama TTL dan sumber yang sudah pulih tetap
  terlihat mati.
- **Sumber ber-kunci dan ber-DOI dilewati** (CORE, Unpaywall).
- **Kunci tidak memuat kredensial** — kunci API/email tidak masuk kunci cache,
  supaya berkas cache tidak menjadi tempat rahasia bocor.
- **Berbatas**: TTL 30 menit, maks 200 entri, maks 2 MB; yang paling lama dipakai
  dibuang lebih dulu. Ditulis **atomik** (`.part` → rename), dan berkas rusak
  tidak melumpuhkan apa pun.
- **Selalu terlihat**: umur cache disebut di laporan, `paksa_ulang: true` untuk
  mengabaikannya, dan `mode: "status"` melaporkan isi/batas cache serta bisa
  membersihkannya (`bersihkan_cache: true`).

Terukur: pencarian kedua **2.118 ms → 1 ms**, tetap berhasil ketika jaringan
sengaja dimatikan, dan `paksa_ulang` benar-benar mencari ulang (gagal saat
jaringan mati — bukti ia tidak diam-diam memakai cache).

### Uji

- `test/uji-peta-sitasi.mjs` — **37 asersi** (baru, murni/offline) + 2 mutasi.
- `test/uji-cache-pencarian.mjs` — **34 asersi** (baru, jam dipalsukan).
- `test/uji-plugin.mjs` — **59** (naik 2: skema mode peta dijaga).
- `test/uji-sumber.mjs` 79 · `test/uji-satu-pintu.mjs` 30 · `test/uji-cari-saring.mjs` 21
  · `test/uji-teks-lengkap.mjs` 16 · `test/uji-kesesuaian-dokumen.mjs` 6.
- **Uji nyata** (bukan unit): peta dijalankan ke OpenAlex untuk kedua arah, dan
  cache diuji dengan jaringan dimatikan.

## [0.3.1] - 2026-10-02

**Menutup dua sumber upstream yang belum pernah dinilai** — satunya dipakai,
satunya ditolak dengan bukti.

### Added — ChemRxiv (22 → 23 sumber)

- **`chemrxiv`** — pra-cetak **kimia**, lewat OpenAlex (repositori `S4393918830`,
  **64.495** karya; "catalysis" → **13.594** hasil nyata, diukur 2 Okt 2026).
- **Mengapa bukan situsnya:** `chemrxiv.org` membalas **HTTP 403** dengan halaman
  Cloudflare ("Just a moment...") untuk halaman pencarian **maupun** gateway
  API-nya. Modul upstream mengambil HTML dari sana — jalur itu akan diblokir,
  jalur OpenAlex ini tidak. Sama seperti SSRN (0.2.0) dan IEEE (0.3.0).
- Nol kode baru: `chemrxiv` memakai fungsi bersama `openalexRepositori()` yang
  sudah dipakai SSRN, bioRxiv, dan medRxiv.

### Ditolak — OAI-PMH, dengan alasan protokol (bukan "endpointnya mati")

`oaipmh` di upstream adalah klien protokol **generik**, dan **protokolnya tidak
mendukung pencarian kata kunci sama sekali**: modul itu memakai
`verb=ListRecords` (pemanenan), sedangkan parameter `query` **diterima di tanda
tangan fungsi tetapi tidak pernah dikirim ke API**. Artinya ia mengembalikan
rekaman sembarang yang tidak cocok dengan kueri — persis jenis kesalahan senyap
yang paket ini tolak di seluruh bagian lain. Endpoint defaultnya
(`api.base-search.net/oai`, yaitu BASE — yang sudah kita tolak karena butuh IP
institusi) juga menjawab **HTTP 404** saat diukur 2 Okt 2026.

Pencarian sungguhan lewat OAI-PMH menuntut pengunduhan massal seluruh rekaman,
bukan pencarian literatur. Dicatat di `upstream/catatan.json` supaya tidak
dinilai ulang dari nol.

### Uji

- `test/uji-sumber.mjs` — **79 asersi** (jumlahnya tidak berubah; menambah sumber
  tidak menambah asersi per sumber), 23 sumber diuji hidup, **22 menjawab**.
- `test/uji-kesesuaian-dokumen.mjs` — **6 asersi**; ia yang menunjuk **10 tempat**
  dokumen yang harus diperbarui saat sumbernya bertambah.
- `test/uji-plugin.mjs` 57 · `test/uji-satu-pintu.mjs` 30 · `test/uji-cari-saring.mjs` 21
  · `test/uji-teks-lengkap.mjs` 16.

## [0.3.0] - 2026-10-01

**Cakupan lebih luas tanpa menambah satu pun tool** — dan tanpa satu pun pengikis
baru: seluruh sumber baru ini diambil lewat API yang **sudah** dipakai plugin ini.

### Added — tiga sumber baru (19 → 22)

- **`ieee`** — lewat Crossref `filter=member:263`, **tanpa kunci API**. Trik yang sama
  dengan ACM (#123). Terukur: `member:263` menjawab **136.771** karya; dengan
  `type:proceedings-article` **106.734**; setiap hasil ber-DOI `10.1109/…`.
  ⚠️ **Batas yang sengaja tidak diklaim:** Crossref **tidak** membawa abstrak IEEE
  (terukur 0 dari 5 rekaman), jadi abstraknya biasanya kosong — medan sitasinya ada.
  Upstream (PR #138) tetap membuat IEEE butuh kunci; jalur ini tidak.
- **`biorxiv`** dan **`medrxiv`** — lewat **filter sumber OpenAlex**, bukan API mereka
  (API bioRxiv/medRxiv tidak punya pencarian kata kunci sama sekali, hanya rentang
  tanggal/kategori). Terukur: bioRxiv `S4306402567` **345.976** karya ("digital
  literacy" → 159; dengan pra-cetak + sitasi > 4 → 141) · medRxiv `S3005729997`
  **87.941** karya ("digital literacy" → **1.352**).
- Ini juga membersihkan kode: SSRN, bioRxiv, dan medRxiv kini memakai **satu** fungsi
  bersama `openalexRepositori()`.

### Added — push-down pra-cetak

- `jenis: ["preprint"]` kini diteruskan ke **Europe PMC** sebagai `AND SRC:PPR`
  (terukur: "digital literacy" + SRC:PPR → **2.775**, tanpa itu **85.096**).
  Penambahan ini hanya terjadi saat pra-cetak memang diminta — tidak ada logika "NOT"
  yang bisa membuang hasil diam-diam.

### Added — alat & penjaga untuk mengikuti upstream

- **`upstream/catatan.json`** — buku catatan keputusan atas issue/PR upstream
  (diadopsi / sebagian / ditolak / tidak-relevan / belum), beserta alasan dan versi.
- **`alat/pindai-upstream.mjs`** — satu perintah yang melaporkan: item **BARU**,
  yang **BELUM** diputuskan, yang **BERUBAH** sesudah pemindaian terakhir (keputusan
  lama bisa jadi tidak berlaku), dan **penyimpangan daftar sumber** yang diukur dari
  berkas asli `paper_search_mcp/academic_platforms/` — bukan dari ingatan.
  Ada `--ketat` yang keluar kode 1 bila ada yang perlu ditindak.
- **`test/uji-kesesuaian-dokumen.mjs`** — penjaga yang **GAGAL** bila angka sumber di
  README / SKILL.md / package.json / entri katalog tidak sama dengan jumlah sebenarnya,
  bila klaim "tanpa kredensial" tidak cocok dengan medan `credit`, atau bila ada id
  sumber yang tidak punya **baris tabel** di SKILL.md. Termasuk 3 mutasi self-test.
  Dibuat **sebelum** sumber barunya ditambahkan — dan langsung menunjuk 9 tempat yang
  harus diperbarui, sehingga tidak ada lagi pembaruan dokumen dengan tangan.

### Uji

- `test/uji-sumber.mjs` — **79 asersi**, 22 sumber diuji hidup (**21 menjawab**, 1 SKIP
  karena jaringan).
- `test/uji-kesesuaian-dokumen.mjs` — **6 asersi** (baru).
- `test/uji-plugin.mjs` 57 · `test/uji-satu-pintu.mjs` 30 · `test/uji-cari-saring.mjs` 21
  · `test/uji-teks-lengkap.mjs` 16.

## [0.2.0] - 2026-10-01

**Rilis fitur terbesar sejak paket ini ada.** Lima usulan yang diambil dari
issue/PR upstream `openags/paper-search-mcp` — dipilih setelah memeriksa mana
yang belum kita miliki, karena beberapa di antaranya **sudah** ada di sini
(validasi `%PDF-` sebelum menulis, pacing arXiv 3 detik, parser defensif).

### Added — dua sumber baru (17 → 19)

- **`openreview`** (issue upstream #83) — konferensi ML: ICLR, NeurIPS, ICML.
  Tanpa kunci API. Yang dipakai adalah `api2.openreview.net/notes/search?term=…`
  karena endpoint generik `/notes` dibalas **HTTP 403 `ChallengeRequiredError`**
  (verifikasi bot), dan parameter kuerinya bernama `term`, bukan `query`.
  DOI diambil dari medan `_bibtex` supaya karya yang sama ikut ter-dedup dengan
  Crossref, dan `pdf` relatif (`/pdf/<hash>.pdf`) dilengkapi ke openreview.net.
- **`ssrn`** (PR upstream #60) — pra-cetak ekonomi/hukum/bisnis, **lewat
  OpenAlex**, tanpa mengambil satu pun halaman ssrn.com (situs itu membalas
  **HTTP 403** untuk permintaan biasa). Seluruh 1,65 juta karya SSRN terindeks
  OpenAlex sebagai satu sumber (`S4210172589`); terukur: `search=digital
  literacy` + filter sumber itu menjawab **3.836 karya**.

### Added — penyaringan & pengurutan hasil pencarian

- **`urutkan`**: `relevansi` (bawaan) · `sitasi` · `terbaru`. Karya yang angkanya
  tidak dilaporkan sumber ditaruh paling belakang — bukan dianggap nol.
- **`min_sitasi`**: hanya karya dengan sitasi ≥ N. Karya dari sumber yang tidak
  melaporkan sitasi **dibuang**, dan jumlahnya disebut di laporan.
- **`jenis`**: `article` · `review` · `preprint`. Diteruskan ke sumber yang
  mendukung (OpenAlex `filter=type:`, Crossref/ACM `filter=type:`) supaya
  `max_results` tetap terisi hasil yang lolos, lalu disaring lagi setelah dedup.
  Karya yang jenisnya tidak dilaporkan sumber **tetap ditampilkan** — "tidak
  disebut" bukan berarti "bukan artikel".
- Semua yang dibuang **dihitung dan dilaporkan**. "Hasilnya cuma sedikit" tidak
  boleh menjadi misteri.

### Fixed

- **Cache teks penuh bisa menyajikan PDF cacat.** `unduhPdf()` kini menulis
  lewat berkas `.part` lalu `renameSync` (atomik), dan PDF dari cache diperiksa
  sebelum dipakai: kalau tidak sah, pasangan `.md`/`.pdf`-nya dibuang lalu
  diunduh ulang — sembuh sendiri, bukan menyajikan hasil yang diragukan.
  PDF yang sudah bagus **tidak pernah** dirusak unduhan baru yang gagal.
- **Nama penulis OpenReview hilang tanpa suara.** `daftarPenulis()` tidak
  mengenal bentuk `{fullname}` yang dipakai rekaman ORCID/DBLP di sana, sehingga
  `[{fullname: '…'}]` menghasilkan daftar kosong. Kini dikenali, dan diuji.
- **`Number(null)` = 0 membuat "sitasi tidak diketahui" terbaca sebagai
  "0 sitasi"**, sehingga karya tanpa laporan sitasi ikut terbuang oleh
  `min_sitasi` seolah-olah sitasinya nol. Tertangkap oleh uji baru
  `test/uji-cari-saring.mjs`.
- **`venue` OpenReview kadang berisi judulnya sendiri**(terukur pada rekaman
  ORCID), sehingga judul tampil dua kali; kini diperlakukan sebagai "tidak
  dilaporkan".

### Changed

- Uji `ios` (IOS OneSearch) tidak lagi membuat seluruh uji merah ketika
  situsnya tidak bisa dihubungi: kegagalan **jaringan** dilaporkan sebagai
  `SKIP`, sedangkan sumber yang *menjawab* dengan galat tetap `FAIL`.
  Dasarnya terukur: `onesearch.id` menjawab `fetch failed` di plugin 0.2.0
  **dan** di salinan 0.1.9 yang terpasang.

### Uji

- `test/uji-cari-saring.mjs` — **baru**, 21 asersi murni (tanpa jaringan) untuk
  penyaringan & pengurutan.
- `test/uji-teks-lengkap.mjs` — **baru**, 16 asersi untuk keutuhan cache PDF
  (validasi, tulis atomik, sembuh sendiri). Seluruh jaringan dipalsukan.
- `test/uji-sumber.mjs` — **79 asersi** (19 sumber diuji hidup; 18 menjawab,
  1 SKIP karena jaringan).
- `test/uji-plugin.mjs` — **57 asersi**, `test/uji-satu-pintu.mjs` — **30 asersi**.
- Perbaikan uji: asersi ACM diperbarui untuk bentuk filter yang kini
  menggabungkan `jenis`, bukan menggantikannya.

## [0.1.9] - 2026-10-01

**Dokumentasi saja — tidak ada perubahan kode.** Rilis ini ada karena panduan
bawaan plugin masih mengasumsikan kelima tool terpisah.

### Fixed

- **Panduan bawaan** (`skills/paper-search/SKILL.md`) masih berjudul **"Lima
  tool"** dan hanya menyebut nama `paper_search` / `paper_status` /
  `paper_citations` / `paper_oa` / `paper_fulltext` — padahal sejak **0.1.8**
  sebuah profil boleh memasang `tools: "one"`, dan di profil itu kelima nama
  tersebut **tidak ada**. Sekarang: judulnya **"Lima kemampuan"**, ada **kolom
  padanan satu pintu** (`paper({ mode: "…" })`), plus contoh untuk **kedua**
  bentuk. Sebelumnya catatan mode hanya **disisipkan saat berkas dimuat**, jadi
  tabel di badan berkas tetap menunjuk nama yang tidak ada di profil satu pintu —
  itu yang diperbaiki di sini.

### Tidak berubah

- `lib/` **identik dengan 0.1.8**: 17 sumber, lima tool, dan perilakunya sama.
  Bawaan tetap **lima tool terpisah**; `tools: "one"` tetap **opt-in**.
- Deskripsi katalog tetap **425 huruf** (batas keras katalog 500).

### Verified

- `test/uji-sumber.mjs` **77/77** · `test/uji-plugin.mjs` **57/57** ·
  `test/uji-satu-pintu.mjs` **30/30** · `test/uji-di-dsh.mjs` **27/27**
  (boot DSH 0.2.0-rc.2 sungguhan).
- `check-all.mjs` (penjaga DSH di mesin ini) **24 pemeriksaan**, 1 SKIP karena
  Reddit membalas HTTP 403 — bukan kerusakan kode.

## [0.1.8] - 2026-09-29

**Opsi baru `tools: "one"` — kelima tool digabung jadi SATU pintu.** Bawaan
**tidak berubah**: tanpa config, kelima tool tetap terpisah.

### Added

- **Config `tools`**: `"five"` (bawaan — perilaku lama, 5 tool terpisah) atau
  `"one"` (satu tool bernama **`paper`** dengan parameter `mode`:
  `search` · `status` · `citations` · `oa` · `fulltext`). Nilai tak dikenal
  **jatuh ke bawaan** dan alasannya dilaporkan di catatan `apply()` — bukan
  dipakai diam-diam.

### Kenapa opsi ini ada

Kelima definisi tool ikut dikirim ke model **setiap permintaan**. Terukur
29 Sep 2026 di mesin ini (`test/uji-satu-pintu.mjs`):

| | huruf JSON | perkiraan token |
|---|---|---|
| lima tool (bawaan) | 4.959 | ~1.240 |
| satu pintu (`tools: "one"`) | 2.159 | ~540 |
| **hemat** | **56%** | ~700 token/permintaan |

### Harga yang harus disadari (jangan disembunyikan)

- **Nama tool berhenti menjelaskan dirinya.** `paper_fulltext` langsung terbaca
  "baca isi paper"; sekarang kemampuan itu ada di balik `paper` +
  `mode: "fulltext"`, jadi model harus membaca deskripsi untuk menemukannya.
- **Skema jadi longgar.** Satu skema tidak bisa mewajibkan parameter berbeda per
  mode, jadi penjagaan berpindah dari DSH ke plugin: `paper({ mode: "oa" })` tanpa
  `identifier` **ditolak oleh plugin** (pesannya meniru penolakan skema), bukan
  oleh harness sebelum tool dipanggil.
- Karena itu **bawaan tetap lima tool** — mode ini untuk pemasangan yang memang
  mengutamakan ongkos konteks.

### Jaminan yang diuji

Skema dan daftar parameter wajib **DITURUNKAN** dari kelima definisi tool asli
(bukan disalin), sehingga tidak bisa menyimpang saat tool aslinya berubah. Badan
skill diberi **catatan mode** saat `tools: "one"` supaya dokumen tidak menyuruh
memanggil nama tool yang tidak ada; deskripsi katalognya dijaga **≤ 500 huruf**
(terukur 474). Semuanya di `test/uji-satu-pintu.mjs` — **29 asersi**.

## [0.1.7] - 2026-09-29

**Rapian keluaran `paper_status`, dan berhenti meninggalkan berkas sampah.**
Tidak ada tool yang ditambah, diganti nama, atau dihapus — kelimanya tetap sama.

### Fixed

- **`paper_status` tidak lagi menyuruh memasang CLI pihak ketiga.** Blok
  `== CLI paper-search-mcp (opsional) ==` **dihapus**, dan isinya memang sudah
  tidak akurat: ia menyebut CLI itu "menambah CORE, Zenodo, HAL, Unpaywall",
  padahal **keempatnya sudah menjadi sumber native** plugin ini. Diganti satu
  baris catatan: seluruh sumber sudah native dan plugin **tidak memerlukan CLI
  atau server pihak ketiga apa pun** — jadi keluaran `paper_status` tidak lagi
  menawarkan pemasangan yang tidak dibutuhkan.
- **Deskripsi tool `paper_status` tidak lagi menjanjikan pemeriksaan yang tidak
  ada.** Bunyinya dulu "…serta apakah CLI paper-search-mcp opsional terpasang",
  padahal kode **tidak pernah** memeriksa itu. Sekarang bunyinya sesuai kenyataan:
  kredensial, status tiap sumber, dan **konverter PDF→Markdown** yang tersedia
  untuk `paper_fulltext` — plus petunjuk `probe:false` untuk memeriksa tanpa
  jaringan.
- **Berkas `<nama>.md.err` tidak lagi menumpuk.** Sebelumnya setiap konversi
  meninggalkan satu berkas galat; **terukur 29 Sep 2026 16:05 WIB: satu berkas
  0 byte per konversi** (konversi ulang arXiv 1706.03762). Sekarang berkas itu
  **dihapus saat konversi BERHASIL**, dan **tetap disimpan saat GAGAL** supaya
  pesan asli konverter masih bisa dilaporkan. Penghapusan dilakukan **sesudah**
  descriptor ditutup — di Windows, menghapus berkas yang masih terbuka akan gagal.
- **Markdown 0 byte sisa konversi yang GAGAL ikut dibuang.** Sebelumnya PDF yang
  gagal dikonversi meninggalkan `.md` kosong di folder perpustakaan. Pemanggil
  sebenarnya sudah aman (`size > 0` dijaga di `siapkanTeksLengkap`), tetapi
  berkas 0 byte itu membingungkan kalau foldernya dilihat manusia — sekarang
  dihapus saat gagal, sementara **pesan galatnya tetap disimpan di `.err`**.
  Terukur 29 Sep 2026: PDF palsu → `kode keluar 1 — anydoc: malformed document:
  not a PDF`, `.err` tetap ada, `.md` 0 byte hilang.

### Catatan

- Yang **tidak** berubah: 17 sumber, 5 tool, urutan PDF (arXiv lebih dulu),
  konversi yang selalu lokal, dan penolakan menembus paywall.
- Bagi yang memang sudah memakai CLI upstream sebagai pelengkap: plugin ini
  **tidak melarangnya**, hanya berhenti menyarankannya.

## [0.1.6] - 2026-09-29

**Teks lengkap: PDF akses-terbuka diunduh, lalu diubah ke Markdown** supaya agen
bisa membaca ISI SEBUAH PAPER UTUH — bukan hanya judul dan abstraknya.

Satu tool baru (**`paper_fulltext`**, jadi 5 tool) dan satu langkah yang upstream
tidak punya.

### Added

- **Cadangan arXiv untuk PDF** (adopsi PR upstream **#124**). Diukur 29 Sep 2026:
  OpenAlex **tidak** menyimpan id arXiv (`ids` hanya `openalex`/`doi`/`mag`), jadi
  id-nya diturunkan dari DOI `10.48550/arXiv.<id>` atau URL lokasi; kalau tidak
  ada, versi arXiv **dicari dari judul**. Urutan percobaan PDF: **arXiv lebih
  dulu**, lalu lokasi OA OpenAlex, terakhir Unpaywall. `paper_fulltext` juga
  menerima **id arXiv langsung** (`1706.03762`).

- **Konversi PDF → Markdown lewat `anydoc`** (cadangan: `markitdown`). Model tidak
  bisa membaca PDF mentah, dan satu paper utuh tidak muat dikirim sekaligus —
  jadi hasilnya ditulis ke **berkas** `.md` di `~/.dsh/paper-search/md/`, PDF-nya
  disimpan berdampingan, dan yang dikembalikan adalah **jalurnya** + isi lengkap
  (kalau ≤ 20.000 huruf) atau cuplikan + cara membacanya bertahap dengan `read`.

  Terukur: PDF arXiv *Attention Is All You Need* (2,1 MB) → **39,8 KB Markdown
  dalam 424 ms**; PDF PLOS ONE (2,9 MB) → **70,8 KB dalam 363 ms**, lengkap
  dengan tautan rujukan. Total lewat tool (termasuk unduh + cari arXiv):
  **2,4–4,4 detik**, dan **0,3 detik** saat berkasnya sudah ada.

- **`paper_status` kini melaporkan konverter.** Kalau tidak ada anydoc/markitdown,
  itu dikatakan **sebelum** pengguna mencoba dan gagal — beserta cara memasangnya.

### Fixed

- **Penyaring judul arXiv yang longgar — tertangkap sebelum terbit.** Aturan
  "judul memuat judul" menerima paper yang BERBEDA: terukur, judul *"Attention Is
  All You Need"* juga menerima *"Not All Attention Is All You Need"* dan
  *"Element-wise Attention Is All You Need"* — dan **yang pertama bisa saja yang
  diunduh**. `kemiripanJudul()` sekarang **ketat**: sama persis setelah
  normalisasi, atau memuat dengan rasio panjang ≥ 0,92.
- **Peringatan `DEP0190` Node dihapus.** Menjalankan `anydoc.cmd` dengan
  `shell: true` memicu peringatan bahwa argumen tidak di-escape. Sekarang
  memakai `cmd.exe /d /c <skrip> <arg…>` — perilaku sama, tanpa peringatan.
- **Id arXiv tidak lagi dicap "dipilih dari JUDUL".** Masukan berupa id arXiv
  diberi baris `arXiv: …` sendiri, bukan peringatan yang menyesatkan.

### Catatan — batas yang tetap dijaga

- **Hanya salinan AKSES-TERBUKA.** Tidak menembus paywall, tidak memakai Sci-Hub
  atau Anna's Archive. Kalau tidak ada salinan sah, `paper_fulltext` **gagal
  dengan jujur** dan menyebutkan apa yang tidak dilakukannya. Terukur pada
  `10.1145/3290605.3300233` (ACM, tertutup): gagal, beserta daftar kandidatnya.
- **Konversi SELALU lokal.** `anydoc` punya mode `--ocr hosted` yang mengirim
  dokumen ke Firecrawl; plugin ini **tidak pernah** memakainya.
- **Berkas tidak dihapus otomatis.** Perpustakaan `~/.dsh/paper-search/` tumbuh
  ±2–3 MB per paper (PDF + Markdown). Folder bisa diubah lewat config plugin
  `folderTeksLengkap`.
- ⚠️ **README versi ≤ 0.1.5 menulis "tidak mengunduh PDF" — itu sudah tidak
  benar.** Kalimatnya sudah diperbaiki di rilis ini.

### Diuji

- `node test/uji-sumber.mjs` — **77/77 lulus** (17 sumber, 14 menjawab).
- `node test/uji-plugin.mjs` — **57/57 lulus**; `paper_fulltext` dipanggil
  sungguhan: unduh **dan** konversi, lalu dibuktikan berkas `.md`-nya ada di disk
  dan isinya benar-benar paper itu.
- `node test/uji-di-dsh.mjs` — **27/27 lulus** di DSH 0.2.0-rc.1 sungguhan.
- **~20 asersi regresi baru**: enam kasus `kemiripanJudul()` (termasuk dua judul
  palsu yang dulu lolos), lima kasus id arXiv, empat kasus `kandidatPdf()` (yang
  membuktikan arXiv dicoba **pertama**), dua kasus `slugBerkas()`, dan
  `cariKonverter()`.

## [0.1.5] - 2026-09-29

Dua **saran fitur** dari issue/PR repo upstream `openags/paper-search-mcp` —
keduanya menunjuk nomornya. Rilis ini menambah **satu sumber** (16 → 17) dan
**dua tool** (2 → 4). Semuanya diukur 29 Sep 2026.

### Added

- **Sumber `acm` — ACM Digital Library, TANPA kunci API** (PR upstream **#123**).
  Di upstream, `acm.py` adalah kerangka yang selalu melempar `NotImplementedError`,
  sehingga `PAPER_SEARCH_MCP_ACM_API_KEY` **tidak akan pernah bisa** diisi nilai
  sah — sumbernya mustahil dihidupkan lewat kunci. ACM tidak punya API pencarian
  publik, tetapi **seluruh terbitannya terdaftar di Crossref dengan satu prefix
  DOI**, dan prefix itu bisa disaring: `filter=prefix:10.1145`.
  Terukur: `"eye tracking"` → **3 hasil, 520 ms**, semuanya `10.1145/…`
  (Crossref mencatat 7,6 juta karya ACM).

- **Tool `paper_citations`** (PR upstream **#96**) — graf sitasi OpenAlex, gratis
  dan tanpa kunci:
  - `arah: "pengutip"` = paper yang **mengutip** karya ini (snowballing maju);
  - `arah: "rujukan"` = karya yang **dikutip** paper ini (snowballing mundur).
  Masukan boleh **DOI, id/tautan OpenAlex (`W…`), atau JUDUL**.
  Terukur pada `10.1145/3290605.3300233`: **2.257 pengutip** dan **35 rujukan**.

- **Tool `paper_oa`** (PR upstream #96) — salinan akses-terbuka lewat OpenAlex,
  **tanpa perlu email Unpaywall**. Menyebut status (gold/green/hybrid/bronze/
  closed), tautan PDF & laman tiap salinan, lisensi, dan versi.
  Terukur: `10.1371/journal.pone.0266789` → **gold, 3 salinan** (cc-by,
  publishedVersion); sedangkan paper ACM tertutup dijawab apa adanya
  (`TIDAK AKSES TERBUKA`) beserta langkah berikutnya.

- **Jumlah sitasi ikut ditampilkan** di hasil `paper_search` bila sumbernya
  melaporkannya (OpenAlex, Semantic Scholar). `null` berarti **tidak diketahui**
  — dan dibedakan dari `0`.

### Catatan — yang diukur, dan yang SENGAJA TIDAK diklaim

- **Hasil ACM tidak ditandai "akses terbuka".** PR #123 menyebut ACM DL terbuka
  sejak 1 Jan 2026, tetapi **diukur ulang di sini dan tidak mendukungnya**:
  `HEAD https://dl.acm.org/doi/pdf/<doi 2026>` dijawab **HTTP 403**, dan hanya
  **9 dari 20** ACM terbitan 2026 punya medan `license` di Crossref. Sumber yang
  mengklaim OA tanpa bukti lebih buruk daripada yang tidak mengklaim.
- **Kenapa DUA tool, bukan TIGA seperti upstream.** Setiap tool ikut dikirim
  ulang ke model pada **setiap** permintaan. Dua arah sitasi berbagi satu skema
  karena bentuk masukannya identik. Ini alasan yang sama yang membuat plugin ini
  tidak memakai MCP bridge 57 tool milik PR #97.
- **Pemilihan lewat JUDUL bisa salah.** Terukur: judul *"Attention is all you
  need"* mengembalikan rekaman duplikat (`W2626778328`) ber-DOI aneh. Karena itu
  keluaran **selalu** menyebut karya yang benar-benar dipakai, supaya salah pilih
  terlihat.

### Fixed

- **Judul diperlakukan sebagai DOI — bug di kode baru rilis ini, tertangkap
  sebelum terbit.** `normDoi()` hanya membuang awalan URL lalu memeriksa panjang,
  jadi ia menerima **hampir semua teks**; memakainya untuk memutuskan "ini DOI?"
  membuat `"zzzqqqxxyy tidak mungkin ada"` dijawab *"DOI … tidak ditemukan"*
  alih-alih dicari sebagai judul. Kini keputusannya memakai `apakahDoi()`, dan
  `normDoi()` hanya dipakai **sesudah** lolos. Ada penjaga regresinya.
- **HTTP 429 & 504 OpenAlex diterjemahkan.** Terukur 29 Sep 2026:
  `works/doi:…` sempat dijawab **HTTP 504 "Gateway timeout"** (body JSON
  `reason: query_timeout`). Sebelumnya pemakainya hanya melihat "HTTP 504";
  sekarang pesannya menyebut bahwa itu **transien** dan cukup diulang. Yang 429
  juga menyebut cara menaikkan batasnya.
- **Uji plugin tidak lagi mati total saat jaringan gagal.** Satu `HTTP 504`
  membuat skrip uji berhenti **sebelum ringkasan tercetak** — kegagalan transien
  jadi tampak seperti kerusakan. Kini dibungkus, dan muncul sebagai **FAIL yang
  bisa dibaca**. (Itu bug uji, bukan bug plugin.)

### Diuji

- `node test/uji-sumber.mjs` — **58/58 lulus** melawan API & halaman sungguhan,
  **14 dari 17 sumber menjawab** (yang gagal dilaporkan apa adanya: OpenAlex 429
  dan PubMed Central HTTP 500 — dua-duanya transien).
- `node test/uji-plugin.mjs` — **46/46 lulus**; kedua tool baru dipanggil
  sungguhan sampai mengembalikan data.
- `node test/uji-di-dsh.mjs` — **26/26 lulus** di DSH **0.2.0-rc.1** sungguhan.
  Saksi dari dalam harness mencatat `schemas=Array(4): paper_search,
  paper_status, paper_citations, paper_oa`.
- **~40 asersi regresi baru**: penjaga jumlah sumber, pemetaan Crossref yang
  dibagi dua sumber, lima kasus `ringkasOA`, enam kasus `ringkasKarya`/
  `apakahIdKarya`, dedup jumlah sitasi (`null` ≠ `0`), dan penjaga
  "apakahDoi dipakai untuk memutuskan DOI".

## [0.1.4] - 2026-09-28

Empat perbaikan yang **dipelajari dari Issues & PR repo upstream
`openags/paper-search-mcp`** — masing-masing menunjuk issue-nya, bukan dikarang.

### Fixed

- **PubMed & PMC diurutkan menurut TANGGAL, bukan relevansi** (upstream issue #29).
  `esearch` tidak pernah diberi `sort`, dan bawaan PubMed adalah tanggal-terbaru.
  Untuk kueri luas itu buruk: yang muncul paper baru yang tangensial, bukan paper
  fondasional. Sekarang memakai `sort=relevance`.

  Terukur pada `"ocular microbiome"`: puncaknya berubah dari paper 2026 yang
  tangensial menjadi *The Microbiome, Ocular Surface, and Corneal Disorders*
  (2023) dan *The Ocular Microbiome in Stevens-Johnson Syndrome* (2021) — persis
  seperti yang diprediksi issue itu.

- **Nama penulis bisa terpecah PER HURUF** (upstream issue #109/#110/#112).
  Konektor mengoper **string** ke medan bertipe daftar, lalu pemakainya
  meng-`join` string itu — `"TAN, Kwan Hong"` menjadi
  `"T; A; N; ,;  ; K; w; a; n; …"`. Ditambahkan `daftarPenulis()` yang menerima
  string, array string, array objek (`{name}`, `{display_name}`,
  `{given,family}`), bentuk bersarang OpenAlex (`{author:{display_name}}`), dan
  medan yang hilang — **tidak pernah melempar**.

  `daftarPenulis()` **sengaja TIDAK memecah pada koma**: `"TAN, Kwan Hong"`
  adalah SATU penulis. Hanya titik koma yang jadi pemisah. Konektor yang
  sumbernya memang memakai daftar berpemisah koma (DOAJ `authorString`, IACR)
  memecahnya lebih dulu, baru menormalkan.

- **arXiv: kueri multi-kata kini presisi dulu, longgar sebagai cadangan**
  (upstream issue #6/#101/#113). Bentuk `all:kata1 AND all:kata2` dipakai lebih
  dulu; hanya kalau kosong, bentuk longgar dijalankan.

  **Kenapa TIDAK sekadar meniru perbaikan upstream** yang mengutip frasa:
  **diukur 28 Sep 2026** — untuk kueri Indonesia `"literasi digital"`, bentuk
  terkutip dan bentuk AND sama-sama memberi **0 hasil**, sedangkan bentuk longgar
  memberi **50**. arXiv adalah korpus berbahasa Inggris; mengutip membabi-buta
  akan menghapus SELURUH hasil untuk topik non-Inggris. Jadi yang dipakai adalah
  presisi-**dengan**-cadangan.

- **HTTP 406 arXiv kadang masih membawa Atom feed yang SAH** (upstream issue #121).
  Sebelumnya 406 langsung dianggap gagal. Sekarang isi balasannya dicoba diurai
  lebih dulu — issue itu melaporkan 406 dengan body 5250 byte berisi 2 entri sah.
  Untuk itu `getText()` kini menyimpan `err.bodyPenuh` terpisah dari `err.body`
  (yang tetap pendek untuk pesan galat).

### Added

- **15 asersi regresi baru**: 9 bentuk penulis (termasuk kasus bug #109), 3 bentuk
  kueri arXiv, penjaga `sort=relevance`, dan penjaga penyelamatan body 406.

### Catatan — yang sudah ada dan TIDAK perlu diubah

Diperiksa terhadap issue upstream, dan ternyata sudah tertangani sejak 0.1.0:
timeout 25 detik per permintaan (issue #55), pelaporan sumber tidak dikenal
(issue #105), dedup lintas sumber (issue #33), dan prinsip pelaporan kegagalan
alih-alih "0 hasil" (issue #100/#111).

**PR upstream #97** (`feat: DeepSeek Harness (dsh) integration`) memakai jalur
**MCP bridge** yang mengekspos **57 tool** — persis rute yang kami buang karena
biayanya **12.342 token per permintaan**. Plugin ini mendaftarkan **2 tool**.
Jadi PR itu mengukuhkan keputusan kami, bukan mengubahnya.

## [0.1.3] - 2026-09-28

### Fixed

- **Portal Indonesia melaporkan GAGAL padahal hasilnya cuma KOSONG.** Ketiga
  konektor Indonesia melempar `markup ... berubah` setiap kali penanda hasil tidak
  ditemukan — termasuk saat portal itu **sah-sah saja menjawab nol hasil**. Itu
  keliru dengan arah berlawanan dari prinsip paket ini: melaporkan kegagalan di
  tempat yang seharusnya kosong sama menyesatkannya dengan menyembunyikan
  kegagalan.

  Ketahuan dari **uji orkestrasi**, bukan dari uji unit: `Sinta` gagal untuk
  `"literasi digital remaja"` padahal berhasil untuk `"pendidikan karakter"`.
  Setelah halaman kosong dan halaman ber-hasil dibandingkan, ternyata ketiga
  portal punya penanda nol-hasilnya sendiri:

  | Portal | Penanda nol hasil | Halaman kosong |
  |---|---|---|
  | Garuda | `Found 0 documents` | 11.181 huruf |
  | Sinta | header `Results for "<q>"` tetap ada, tautan profil nol | 34.063 huruf |
  | IOS | `No Results!` | 23.041 huruf |

  `portalNolHasil()` sekarang membedakan **tiga** kemungkinan — nol hasil (→ `[]`),
  markup berubah (→ error), dan diblokir (→ error) — bukan dua.

  Akibatnya untuk Sinta: kueri spesifik yang memang nol hasil tidak lagi tampak
  seperti kerusakan. Sinta mendaftar **jurnal**, bukan artikel, jadi nol hasil itu
  wajar dan sekarang dilaporkan sebagai nol.

### Added

- 3 asersi regresi: kueri omong kosong ke ketiga portal Indonesia harus
  menghasilkan **0 hasil tanpa error**.

## [0.1.2] - 2026-09-28

### Fixed

- **Judul Garuda masih bisa terduplikasi.** Perbaikan di rilis sebelumnya baru
  menangani pengulangan **persis** (`X X X`). Setelah mengukur **50 judul
  sungguhan** (5 kueri, diambil apa adanya dari halaman Garuda), ternyata ada
  **empat** bentuk pengulangan, bukan satu:

  | Bentuk | Contoh | Panjang |
  |---|---|---|
  | A — periode persis | `X X X X X X` | 255 → 43 |
  | B — diulang sesudah `": "` | `X: X` | 194 → 96 |
  | C — awalan lalu `X: X` | `NLP, Machine Learning X: X` | 270 → 145 |
  | D — frasa diulang di awal | `IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI …` | 306 → 295 |

  `runtuhkanPeriodik()` diganti **`runtuhkanJudul()`** yang menangani keempatnya,
  termasuk pengulangan dengan **kapitalisasi berbeda** (252 → 125) — Garuda
  memang sering mengulang judul dalam huruf besar lalu huruf kecil.

  **Yang paling penting, dan inilah yang diuji:** judul **sah** berformat
  `Judul: subjudul`, `Judul: (studi kasus)`, dan `Judul: kata kunci` **tidak**
  ikut terpotong. Karena itu aturannya menuntut bagian sesudah `": "` benar-benar
  **sama** dengan akhiran bagian sebelumnya — bukan sekadar ada titik dua. Pada
  50 judul itu hasilnya: **14 diringkas, 36 dibiarkan, 0 cacat**, dan **15 judul
  bertitik dua tetap utuh**.

### Added

- **11 asersi regresi baru** di `test/uji-sumber.mjs`, memakai teks yang diambil
  apa adanya dari Garuda. Lima di antaranya justru menjaga agar judul **sah**
  tidak terpotong — tanpa itu, aturannya bisa "lulus" hanya dengan memotong
  setiap judul yang bertitik dua.

## [0.1.1] - 2026-09-28

### Fixed

- **Plugin gagal dimuat sama sekali — perbaikan yang wajib.** DSH mewajibkan
  setiap tool mendeklarasikan `output: { schema, render }`. Versi 0.1.0 tidak
  punya itu, sehingga `ctx.tools.register` **melempar**:

  ```
  TypeError: tool "paper_search" must declare output { schema, render, presentationMeta? }
  ```

  Karena lemparan itu terjadi di dalam `apply()`, **seluruh plugin batal
  dimuat** — kedua tool **dan** skill-nya tidak pernah terdaftar. Pengguna 0.1.0
  tidak akan melihat `paper_search` sama sekali.

  Ditemukan lewat **uji boot DSH sungguhan**, bukan lewat uji `ctx` tiruan:
  `register` tiruan hanya menampung definisinya, jadi tidak pernah menegakkan
  syarat ini. Inilah bukti bahwa tiruan tidak bisa menggantikan harness nyata.

  **Kalau Anda memasang 0.1.0, naikkan ke 0.1.1.**

### Added

- `test/uji-di-dsh.mjs` — **uji boot DSH sungguhan.** Menyalin profil `headless`
  ke profil uji (profil `desktop` yang hidup **tidak disentuh**), menyisipkan
  plugin ini plus satu **plugin saksi**, menjalankan DSH nyata, lalu memeriksa
  dari DALAM bahwa: kedua tool terdaftar, provider skill terdaftar, skill
  muncul di katalog, dan `paper_search` benar-benar dipanggil sampai
  mengembalikan paper sungguhan. **22 asersi, 0 gagal.**

  Uji ini juga mencatat dua jebakan yang sudah terukur, supaya tidak diulang:
  tanpa `inject` service tidak terlihat dari plugin lain, dan pada detik ke-4
  harness sudah membongkar pluginnya sehingga pemeriksaan **harus** berjalan di
  dalam `apply()`.

## [0.1.0] - 2026-09-28

Rilis pertama.

### Added

- **Enam belas sumber lewat satu tool `paper_search`**, semuanya native HTTP:
  - **tiga belas internasional** — Crossref, OpenAlex, DOAJ, Europe PMC, PubMed,
    PubMed Central, arXiv, Semantic Scholar, CORE, Zenodo, HAL lewat REST API
    JSON; IACR ePrint lewat penguraian HTML; Unpaywall lewat REST API dengan
    **input DOI** (bukan kata kunci);
  - **tiga portal Indonesia** lewat penguraian halaman publik — Garuda (artikel
    jurnal), Sinta (daftar jurnal terakreditasi), IOS OneSearch (agregator
    repositori).
- **Sumber ber-input DOI ditandai di registry** (`input: 'doi'`). Saat pengguna
  mencari dengan kata kunci, `unpaywall` **dilewati** — bukan dijalankan lalu
  dilaporkan kosong — dan alasan pelewatan itu dicetak dalam keluaran. Saat
  diminta eksplisit, ia tetap dijalankan dan mengembalikan kosong, karena
  memang begitulah perilakunya.
- **Dua sumber wajib kredensial**, masing-masing dilaporkan sebagai kegagalan
  yang bisa ditindaklanjuti, bukan 429 yang membingungkan:
  `core` butuh `CORE_API_KEY`; `unpaywall` butuh email.
- **Dedup** berdasarkan DOI lalu judul yang dinormalkan; setiap hasil mencatat
  **semua** sumber yang menemukannya, bukan menyembunyikan yang lain.
- **Tool `paper_status`** — mengirim satu permintaan kecil ke tiap sumber dan
  melaporkan mana yang benar-benar menjawab, plus kredensial mana yang terbaca
  **beserta dari mana asalnya** (config plugin / variabel lingkungan /
  `.env` milik CLI upstream).
- **Registrasi skill `paper-search`** lewat `ctx.get('skills').registerProvider()`
  di rank **450** — sengaja kalah dari berkas di `~/.dsh/skills` (rank 400)
  supaya suntingan pengguna selalu menang. Dibaca ulang setiap kali, tidak
  di-cache, jadi suntingan `SKILL.md` langsung terpakai tanpa restart.
- **Pembatas laju arXiv sendiri** (1 permintaan / 3 detik) sesuai TOU mereka,
  walau sumber lain dipanggil paralel.

### Fixed

- Judul Garuda yang diulang oleh markup `<xmp>`-nya (terukur: judul 44 huruf
  diulang ~6× menjadi 255 huruf) kini diringkas menjadi satu salinan. Aturannya
  konservatif — hanya bila pengulangannya persis dari awal sampai akhir.
- DOI dinormalkan tanpa awalan URL (`https://doi.org/...`) supaya dedup bekerja
  lintas sumber.

### Catatan kejujuran

- **Sembilan sumber publik SENGAJA TIDAK didaftarkan**, masing-masing dengan
  alasan yang diukur 28 Sep 2026 — bukan karena lupa:

  | Sumber | Alasan |
  |---|---|
  | `moraref` | hanya halaman pendarat, tanpa markup hasil (3.964 huruf) |
  | `dblp` | API di balik proteksi bot — mengembalikan halaman "Making sure you're not a bot!", bukan JSON |
  | `openaire` | permintaan uji **timeout 30 detik dan 40 detik** |
  | `biorxiv` | API-nya berbasis **rentang tanggal**, bukan pencarian kata kunci |
  | `medrxiv` | sama seperti `biorxiv` |
  | `base` | OAuth/OAI-PMH menolak: `Access denied for IP address 182.8.249.89…` — butuh pendaftaran IP institusi |
  | `citeseerx` | HTTP 404, lalu **menggantung** sampai permintaannya dibunuh |
  | `ssrn` | menolak permintaan biasa dengan HTTP 403 |
  | `google_scholar` | deteksi bot aktif, butuh proxy |

  Sumber yang selalu kosong lebih buruk daripada sumber yang tidak ada, jadi
  yang gagal dibuang **beserta alasannya** — bukan didaftarkan supaya jumlahnya
  terlihat banyak. Deskripsi paket, README, SKILL.md, entri katalog, dan
  `lib/index.js` semuanya menyebut angka yang sama, dan `lib/index.js` punya
  penjaga yang memperingatkan bila jumlahnya berubah tanpa dokumen ikut
  diperbarui.
  > **`iacr` dan `unpaywall` SEMPAT masuk daftar ini lalu dikeluarkan** setelah
  > diuji ulang: `iacr` menjawab HTTP 200 dengan hasil yang bisa diurai, dan
  > `unpaywall` menjawab HTTP 200 dengan DOI. Menganggap "bukan pencari kata
  > kunci" sebagai "mati" adalah kekeliruan yang sudah dikoreksi.
- **Kegagalan sumber tidak pernah disamarkan sebagai kekosongan.** Setiap
  non-2xx melempar error beserta status HTTP-nya, dan kedua tool memisahkan
  baris `GAGAL` dari baris `OK`. Ini perbaikan langsung atas kelemahan yang
  terukur pada tool sejenis: konektornya mengembalikan daftar kosong untuk
  SETIAP status != 200 tanpa mencatat apa pun, sehingga permintaan yang kena
  batas laju terbaca sebagai "literatur ini tidak ada".
- **CORE adalah satu-satunya sumber yang WAJIB berkunci.** Terukur: tanpa
  `Bearer` ia menjawab HTTP 429 dengan body **kosong** — bukan 401. Karena itu
  kunci yang hilang dilaporkan sebagai pesan yang bisa ditindaklanjuti, bukan
  dibiarkan menjadi 429 yang membingungkan.
- Tidak ada kunci API maupun alamat email yang dibawa paket ini.

### Diuji

- `node test/uji-sumber.mjs` — **8/8 lulus** melawan API dan halaman SUNGGUHAN;
  **15 dari 16 sumber menjawab**. Dua kegagalan transien terlihat dan
  **dilaporkan apa adanya**, bukan disembunyikan sebagai "0 hasil":
  Semantic Scholar sempat 429 karena pengujian beruntun (pulih setelah 150
  detik), dan PubMed Central sempat HTTP 500 `error forwarding request`
  (batas laju E-utilities; sebelumnya 3 hasil di jalan yang sama).
- `node test/uji-plugin.mjs` — **29/29 lulus** dengan `ctx` tiruan: dua tool
  terdaftar, provider skill mengembalikan rank 450, frontmatter terurai
  (deskripsi 348 huruf, di bawah batas katalog 500), dan kedua tool benar-benar
  memanggil jaringan.
