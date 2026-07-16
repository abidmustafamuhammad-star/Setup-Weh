'use strict';
const crypto = require('crypto');
const config = require('./../config');

const genToken = () => crypto.randomBytes(config.security.sessionTokenLength).toString('hex');
const sanitize = (s) => (typeof s === 'string' ? s.replace(/[<>"'`]/g, '').trim() : s);
const formatRp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

// PERBAIKAN: sebelumnya manual-parse header x-forwarded-for tanpa memvalidasi
// apakah request benar-benar lewat proxy tepercaya (gampang dipalsukan oleh client).
// Express sudah tahu cara ini lewat `app.set('trust proxy', 1)` di api/index.js —
// req.ip otomatis memvalidasi & mengambil IP asli dari chain proxy yang benar.
const getIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

// Round sale price up to nearest 100 IDR for clean pricing
function applyMarkup(basePrice, markupPercent) {
  const raw = Number(basePrice) * (1 + (Number(markupPercent) || 0) / 100);
  return Math.ceil(raw / 100) * 100;
}

// PERBAIKAN XSS (defense-in-depth): gunakan ini saat merender string yang berasal
// dari input pengguna ke dalam innerHTML di frontend (username, email, service_name, dll).
// sanitize() di atas hanya strip karakter saat INPUT masuk — escapeHtml() untuk saat RENDER.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// PERBAIKAN: perbandingan string biasa (===, !==) untuk secret (ADMIN_SETUP_KEY, CRON_SECRET)
// bisa bocor lewat timing attack (waktu compare beda tergantung berapa karakter awal yang cocok).
// crypto.timingSafeEqual butuh panjang buffer yang sama, jadi kita tangani itu tanpa
// membocorkan informasi panjang lewat early-return.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // tetap "bayar" waktu compare agar tidak ada shortcut
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const log = {
  info: (...a) => console.log(`[${new Date().toISOString()}] INFO`, ...a),
  warn: (...a) => console.warn(`[${new Date().toISOString()}] WARN`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] ERROR`, ...a),
};

module.exports = { genToken, sanitize, formatRp, getIp, applyMarkup, escapeHtml, safeEqual, log };
