// lib/cache.js — cache pencarian lokal yang BERBATAS (semangat issue #94/#140).
//
// Prinsip yang menentukan seluruh rancangan berkas ini:
//
//   1. **Kegagalan TIDAK PERNAH disimpan.** Kalau sebuah sumber gagal, menyimpan
//      kegagalannya berarti kegagalan sesaat itu "menular" selama TTL — dan
//      pengguna akan melihat "sumber mati" padahal sudah pulih. Yang di-cache
//      hanya jawaban yang benar-benar berhasil.
//   2. **Kunci TIDAK PERNAH memuat kredensial.** Kunci dibentuk dari
//      sumber+kueri+opsi saja. Kalau kunci memuat kunci API, berkas cache di
//      disk menjadi tempat rahasia bocor — dan berkas itu kita tulis dengan
//      tangan sendiri.
//   3. **Sumber ber-kunci WAJIB dilewati** (sama seperti aturan upstream).
//   4. **Selalu bisa diperiksa.** Setiap pemakaian cache DILAPORKAN ke pengguna
//      beserta umurnya, dan ada `paksa_ulang`. Cache yang tidak terlihat adalah
//      cache yang menyesatkan.
//   5. **Berbatas**: jumlah entri DAN ukuran byte. Lewat batas -> yang paling
//      lama dipakai dibuang lebih dulu.
//
// Berkasnya satu: `<akar>/cache-pencarian.json`, ditulis ATOMIK (.part -> rename)
// supaya mati di tengah tulis tidak meninggalkan JSON separuh yang membuat
// seluruh cache tidak terbaca.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const TTL_BAWAAN_MS = 30 * 60 * 1000;
export const MAKS_ENTRI_BAWAAN = 200;
export const MAKS_BYTE_BAWAAN = 2 * 1024 * 1024;

/**
 * Kunci cache: sumber + kueri + opsi yang MEMENGARUHI hasil. Disengaja hanya
 * menerima nilai primitif, dan `email`/`apiKey` TIDAK ikut (lihat prinsip 2).
 */
export function kunciCache(id, query, { rows, minSitasi = null, jenis = null } = {}) {
  const bahan = JSON.stringify({
    id,
    q: String(query ?? '').trim().toLowerCase(),
    rows: Number(rows) || null,
    minSitasi: minSitasi ?? null,
    jenis: Array.isArray(jenis) ? [...jenis].sort() : null,
  });
  return createHash('sha256').update(bahan).digest('hex').slice(0, 32);
}

/** Apakah sumber ini BOLEH di-cache? Sumber ber-kunci wajib dilewati. */
export function bolehDiCache(sumber) {
  if (!sumber) return false;
  const credit = String(sumber.credit ?? '');
  if (/WAJIB/i.test(credit)) return false;
  // Sumber ber-input DOI tidak di-cache: pemanggilnya jarang, dan hasilnya
  // bergantung pada DOI yang sudah spesifik.
  if (sumber.input === 'doi') return false;
  return true;
}

export function buatCache({ berkas, ttlMs = TTL_BAWAAN_MS, maksEntri = MAKS_ENTRI_BAWAAN, maksByte = MAKS_BYTE_BAWAAN, sekarang = () => Date.now() } = {}) {
  const baca = () => {
    if (!existsSync(berkas)) return { versi: 1, entri: {} };
    try {
      const j = JSON.parse(readFileSync(berkas, 'utf8'));
      if (!j || typeof j !== 'object' || typeof j.entri !== 'object' || j.entri === null) return { versi: 1, entri: {} };
      return j;
    } catch {
      // Berkas rusak BUKAN alasan mati: cache adalah percepatan, bukan sumber
      // kebenaran. Buang lalu mulai bersih.
      return { versi: 1, entri: {} };
    }
  };

  const tulis = (isi) => {
    try {
      mkdirSync(dirname(berkas), { recursive: true });
      const sementara = `${berkas}.part`;
      writeFileSync(sementara, JSON.stringify(isi));
      renameSync(sementara, berkas);
      return true;
    } catch {
      return false;
    }
  };

  /** Buang entri kadaluarsa + pelihara batas entri dan byte. */
  const rapikan = (isi) => {
    const batas = sekarang() - ttlMs;
    for (const [k, v] of Object.entries(isi.entri)) {
      if (!v || typeof v.dipakai !== 'number' || v.dipakai < batas) delete isi.entri[k];
    }
    let kunci = Object.keys(isi.entri);
    while (kunci.length > maksEntri) {
      const palingTua = kunci.reduce((a, b) => (isi.entri[a].dipakai <= isi.entri[b].dipakai ? a : b));
      delete isi.entri[palingTua];
      kunci = Object.keys(isi.entri);
    }
    let ukuran = Buffer.byteLength(JSON.stringify(isi));
    while (ukuran > maksByte && kunci.length > 0) {
      const palingTua = kunci.reduce((a, b) => (isi.entri[a].dipakai <= isi.entri[b].dipakai ? a : b));
      delete isi.entri[palingTua];
      kunci = Object.keys(isi.entri);
      ukuran = Buffer.byteLength(JSON.stringify(isi));
    }
    return isi;
  };

  return {
    berkas,
    ttlMs,
    /** Ambil dari cache. Mengembalikan null bila tidak ada / kadaluarsa. */
    ambil(kunci) {
      const isi = baca();
      const v = isi.entri?.[kunci];
      if (!v || typeof v.dipakai !== 'number') return null;
      const umur = sekarang() - v.dipakai;
      if (umur > ttlMs) return null;
      return { nilai: v.nilai, umurMs: umur, disimpan: v.dipakai };
    },
    /** Simpan HANYA yang berhasil. `nilai` wajib ada dan bukan null. */
    simpan(kunci, nilai, { jumlah = null } = {}) {
      if (nilai === null || nilai === undefined) return false;
      const isi = baca();
      isi.entri[kunci] = { dipakai: sekarang(), jumlah, nilai };
      return tulis(rapikan(isi));
    },
    /** Hapus SELURUH cache. */
    bersihkan() {
      try {
        if (existsSync(berkas)) unlinkSync(berkas);
        return true;
      } catch {
        return false;
      }
    },
    /** Buang HANYA yang kadaluarsa; kembalikan berapa yang dibuang. */
    buangKadaluarsa() {
      const isi = baca();
      const sebelum = Object.keys(isi.entri ?? {}).length;
      tulis(rapikan(isi));
      const sesudah = Object.keys(rapikan(baca()).entri ?? {}).length;
      return Math.max(0, sebelum - sesudah);
    },
    status() {
      const isi = baca();
      const entri = Object.entries(isi.entri ?? {});
      const batas = sekarang() - ttlMs;
      const sah = entri.filter(([, v]) => v?.dipakai >= batas);
      return {
        berkas,
        ada: existsSync(berkas),
        byte: existsSync(berkas) ? statSync(berkas).size : 0,
        ttlMs,
        maksEntri,
        maksByte,
        jumlah: entri.length,
        jumlahSah: sah.length,
        tertuaMs: sah.length ? sekarang() - Math.min(...sah.map(([, v]) => v.dipakai)) : null,
        terbaruMs: sah.length ? sekarang() - Math.max(...sah.map(([, v]) => v.dipakai)) : null,
      };
    },
  };
}

/** Jalur bawaan berkas cache di dalam akar perpustakaan. */
export function berkasCacheBawaan(akar) {
  return join(akar, 'cache-pencarian.json');
}