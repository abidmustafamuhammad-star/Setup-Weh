'use strict';
const { getDb } = require('./db');
const config = require('../config');

async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies?.[config.server.sessionCookieName] || req.headers['x-session-token'];
    if (!token) return res.status(401).json({ success: false, error: 'Sesi tidak ditemukan. Silakan login.' });

    const db = await getDb();
    const session = await db.collection('sessions').findOne({ token, expires_at: { $gt: new Date() } });
    if (!session) return res.status(401).json({ success: false, error: 'Sesi tidak valid atau sudah berakhir.' });

    const user = await db.collection('users').findOne({ _id: session.user_id });
    if (!user) return res.status(401).json({ success: false, error: 'Akun tidak ditemukan.' });
    if (user.status !== 'active') return res.status(403).json({ success: false, error: 'Akun ditangguhkan.' });

    req.user = user;
    req.session = session;
    req.db = db;
    next();
  } catch (e) {
    console.error('authMiddleware', e.message);
    res.status(500).json({ success: false, error: 'Kesalahan server.' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ success: false, error: 'Akses ditolak. Khusus admin.' });
  next();
}

module.exports = { authMiddleware, adminMiddleware };
