'use strict';

// PERBAIKAN: rate limiter sebelumnya pakai `new Map()` in-memory. Di Vercel (serverless),
// tiap cold start / instance paralel punya memory sendiri-sendiri, jadi limitnya gampang
// "reset" begitu request kena instance baru — proteksi brute-force jadi nyaris tidak efektif.
// Versi ini atomik lewat findOneAndUpdate di MongoDB, konsisten di semua instance.
//
// Window otomatis expired lewat TTL index di collection `rate_limits` (lihat lib/db.js).

async function hit(db, key, max, windowMs) {
  const now = new Date();
  const col = db.collection('rate_limits');

  // Coba increment window yang masih berlaku.
  const existing = await col.findOneAndUpdate(
    { _id: key, resetAt: { $gt: now } },
    { $inc: { count: 1 } },
    { returnDocument: 'after' }
  );
  if (existing) {
    return { count: existing.count, resetAt: existing.resetAt, limited: existing.count > max };
  }

  // Belum ada window aktif — mulai window baru (reset otomatis kalau window lama sudah expired).
  const resetAt = new Date(now.getTime() + windowMs);
  try {
    await col.updateOne({ _id: key }, { $set: { count: 1, resetAt } }, { upsert: true });
    return { count: 1, resetAt, limited: false };
  } catch (e) {
    if (e.code === 11000) {
      // Request paralel lain menang race membuat window duluan — increment saja punya dia.
      const doc = await col.findOneAndUpdate(
        { _id: key },
        { $inc: { count: 1 } },
        { returnDocument: 'after' }
      );
      return { count: doc.count, resetAt: doc.resetAt, limited: doc.count > max };
    }
    throw e;
  }
}

module.exports = { hit };
