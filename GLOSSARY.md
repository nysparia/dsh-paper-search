# Translation glossary (Indonesian → English)

Mandatory for every file. Use these exact spellings so the codebase stays consistent.

## Core nouns

| Indonesian | English |
|---|---|
| berkas | file |
| akar | root |
| jalur | path |
| entri | entry / entries |
| kunci | key |
| nilai | value |
| jumlah | count |
| ukuran | size |
| byte | bytes |
| umur | age |
| batas | limit |
| maks / maksimal | max |
| bawaan | default |
| sementara | temporary |
| isi | content |
| daftar | list |
| peta | map |
| himpunan | set |
| baris | line |
| keluaran | output |
| masukan | input |
| hasil | result |
| catatan | note |
| pesan | message |
| galat | error |
| masalah | problem |
| sebab | reason |
| alasan | reason |
| kode | code |
| status | status |
| mode | mode |
| jenis | kind |
| tipe | type |
| label | label |
| nama | name |
| judul | title |
| penulis | authors |
| tahun | year |
| jurnal | journal |
| abstrak | abstract |
| sitasi | citations |
| rujukan | references |
| pengutip | citing |
| kandidat | candidates |
| benih | seed |
| klaster | cluster / clusters |
| jembatan | bridge / bridges |
| ambang | threshold |
| derajat | degree |
| tetangga | neighbors |
| nomor | index |
| induk | parent |
| permintaan | request / requests |
| kueri | query |
| pencarian | search |
| sumber | source |
| kredensial | credentials |
| konverter | converter |
| tautan | link |
| laman | page |
| akses | access |
| terbuka | open |
| kosong | empty |
| sah | valid |
| benar | true |
| salah | false |
| ada | exists |
| tidak | not / no |
| tanpa | without |
| hanya | only |
| selalu | always |
| dulu | first / earlier |
| lalu | then |
| supaya | so that |
| karena | because |
| tetapi | but |
| atau | or |
| dan | and |
| ini | this |
| itu | that |
| bisa | can |
| harus | must |
| wajib | required |
| disarankan | recommended |
| opsional | optional |
| dilewati | skipped |
| dibuang | dropped |
| disimpan | stored |
| dipakai | used |
| diambil | fetched |
| dikembalikan | returned |
| ditampilkan | shown |
| diperiksa | checked |
| dijalankan | run |
| dibuat | created |
| ditulis | written |
| dibaca | read |
| dihapus | deleted |
| dicari | searched |
| ditemukan | found |
| gagal | failed / failure |
| berhasil | succeeded / ok |
| ulang | again |
| paksa | force |
| paksa_ulang | force_refresh |
| bersihkan | clear |
| bersihkan_cache | clear_cache |
| kadaluarsa | expired |
| kedaluwarsa | expired |
| terbaru | newest |
| tertua | oldest |
| relevansi | relevance |
| urutkan | sort |
| urutan | order |
| saring | filter |
| penyaringan | filtering |
| pengurutan | sorting |
| gabung | merge |
| pisah | split |
| potong | truncate |
| bersih | clean |
| runtuh | collapse |
| kemiripan | similarity |
| padanan | match |
| cocok | match |
| persis | exact |
| sebagian | partial |
| pertama | first |
| terakhir | last |
| berikutnya | next |
| sebelumnya | previous |
| sekarang | now / current |
| lanjut | follow |
| lompatan | hop / redirect |
| pengalihan | redirect |
| aman | safe |
| privat | private |
| publik | public |
| dalam | inner / internal |
| luar | outer |
| atas | top |
| bawah | bottom |
| kiri | left |
| kanan | right |
| besar | large |
| kecil | small |
| panjang | long |
| pendek | short |
| baru | new |
| lama | old |
| sama | same / equal |
| berbeda | different |
| lain | other |
| semua | all |
| setiap | each |
| beberapa | several |
| banyak | many |
| sedikit | few |
| satu | one |
| dua | two |
| tiga | three |
| lima | five |
| penuh | full |
| lengkap | complete |
| mentah | raw |
| terurai | parsed |
| urai | parse |
| daftarkan | register |
| normalkan | normalize |
| normalkan_jenis | normalize_kind |
| hitung | count / compute |
| angka | number |
| teks | text |
| huruf | character |
| kata | word |
| frasa | phrase |
| periode | period |
| putaran | round / iteration |
| sebelum | before |
| sesudah | after |
| ekor | tail |
| kepala | head |
| badan | body |
| blok | block |
| pola | pattern |
| penanda | marker |
| halaman | page |
| portal | portal |
| repositori | repository |
| pra-cetak | preprint |
| terakreditasi | accredited |
| jurnal | journal |
| artikel | article |
| makalah | paper |
| karya | work |
| penelitian | research |
| penelusuran | traversal |
| snowballing | snowballing |
| maju | forward |
| mundur | backward |
| dasar | foundation / base |
| bersama | shared |
| sebidang | same-field |
| kedekatan | closeness |
| coupling | coupling |
| co-citation | co-citation |
| berguna | useful |
| mencurigakan | suspicious |
| wajar | reasonable |
| total | total |
| teratas | top |
| ukuran | size |

## Function / variable names

### cache.js
| Indonesian | English |
|---|---|
| TTL_BAWAAN_MS | DEFAULT_TTL_MS |
| MAKS_ENTRI_BAWAAN | DEFAULT_MAX_ENTRIES |
| MAKS_BYTE_BAWAAN | DEFAULT_MAX_BYTES |
| kunciCache | cacheKey |
| bolehDiCache | isCacheable |
| buatCache | createCache |
| berkasCacheBawaan | defaultCacheFile |
| baca | read |
| tulis | write |
| rapikan | prune |
| ambil | get |
| simpan | set |
| bersihkan | clear |
| buangKadaluarsa | dropExpired |
| dipakai | usedAt |
| disimpan | storedAt |
| umurMs | ageMs |
| jumlahSah | validCount |
| tertuaMs | oldestMs |
| terbaruMs | newestMs |
| maksEntri | maxEntries |
| maksByte | maxBytes |
| sekarang | now |
| bahan | payload |
| versi | version |

### peta.js
| Indonesian | English |
|---|---|
| idPendek | shortId |
| himpunanRujukan | referenceSets |
| bersama | sharedCount |
| kedekatanKeBenih | closenessToSeed |
| coCitasi | coCitation |
| klasterkan | clusterWorks |
| jembatan | findBridges |
| petaBerguna | mapIsUseful |
| ringkasKlaster | summarizeCluster |
| minBersama | minShared |
| cari | find |
| satukan | union |
| ambangKuat | strongThreshold |
| minBersamaKuat | minSharedStrong |
| ambangLemah | weakThreshold |
| minBersamaLemah | minSharedWeak |
| minKlasterLain | minOtherClusters |
| batasRujukanWajar | reasonableRefLimit |
| refsSendiri | ownRefs |
| klasterLain | otherClusters |
| refBenih | seedRefs |
| minKandidat | minCandidates |
| tahunMin | yearMin |
| tahunMaks | yearMax |
| sitasiTotal | totalCitations |
| teratas | top |

### fulltext.js
| Indonesian | English |
|---|---|
| AKAR_BAWAAN | DEFAULT_ROOT |
| cariKonverter | findConverter |
| jalurLazim | usualPaths |
| perluShell | needsShell |
| perintahSpawn | spawnCommand |
| konversiKeMarkdown | convertToMarkdown |
| unduhPdf | downloadPdf |
| tautanAman | isSafeUrl |
| periksaPdf | checkPdf |
| slugBerkas | fileSlug |
| siapkanTeksLengkap | prepareFullText |
| kandidatPdf | pdfCandidates |
| padananArxiv | arxivMatch |
| karyaArxiv | arxivWork |
| paksaUlang | forceRefresh |
| cariArxiv | findArxiv |
| dariCache | fromCache |
| arxivDariJudul | arxivFromTitle |
| catatanCache | cacheNote |
| catatanArxiv | arxivNote |
| arxivPersis | arxivExact |
| berkasGalat | errorFile |
| tujuan | destination |
| awalan | prefix |
| maksLompatan | maxRedirects |
| lompatan | hop |
| lanjut | follow |
| lokasi | location |
| aman | safe |
| privat | private |
| konv | conv |
| TIMEOUT_KONVERSI_MS | CONVERT_TIMEOUT_MS |
| TIMEOUT_UNDUH_MS | DOWNLOAD_TIMEOUT_MS |

### index.js
| Indonesian | English |
|---|---|
| DIR_PAKET | PACKAGE_DIR |
| BERKAS_SKILL | SKILL_FILE |
| bacaEnvUpstream | readUpstreamEnv |
| buatPembacaKredensial | createCredentialReader |
| emailPolite | politeEmail |
| pilihSumber | selectSources |
| JENIS_SAH | VALID_KINDS |
| normalkanJenis | normalizeKind |
| angkaKarya | workNumber |
| saringDanUrutkan | filterAndSort |
| jalankanPencarian | runSearch |
| barisSumber | sourceLine |
| formatHasil | formatResult |
| keluaranTeks | textOutput |
| toolSearch | searchTool |
| toolStatus | statusTool |
| batasAngka | clampNumber |
| normArah | normalizeDirection |
| headerKarya | workHeader |
| barisPaper | paperLines |
| potong | truncate |
| petaStruktur | structureMap |
| toolCitations | citationsTool |
| toolOa | oaTool |
| toolFulltext | fulltextTool |
| uraiFrontmatter | parseFrontmatter |
| daftarkanSkill | registerSkill |
| LABEL_MODE | MODE_LABELS |
| CATATAN_SATU | SINGLE_MODE_NOTE |
| normalkanTools | normalizeTools |
| gabungJadiSatu | mergeIntoOne |
| MUAT_DIKIRIM_SEKALIGUS | INLINE_MAX_CHARS |
| CUPLIKAN_AWAL | PREVIEW_CHARS |
| akarPerpus | libraryRoot |
| cacheMati | cacheDisabled |
| lima | tools |
| pilihan | choice |
| pintu | single |
| daftarMode | modeList |
| sifat | properties |
| wajib | required |
| namaMode | modeName |
| kurang | missing |
| takDikenal | unknown |
| dilewati | skipped |
| perSumber | perSource |
| saring | filter |
| sitasiTakSah | invalidCitations |
| jenisTakDikenal | unknownKinds |
| urutTakSah | invalidSort |
| urutTakSahNilai | invalidSortValue |
| mintaSitasi | requestedCitations |
| mintaJenis | requestedKind |
| mintaUrut | requestedSort |
| opsi | options |
| queryDoi | queryIsDoi |
| eksplisit | explicit |
| dek | closeness |
| adaCoupling | withCoupling |
| ccAda | withCoCitation |
| perluJudul | needTitles |
| karyaRef | refWorks |
| judulPer | titleBy |
| kl | clusters |
| judulKarya | titleByWork |
| jem | bridge |
| dicurigai | suspicious |
| ban | batch |
| permintaan | requests |

### sources.js
| Indonesian | English |
|---|---|
| ENTITAS | ENTITIES |
| bersihTeks | cleanText |
| daftarPenulis | authorList |
| normDoi | normalizeDoi |
| runtuhkanJudul | collapseTitle |
| buatPaper | makePaper |
| KOLOM_CROSSREF | CROSSREF_FIELDS |
| saringKrossref | crossrefFilter |
| dariItemCrossref | fromCrossrefItem |
| abstrakOpenAlex | openAlexAbstract |
| dariKaryaOpenAlex | fromOpenAlexWork |
| BATAS_RUJUKAN | REFERENCE_LIMIT |
| urlOpenAlex | openAlexUrl |
| openalexJson | openAlexJson |
| idKarya | workId |
| apakahIdKarya | isWorkId |
| ringkasKarya | summarizeWork |
| resolusiKarya | resolveWork |
| KOLOM_PETA | MAP_FIELDS |
| kandidatPeta | mapCandidates |
| karyaDariIds | worksFromIds |
| karyaMengutip | worksCiting |
| karyaDikutip | worksCited |
| ringkasOA | summarizeOA |
| normJudul | normalizeTitle |
| kemiripanJudul | titleSimilarity |
| AMBANG_JUDUL_ARXIV | ARXIV_TITLE_THRESHOLD |
| karyaArxiv | arxivWork |
| apakahArxivId | isArxivId |
| idArxivDariUrl | arxivIdFromUrl |
| idArxivDariKarya | arxivIdFromWork |
| padananArxiv | arxivMatch |
| arxivTunggu | arxivWait |
| uraikanArxiv | parseArxiv |
| ambilArxiv | fetchArxiv |
| kueriArxiv | arxivQuery |
| pertama | first |
| ambilHtml | collectHtml |
| portalNolHasil | portalHasNoResults |
| doiDariBibtex | doiFromBibtex |
| openalexRepositori | openAlexRepository |
| SUMBER | SOURCES |
| ID_SUMBER | SOURCE_IDS |
| ID_INTERNASIONAL | INTERNATIONAL_IDS |
| ID_INDONESIA | INDONESIA_IDS |
| ID_DOI | DOI_IDS |
| apakahDoi | isDoi |
| cariSumber | findSource |
| kunciJudul | titleKey |
| arxivTerakhir | arxivLastRequest |

## Tool parameter names (model-facing — must change)

| Indonesian | English |
|---|---|
| paksa_ulang | force_refresh |
| urutkan | sort |
| min_sitasi | min_citations |
| jenis | kind |
| sources | sources (unchanged) |
| max_results | max_results (unchanged) |
| open_access_only | open_access_only (unchanged) |
| year_from | year_from (unchanged) |
| probe | probe (unchanged) |
| bersihkan_cache | clear_cache |
| identifier | identifier (unchanged) |
| arah | direction |
| analisis | analysis |
| ambang_kuat | strong_threshold |
| min_bersama_kuat | min_shared_strong |
| max_kandidat | max_candidates |
| mode | mode (unchanged) |

## Tool parameter values (model-facing — must change)

| Indonesian | English |
|---|---|
| pengutip | citing |
| rujukan | references |
| sitasi | citations |
| terbaru | newest |
| relevansi | relevance |
| daftar | list |
| peta | map |
| article / review / preprint | unchanged |
| all / semua | all |
| international / internasional | international |
| indonesia / lokal | indonesia |
| five / lima | five |
| one / satu | one |

## Source ids (MUST NOT change — they are the public API)

`crossref, acm, openalex, doaj, europepmc, pubmed, arxiv, semantic, pmc, core, zenodo, hal, iacr, openreview, ssrn, ieee, biorxiv, medrxiv, chemrxiv, unpaywall, garuda, sinta, ios`

## Rules

1. Translate comments, JSDoc, identifiers, and every user-facing string.
2. Do **not** change: source ids, tool names (`paper_search`, `paper_status`, `paper_citations`, `paper_oa`, `paper_fulltext`, `paper`), the `name`/`inject` exports, URLs, regexes, or numeric constants.
3. Keep the existing comment structure and the measured-data notes — translate them, do not delete them.
4. Keep code behavior byte-identical apart from renamed identifiers.
