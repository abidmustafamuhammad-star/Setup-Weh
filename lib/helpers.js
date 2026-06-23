'use strict';
const crypto = require('crypto');
const config = require('./../config');

const genToken = () => crypto.randomBytes(config.security.sessionTokenLength).toString('hex');
const sanitize = (s) => (typeof s === 'string' ? s.replace(/[<>"'`]/g, '').trim() : s);
const formatRp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const getIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

// Round sale price up to nearest 100 IDR for clean pricing
function applyMarkup(basePrice, markupPercent) {
  const raw = Number(basePrice) * (1 + (Number(markupPercent) || 0) / 100);
  return Math.ceil(raw / 100) * 100;
}

const log = {
  info: (...a) => console.log(`[${new Date().toISOString()}] INFO`, ...a),
  warn: (...a) => console.warn(`[${new Date().toISOString()}] WARN`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] ERROR`, ...a),
};

module.exports = { genToken, sanitize, formatRp, getIp, applyMarkup, log };
