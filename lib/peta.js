// lib/peta.js — struktur sitasi: bibliographic coupling, co-citation,
// pengelompokan, dan jembatan antar-klaster (issue upstream #122).
//
// SELURUH berkas ini MURNI: tidak ada jaringan, tidak ada berkas. Semua masuk
// sebagai daftar karya yang sudah punya `referenced_works`, semua keluar sebagai
// angka/daftar. Itu disengaja — bagian yang paling mudah salah di sini adalah
// matematikanya, dan matematika harus bisa diuji tanpa API.
//
// ISTILAH, supaya tidak tertukar:
//   • Bibliographic coupling = dua karya DIKATAKAN mirip karena mengutip
//     rujukan yang SAMA. Berbasis apa yang mereka tulis.
//   • Co-citation = dua rujukan disebut BERSAMA oleh karya lain. Berbasis siapa
//     yang mengutipnya. Butuh pihak ketiga, jadi tidak bisa dihitung per karya.
//   • Jembatan = karya yang menyambung dua kelompok yang kalau tidak, terpisah.

/** Id pendek OpenAlex dari entri `referenced_works` (URL) atau id telanjang. */
export function idPendek(x) {
  return String(x ?? '').split('/').pop() || null;
}

/**
 * Peta id karya -> himpunan id rujukannya.
 * Karya tanpa daftar rujukan tetap masuk dengan himpunan KOSONG — "tidak punya
 * rujukan tercatat" berbeda dari "tidak ada di peta", dan bedanya harus tetap
 * terlihat oleh pemanggil.
 */
export function himpunanRujukan(works) {
  const peta = new Map();
  for (const w of works ?? []) {
    const id = idPendek(w?.id);
    if (!id) continue;
    const refs = new Set((w?.referenced_works ?? []).map(idPendek).filter(Boolean));
    peta.set(id, refs);
  }
  return peta;
}

/** Cosine similarity antara dua himpunan (0..1). Himpunan kosong -> 0. */
export function coupling(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let sama = 0;
  const [kecil, besar] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of kecil) if (besar.has(x)) sama++;
  return sama / Math.sqrt(a.size * b.size);
}

/** Berapa rujukan yang sama antara dua himpunan. */
export function bersama(a, b) {
  if (!a || !b) return 0;
  let n = 0;
  const [kecil, besar] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of kecil) if (besar.has(x)) n++;
  return n;
}

/**
 * Seberapa dekat tiap kandidat dengan karya BENIH (coupling ke daftar rujukan
 * benih). Diurutkan menurun. Inilah "siapa yang paling sebidang dengan paper
 * ini", dihitung dari rujukan — bukan dari kata kunci.
 */
export function kedekatanKeBenih(works, refBenih) {
  const peta = himpunanRujukan(works);
  return (works ?? [])
    .map((w) => {
      const id = idPendek(w?.id);
      const refs = peta.get(id) ?? new Set();
      return {
        id,
        title: w?.title ?? null,
        year: w?.publication_year ?? null,
        citedBy: Number.isFinite(Number(w?.cited_by_count)) ? Number(w.cited_by_count) : null,
        refs: refs.size,
        bersama: bersama(refs, refBenih),
        coupling: coupling(refs, refBenih),
      };
    })
    .sort((a, b) => (b.coupling - a.coupling) || (a.id ?? '').localeCompare(b.id ?? ''));
}

/**
 * Co-citation: untuk setiap rujukan benih, berapa kandidat yang MENGUTIPnya.
 * Yang tertinggi = dasar bersama bidang ini (paling sering disebut bersama-sama).
 *
 * Sengaja mengembalikan SEMUA rujukan benih (termasuk yang nol) supaya pemanggil
 * bisa membedakan "tidak ada yang mengutip bersama" dari "tidak dihitung".
 */
export function coCitasi(works, refBenih) {
  const jumlah = new Map();
  const refArr = [...(refBenih ?? [])];
  for (const r of refArr) jumlah.set(r, 0);
  for (const w of works ?? []) {
    const refs = new Set((w?.referenced_works ?? []).map(idPendek).filter(Boolean));
    for (const r of refArr) if (refs.has(r)) jumlah.set(r, (jumlah.get(r) ?? 0) + 1);
  }
  return refArr
    .map((id) => ({ id, oleh: jumlah.get(id) ?? 0 }))
    .sort((a, b) => (b.oleh - a.oleh) || a.id.localeCompare(b.id));
}

/**
 * Kelompokkan kandidat menjadi klaster: dua kandidat dianggap bersambung bila
 * mereka berbagi >= `minBersama` rujukan DAN cosine-nya >= `ambang`.
 *
 * Dua syarat, bukan satu, karena masing-masing punya lubang: cosine saja
 * menyambungkan karya dengan daftar rujukan sangat pendek (1 rujukan yang sama
 * = cosine tinggi), sedangkan jumlah-bersama saja menyambungkan karya besar
 * yang kebetulan beririsan di daftar panjang. Ambangnya DIKEMBALIKAN supaya
 * laporan bisa menyebutkannya — angka yang tidak disebut adalah angka yang
 * tidak bisa diperiksa.
 *
 * Memakai union-find sederhana; kembaliannya deterministik (klaster diurutkan
 * berdasarkan ukuran lalu id terkecil) supaya keluarannya bisa dibandingkan.
 */
export function klasterkan(works, { ambang = 0.05, minBersama = 2 } = {}) {
  const peta = himpunanRujukan(works);
  const ids = [...peta.keys()].sort();
  const induk = new Map(ids.map((id) => [id, id]));

  const cari = (x) => {
    let r = x;
    while (induk.get(r) !== r) r = induk.get(r);
    // kompresi jalur
    let k = x;
    while (induk.get(k) !== r) { const n = induk.get(k); induk.set(k, r); k = n; }
    return r;
  };
  const satukan = (a, b) => {
    const ra = cari(a);
    const rb = cari(b);
    if (ra !== rb) induk.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  const tetangga = new Map(ids.map((id) => [id, new Set()]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = peta.get(ids[i]);
      const b = peta.get(ids[j]);
      if (bersama(a, b) < minBersama) continue;
      if (coupling(a, b) < ambang) continue;
      satukan(ids[i], ids[j]);
      tetangga.get(ids[i]).add(ids[j]);
      tetangga.get(ids[j]).add(ids[i]);
    }
  }

  const per = new Map();
  for (const id of ids) {
    const r = cari(id);
    if (!per.has(r)) per.set(r, []);
    per.get(r).push(id);
  }
  const klaster = [...per.values()].sort((a, b) => (b.length - a.length) || a[0].localeCompare(b[0]));
  const nomor = new Map();
  klaster.forEach((anggota, i) => anggota.forEach((id) => nomor.set(id, i)));
  return { klaster, tetangga, nomor, ambang, minBersama };
}

/**
 * Jembatan: karya yang menyambung klaster-klaster yang JIKA TIDAK ADA DIA akan
 * terpisah.
 *
 * ⚠️ Ini TIDAK bisa dihitung dari satu pengelompokan saja — dan itu sempat saya
 * tulis salah: dengan union-find, sebuah jembatan justru MELEBUR kedua klaster,
 * sehingga "tetangga di klaster lain" tidak akan pernah ada. Uji
 * `uji-peta-sitasi.mjs` yang menangkapnya. Karena itu dipakai **dua tingkat**:
 *
 *   1. klaster dihitung pada ambang KETAT (hubungan harus kuat);
 *   2. jembatan = karya yang pada ambang LONGGAR bersambung ke anggota dari
 *      >= `minKlasterLain` klaster ketat yang BERBEDA.
 *
 * Jadi sebuah karya disebut jembatan hanya kalau ia "nyaris" masuk dua bidang
 * sekaligus — bukan karena ia memang bagian kuat dari salah satunya.
 */
export function jembatan(works, {
  ambangKuat = 0.15, minBersamaKuat = 3,
  ambangLemah = 0.05, minBersamaLemah = 2,
  minKlasterLain = 2,
  batasRujukanWajar = 300,
} = {}) {
  const ketat = klasterkan(works, { ambang: ambangKuat, minBersama: minBersamaKuat });
  const peta = himpunanRujukan(works);
  const ids = [...peta.keys()].sort();
  const keluar = [];

  for (const id of ids) {
    const refsSendiri = peta.get(id) ?? new Set();
    const klasterLain = new Set();
    let derajat = 0;
    for (const lain of ids) {
      if (lain === id) continue;
      if (bersama(refsSendiri, peta.get(lain)) < minBersamaLemah) continue;
      if (coupling(refsSendiri, peta.get(lain)) < ambangLemah) continue;
      derajat++;
      const n = ketat.nomor.get(lain);
      if (n !== undefined && n !== ketat.nomor.get(id)) klasterLain.add(n);
    }
    if (klasterLain.size >= minKlasterLain) {
      keluar.push({
        id,
        klasterLain: klasterLain.size,
        derajat,
        refs: refsSendiri.size,
        // Rekaman WADAH (prosiding, bundel konferensi) punya daftar rujukan
        // sangat panjang sehingga nyaris berdekatan dengan segalanya. Terukur
        // 2 Okt 2026: satu rekaman "Proceedings of the 43rd ACM SIGIR…" muncul
        // sebagai jembatan 29 klaster — jelas bukan temuan, melainkan artefak.
        // Ditandai, bukan dibuang diam-diam, supaya pembaca bisa menilainya.
        mencurigakan: refsSendiri.size > batasRujukanWajar,
      });
    }
  }

  return {
    jembatan: keluar.sort((a, b) => (b.klasterLain - a.klasterLain) || (b.derajat - a.derajat) || a.id.localeCompare(b.id)),
    klasterKuat: ketat,
    ambangKuat, minBersamaKuat, ambangLemah, minBersamaLemah, batasRujukanWajar,
  };
}

/**
 * Apakah peta ini akan BERGUNA, atau hanya menghasilkan keluaran kosong?
 *
 * Kejadian nyata 2 Okt 2026: peta dijalankan pada artikel jurnal Indonesia yang
 * baru terbit — OpenAlex mencatat **0 rujukan** untuk benihnya dan hanya **2
 * pengutip**. Seluruh bagian peta kosong, dan keluaran yang hanya berisi "0"
 * membuat pemakainya mengira alatnya rusak.
 *
 * Dua syarat, dan syarat kedua penting: kalau benih TIDAK punya rujukan tetapi
 * kandidatnya banyak, pengelompokan ANTAR KANDIDAT tetap bermakna — yang hilang
 * hanya kedekatan ke benih. Jadi peta baru disebut tidak berguna bila rujukan
 * benih kosong **dan** kandidatnya juga sedikit.
 */
export function petaBerguna({ refBenih = 0, kandidat = 0, minKandidat = 5 } = {}) {
  if (refBenih > 0) return { berguna: true };
  if (kandidat >= minKandidat) return { berguna: true };
  return { berguna: false, refBenih, kandidat, minKandidat };
}

/** Ringkasan angka satu klaster, untuk dilaporkan tanpa membanjiri keluaran. */
export function ringkasKlaster(works, klaster) {
  const per = new Map((works ?? []).map((w) => [idPendek(w?.id), w]));
  const anggota = klaster.map((id) => per.get(id)).filter(Boolean);
  const sitasi = anggota.map((w) => Number(w?.cited_by_count) || 0);
  const tahun = anggota.map((w) => Number(w?.publication_year) || 0).filter((t) => t > 1500);
  return {
    ukuran: klaster.length,
    tahunMin: tahun.length ? Math.min(...tahun) : null,
    tahunMaks: tahun.length ? Math.max(...tahun) : null,
    sitasiTotal: sitasi.reduce((a, b) => a + b, 0),
    teratas: anggota
      .slice()
      .sort((a, b) => (Number(b?.cited_by_count) || 0) - (Number(a?.cited_by_count) || 0))
      .slice(0, 5),
  };
}
