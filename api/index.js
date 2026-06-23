'use strict';
const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');

const config = require('../config');
const { getDb } = require('../lib/db');
const { genToken, sanitize, formatRp, getIp, applyMarkup, log } = require('../lib/helpers');
const { authMiddleware, adminMiddleware } = require('../lib/auth');
const smscode = require('../lib/smscode');
const pakasir = require('../lib/pakasir');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '15kb' }));
app.use(express.urlencoded({ extended: true, limit: '15kb' }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// static assets (css/js) — halaman HTML tetap di-serve manual via res.sendFile di bawah
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// best-effort in-memory rate limit (per warm instance)
const rateStore = new Map();
app.use('/api/', (req, res, next) => {
  const ip = getIp(req);
  const now = Date.now();
  const rec = rateStore.get(ip);
  if (!rec || now > rec.resetAt) { rateStore.set(ip, { count: 1, resetAt: now + config.security.rateLimitWindow }); return next(); }
  if (rec.count >= config.security.rateLimitMax) return res.status(429).json({ success: false, error: 'Terlalu banyak request. Coba lagi sebentar.' });
  rec.count++; next();
});

async function auditLog(db, userId, action, details, ip, status = 'success') {
  try { await db.collection('audit_logs').insertOne({ user_id: userId || null, action, details, ip_address: ip, status, created_at: new Date() }); }
  catch (e) { log.error('audit', e.message); }
}

async function getSettings(db) {
  let s = await db.collection('settings').findOne({ _id: 'global' });
  if (!s) {
    s = {
      _id: 'global',
      markup_percent: config.app.defaultMarkupPercent,
      min_deposit: config.app.minDeposit,
      max_deposit: config.app.maxDeposit,
      deposit_options: config.app.depositOptions,
      app_name: config.app.appName,
    };
    await db.collection('settings').insertOne(s);
  }
  return s;
}

async function processDeposit(invoice, amount, userId, source) {
  const db = await getDb();
  const dep = await db.collection('deposits').findOneAndUpdate(
    { invoice, status: 'pending' },
    { $set: { status: 'completed', webhook_received: true, completed_at: new Date(), updated_at: new Date() } },
    { returnDocument: 'after' }
  );
  if (!dep) return { skip: true };
  const updatedUser = await db.collection('users').findOneAndUpdate(
    { _id: dep.user_id },
    { $inc: { balance: dep.amount, total_deposit: dep.amount, total_tx: 1 } },
    { returnDocument: 'after' }
  );
  await auditLog(db, dep.user_id, 'deposit_completed', { invoice, amount: dep.amount, source }, null);
  return { success: true, balance: updatedUser?.balance };
}

// ============================================================
// AUTO-EXPIRE & AUTO-DELETE NOMOR VIRTUAL
// Begitu masa sewa (expires_at) lewat, order tidak lagi muncul
// sebagai "Kadaluarsa" — order langsung di-refund (jika belum)
// lalu diarsipkan ke koleksi log dan dihapus dari otp_orders,
// sehingga otomatis hilang dari semua daftar yang dilihat user.
// ============================================================
const EXPIRED_LOG_COLLECTION = 'otp_orders_expired_log';

async function expireSingleOrder(db, order) {
  // Lock atomik supaya order yang sama tidak diproses dua kali oleh request paralel (lazy check + cron bisa jalan bersamaan)
  const lock = await db.collection('otp_orders').findOneAndUpdate(
    { _id: order._id, status: { $in: ['ACTIVE', 'OTP_RECEIVED'] } },
    { $set: { status: 'EXPIRED', updated_at: new Date() } }
  );
  if (!lock) return null;

  let newBalance;
  let refunded = order.refund_status === 'refunded';
  if (order.refund_status === 'none') {
    const refundLock = await db.collection('otp_orders').findOneAndUpdate(
      { _id: order._id, refund_status: 'none' }, { $set: { refund_status: 'refunded' } }
    );
    if (refundLock) {
      const updatedUser = await db.collection('users').findOneAndUpdate(
        { _id: order.user_id }, { $inc: { balance: order.price, total_refund: order.price } }, { returnDocument: 'after' }
      );
      newBalance = updatedUser?.balance;
      refunded = true;
    }
  }

  try {
    await db.collection(EXPIRED_LOG_COLLECTION).insertOne({
      original_id: order._id, user_id: order.user_id, provider_order_id: order.provider_order_id,
      service_name: order.service_name, country: order.country, phone_number: order.phone_number,
      base_price: order.base_price, price: order.price, status: 'EXPIRED', refund_status: 'refunded',
      created_at: order.created_at, archived_at: new Date(),
    });
  } catch (e) { log.error('archive expired order', e.message); }

  await db.collection('otp_orders').deleteOne({ _id: order._id });
  await auditLog(db, order.user_id, 'order_auto_expired_deleted', { order_id: order._id, price: order.price }, null);

  return { refunded, new_balance: newBalance };
}

// Lazy cleanup — dipanggil sebelum endpoint manapun menampilkan daftar order milik satu user,
// supaya nomor yang masa aktifnya sudah lewat langsung lenyap real-time saat user membuka dashboard/riwayat.
async function expireUserOrders(db, userId) {
  const due = await db.collection('otp_orders').find({
    user_id: userId, status: { $in: ['ACTIVE', 'OTP_RECEIVED'] }, expires_at: { $lte: new Date() },
  }).toArray();
  for (const o of due) { await expireSingleOrder(db, o).catch(e => log.error('expireUserOrders', e.message)); }
}

// Cleanup global — dipakai oleh endpoint cron, memproses SEMUA user sekaligus
// supaya penghapusan tetap berjalan walau tidak ada user yang sedang online.
async function expireAllOrdersGlobal(db, batchSize = 300) {
  const due = await db.collection('otp_orders').find({
    status: { $in: ['ACTIVE', 'OTP_RECEIVED'] }, expires_at: { $lte: new Date() },
  }).limit(batchSize).toArray();
  let expired = 0;
  for (const o of due) {
    const r = await expireSingleOrder(db, o).catch(e => { log.error('expireAllOrdersGlobal', e.message); return null; });
    if (r) expired++;
  }
  return { scanned: due.length, expired };
}

// ============================================================
// STATIC PAGES
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/main.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('/health', (req, res) => res.json({ ok: true }));

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  const db = await getDb();
  const ip = getIp(req);
  try {
    let { username, email, password } = req.body;
    username = sanitize(String(username || '')).toLowerCase();
    email = sanitize(String(email || '')).toLowerCase();
    password = String(password || '');

    if (!username || !email || !password) return res.status(400).json({ success: false, error: 'Semua field wajib diisi.' });
    if (!/^[a-z0-9_]{3,30}$/.test(username)) return res.status(400).json({ success: false, error: 'Username 3-30 karakter: huruf kecil, angka, underscore.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'Format email tidak valid.' });
    if (password.length < config.security.minPasswordLength) return res.status(400).json({ success: false, error: `Password minimal ${config.security.minPasswordLength} karakter.` });

    const existing = await db.collection('users').findOne({ $or: [{ username }, { email }] });
    if (existing) return res.status(409).json({ success: false, error: 'Username atau email sudah terdaftar.' });

    const password_hash = await bcrypt.hash(password, config.security.bcryptRounds);
    const userCount = await db.collection('users').countDocuments();
    const role = userCount === 0 ? 'admin' : 'user'; // user pertama otomatis jadi admin

    const doc = {
      username, email, password_hash, role, status: 'active',
      balance: 0, total_deposit: 0, total_order: 0, total_refund: 0, total_tx: 0,
      created_at: new Date(),
    };
    const r = await db.collection('users').insertOne(doc);
    await auditLog(db, r.insertedId, 'register', { username, email, role }, ip);
    res.json({ success: true, message: role === 'admin' ? 'Akun admin pertama berhasil dibuat! Silakan login.' : 'Registrasi berhasil! Silakan login.', role });
  } catch (e) {
    log.error('register', e.message);
    res.status(500).json({ success: false, error: 'Gagal mendaftar. Coba lagi.' });
  }
});

// Bootstrap atau promosikan akun jadi admin menggunakan ADMIN_SETUP_KEY (env var rahasia).
// Dipakai untuk membuat/menetapkan akun admin tanpa bergantung urutan registrasi user biasa.
app.post('/api/auth/admin-setup', async (req, res) => {
  const db = await getDb();
  const ip = getIp(req);
  try {
    if (!config.security.adminSetupKey) {
      return res.status(503).json({ success: false, error: 'ADMIN_SETUP_KEY belum diset di environment server.' });
    }
    const { setup_key, login } = req.body;
    if (!setup_key || setup_key !== config.security.adminSetupKey) {
      return res.status(403).json({ success: false, error: 'Setup key tidak valid.' });
    }
    const loginVal = sanitize(String(login || '')).toLowerCase();
    if (!loginVal) return res.status(400).json({ success: false, error: 'Username atau email wajib diisi.' });

    const isEmail = loginVal.includes('@');
    const user = await db.collection('users').findOneAndUpdate(
      { [isEmail ? 'email' : 'username']: loginVal },
      { $set: { role: 'admin' } },
      { returnDocument: 'after' }
    );
    if (!user) return res.status(404).json({ success: false, error: 'User tidak ditemukan. Daftar dulu lewat /api/auth/register.' });

    await auditLog(db, user._id, 'admin_setup_promote', { login: loginVal }, ip);
    res.json({ success: true, message: `Akun ${user.username} sekarang menjadi admin. Login seperti biasa dengan email/password.` });
  } catch (e) {
    log.error('admin-setup', e.message);
    res.status(500).json({ success: false, error: 'Gagal menjalankan admin setup.' });
  }
});

const loginAttempts = new Map();
app.post('/api/auth/login', async (req, res) => {
  const db = await getDb();
  const ip = getIp(req);
  try {
    const attempt = loginAttempts.get(ip);
    if (attempt?.until && Date.now() < attempt.until) {
      const wait = Math.ceil((attempt.until - Date.now()) / 60000);
      return res.status(429).json({ success: false, error: `Terlalu banyak percobaan. Coba lagi dalam ${wait} menit.` });
    }

    let { login, password, remember } = req.body;
    login = sanitize(String(login || '')).toLowerCase();
    password = String(password || '');
    remember = Boolean(remember);
    if (!login || !password) return res.status(400).json({ success: false, error: 'Username/email dan password wajib diisi.' });

    const isEmail = login.includes('@');
    const user = await db.collection('users').findOne({ [isEmail ? 'email' : 'username']: login });
    const valid = user && await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      const cur = loginAttempts.get(ip) || { count: 0, until: null };
      cur.count++;
      if (cur.count >= config.security.maxLoginAttempts) cur.until = Date.now() + config.security.lockoutDuration;
      loginAttempts.set(ip, cur);
      await auditLog(db, user?._id, 'login_failed', { login }, ip, 'failed');
      return res.status(401).json({ success: false, error: 'Username/email atau password salah.' });
    }
    if (user.status !== 'active') return res.status(403).json({ success: false, error: 'Akun ditangguhkan. Hubungi admin.' });
    loginAttempts.delete(ip);

    const token = genToken();
    const expiresAt = new Date(Date.now() + (remember ? config.server.cookieMaxAge : config.server.cookieMaxAgeShort));
    await db.collection('sessions').insertOne({ user_id: user._id, token, expires_at: expiresAt, ip_address: ip, user_agent: req.headers['user-agent'] || '', created_at: new Date() });

    res.cookie(config.server.sessionCookieName, token, {
      httpOnly: true, secure: config.server.secureCookie, sameSite: 'lax',
      maxAge: remember ? config.server.cookieMaxAge : config.server.cookieMaxAgeShort,
    });
    await auditLog(db, user._id, 'login', { login, remember }, ip);
    res.json({ success: true, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
  } catch (e) {
    log.error('login', e.message);
    res.status(500).json({ success: false, error: 'Gagal login. Coba lagi.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const db = await getDb();
    const token = req.cookies?.[config.server.sessionCookieName] || req.headers['x-session-token'];
    if (token) await db.collection('sessions').deleteOne({ token });
  } catch (e) {}
  res.clearCookie(config.server.sessionCookieName);
  res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    user: {
      id: u._id, username: u.username, email: u.email, role: u.role, status: u.status,
      balance: u.balance, total_deposit: u.total_deposit, total_order: u.total_order,
      total_refund: u.total_refund, total_tx: u.total_tx, created_at: u.created_at,
    },
  });
});

// ============================================================
// DASHBOARD & SETTINGS (public)
// ============================================================
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const u = req.user;
    await expireUserOrders(db, u._id);
    const recentOrders = await db.collection('otp_orders').find({ user_id: u._id }).sort({ created_at: -1 }).limit(5).toArray();
    const recentDeposits = await db.collection('deposits').find({ user_id: u._id }).sort({ created_at: -1 }).limit(5).toArray();
    res.json({
      success: true,
      stats: {
        balance: u.balance, total_deposit: u.total_deposit, total_order: u.total_order,
        total_refund: u.total_refund, total_tx: u.total_tx, joined: u.created_at, status: u.status, role: u.role,
      },
      recent_orders: recentOrders, recent_deposits: recentDeposits,
    });
  } catch (e) { log.error('dashboard', e.message); res.status(500).json({ success: false, error: 'Gagal memuat dashboard.' }); }
});

app.get('/api/settings/public', async (req, res) => {
  try {
    const db = await getDb();
    const s = await getSettings(db);
    res.json({ success: true, settings: { app_name: s.app_name, min_deposit: s.min_deposit, max_deposit: s.max_deposit, deposit_options: s.deposit_options } });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal memuat settings.' }); }
});

// ============================================================
// CATALOG (SMSCode.gg)
// ============================================================
app.get('/api/catalog/countries', authMiddleware, async (req, res) => {
  try { const r = await smscode.getCountries(); res.json({ success: true, data: r.data || [] }); }
  catch (e) { log.error('catalog countries', e.message); res.status(502).json({ success: false, error: 'Gagal mengambil daftar negara.' }); }
});

app.get('/api/catalog/services', authMiddleware, async (req, res) => {
  try { const r = await smscode.getServices(req.query.country_id); res.json({ success: true, data: r.data || [] }); }
  catch (e) { log.error('catalog services', e.message); res.status(502).json({ success: false, error: 'Gagal mengambil daftar layanan.' }); }
});

app.get('/api/catalog/products', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const settings = await getSettings(db);
    const { country_id, platform_id } = req.query;
    const r = await smscode.getProducts({ country_id, platform_id, limit: 200, sort: 'price_asc' });
    const data = (r.data || []).map(p => ({
      id: p.id, catalog_product_id: p.catalog_product_id, name: p.name,
      country_id: p.country_id, platform_id: p.platform_id, available: p.available,
      base_price: p.price, price: applyMarkup(p.price, settings.markup_percent), active: p.active,
    }));
    res.json({ success: true, data, meta: r.meta || {} });
  } catch (e) { log.error('catalog products', e.message); res.status(502).json({ success: false, error: 'Gagal mengambil katalog produk.' }); }
});

// ============================================================
// ORDER (beli nomor virtual)
// ============================================================
app.post('/api/order/create', authMiddleware, async (req, res) => {
  const db = req.db;
  const userId = req.user._id;
  const ip = getIp(req);

  try {
    await db.collection('order_locks').insertOne({ _id: userId, lockedAt: new Date() });
  } catch (e) {
    return res.status(409).json({ success: false, error: 'Pesanan sedang diproses. Tunggu sebentar.' });
  }

  try {
    const { product_id, catalog_product_id, country_id, platform_id, service_name, country_name } = req.body;
    if (!product_id && !catalog_product_id) return res.status(400).json({ success: false, error: 'Produk tidak valid.' });

    const settings = await getSettings(db);

    let basePrice = null;
    try {
      const prodRes = await smscode.getProducts({ country_id, platform_id, limit: 500 });
      const match = (prodRes.data || []).find(p => String(p.id) === String(product_id) || String(p.catalog_product_id) === String(catalog_product_id));
      if (match) basePrice = match.price;
    } catch (e) {}

    if (basePrice == null) return res.status(409).json({ success: false, error: 'Harga produk berubah atau stok habis. Refresh dan coba lagi.' });

    const salePrice = applyMarkup(basePrice, settings.markup_percent);
    if (req.user.balance < salePrice) return res.status(400).json({ success: false, error: `Saldo tidak cukup. Saldo: ${formatRp(req.user.balance)}, Harga: ${formatRp(salePrice)}` });

    const idemKey = crypto.randomUUID();
    const body = catalog_product_id
      ? { catalog_product_id: Number(catalog_product_id), max_price: basePrice, policy: 'best_success', quantity: 1 }
      : { product_id: Number(product_id), max_price: basePrice, quantity: 1 };

    let providerResult;
    try {
      providerResult = await smscode.createOrder(body, idemKey);
    } catch (e) {
      const msgMap = {
        INSUFFICIENT_BALANCE: 'Saldo platform di Server tidak cukup. Tunggu beberapa saat nanti.',
        NO_OFFER_AVAILABLE: 'Stok nomor habis untuk produk ini. Coba produk lain.',
        PROVIDER_ERROR: 'Provider sedang gangguan. Coba beberapa saat lagi.',
        VALIDATION_ERROR: 'Data pesanan tidak valid.',
        RATE_LIMIT_EXCEEDED: 'Sistem sedang sibuk. Coba lagi sebentar.',
      };
      return res.status(502).json({ success: false, error: msgMap[e.code] || e.message || 'Gagal membuat pesanan ke provider.' });
    }

    const order = providerResult.data?.orders?.[0];
    if (!order) return res.status(502).json({ success: false, error: 'Tidak ada nomor tersedia. Coba lagi.' });

    const updatedUser = await db.collection('users').findOneAndUpdate(
      { _id: userId, balance: { $gte: salePrice } },
      { $inc: { balance: -salePrice, total_order: salePrice, total_tx: 1 } },
      { returnDocument: 'after' }
    );

    if (!updatedUser) {
      try { await smscode.cancelOrder(order.id); } catch (e) { log.error('compensating cancel failed', e.message); }
      return res.status(400).json({ success: false, error: 'Saldo tidak cukup (berubah saat proses). Pesanan dibatalkan otomatis, saldo aman.' });
    }

    const localOrder = {
      user_id: userId, provider_order_id: order.id, product_id: order.product_id, catalog_product_id: order.catalog_product_id,
      service_name: sanitize(service_name || ''), country: sanitize(country_name || ''), phone_number: order.phone_number,
      base_price: basePrice, price: salePrice, status: order.status || 'ACTIVE', otp_code: null, otp_received_at: null,
      expires_at: order.expires_at ? new Date(order.expires_at) : new Date(Date.now() + 20 * 60000),
      refund_status: 'none', created_at: new Date(), updated_at: new Date(),
    };
    const ins = await db.collection('otp_orders').insertOne(localOrder);
    await auditLog(db, userId, 'order_create', { order_id: ins.insertedId, provider_order_id: order.id, price: salePrice }, ip);

    res.json({ success: true, order: { _id: ins.insertedId, ...localOrder }, new_balance: updatedUser.balance });
  } catch (e) {
    log.error('order create', e.message);
    res.status(500).json({ success: false, error: 'Gagal membuat pesanan. Coba lagi.' });
  } finally {
    await db.collection('order_locks').deleteOne({ _id: userId }).catch(() => {});
  }
});

app.get('/api/order/:id/status', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    const order = await db.collection('otp_orders').findOne({ _id: new ObjectId(id), user_id: req.user._id });
    if (!order) return res.json({ success: true, deleted: true });

    // Aturan utama: begitu waktu sewa lewat, order langsung dihapus — tidak pernah ditampilkan sebagai "Kadaluarsa".
    if (order.expires_at && new Date(order.expires_at) <= new Date() && ['ACTIVE', 'OTP_RECEIVED'].includes(order.status)) {
      const ex = await expireSingleOrder(db, order);
      return res.json({ success: true, deleted: true, refunded: !!ex?.refunded, new_balance: ex?.new_balance });
    }

    if (['ACTIVE', 'OTP_RECEIVED'].includes(order.status)) {
      try {
        const r = await smscode.getOrder(order.provider_order_id);
        const d = r.data;

        if (d.status === 'EXPIRED') {
          const ex = await expireSingleOrder(db, order);
          return res.json({ success: true, deleted: true, refunded: !!ex?.refunded, new_balance: ex?.new_balance });
        }

        const updates = { updated_at: new Date() };
        if (d.status !== order.status) updates.status = d.status;
        if (d.otp_code && !order.otp_code) { updates.otp_code = d.otp_code; updates.otp_received_at = new Date(); }

        if (Object.keys(updates).length > 1) {
          await db.collection('otp_orders').updateOne({ _id: order._id }, { $set: updates });
          Object.assign(order, updates);
        }

        if (['CANCELED', 'FAILED'].includes(d.status) && order.refund_status === 'none') {
          const refundLock = await db.collection('otp_orders').findOneAndUpdate(
            { _id: order._id, refund_status: 'none' }, { $set: { refund_status: 'refunded' } }
          );
          if (refundLock) {
            const updatedUser = await db.collection('users').findOneAndUpdate(
              { _id: req.user._id }, { $inc: { balance: order.price, total_refund: order.price } }, { returnDocument: 'after' }
            );
            await auditLog(db, req.user._id, 'auto_refund', { order_id: order._id, amount: order.price }, getIp(req));
            order.new_balance = updatedUser?.balance;
          }
        }
      } catch (e) { log.warn('order poll error', e.message); }
    }
    res.json({ success: true, order });
  } catch (e) { log.error('order status', e.message); res.status(500).json({ success: false, error: 'Gagal memeriksa status.' }); }
});

app.post('/api/order/cancel', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { order_id } = req.body;
    if (!ObjectId.isValid(order_id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    const order = await db.collection('otp_orders').findOne({ _id: new ObjectId(order_id), user_id: req.user._id });
    if (!order) return res.status(404).json({ success: false, error: 'Order tidak ditemukan.' });
    if (order.status !== 'ACTIVE') return res.status(400).json({ success: false, error: 'Order tidak dapat dibatalkan.' });

    try {
      await smscode.cancelOrder(order.provider_order_id);
    } catch (e) {
      if (e.code === 'CANCEL_TOO_EARLY') return res.status(400).json({ success: false, error: 'Tunggu minimal 2 menit sebelum membatalkan order.' });
      log.warn('provider cancel error', e.message);
      return res.status(502).json({ success: false, error: 'Gagal membatalkan di provider. Coba lagi.' });
    }

    await db.collection('otp_orders').updateOne({ _id: order._id }, { $set: { status: 'CANCELED', updated_at: new Date() } });

    let newBalance = req.user.balance;
    if (order.refund_status === 'none') {
      const refundLock = await db.collection('otp_orders').findOneAndUpdate({ _id: order._id, refund_status: 'none' }, { $set: { refund_status: 'refunded' } });
      if (refundLock) {
        const updatedUser = await db.collection('users').findOneAndUpdate({ _id: req.user._id }, { $inc: { balance: order.price, total_refund: order.price } }, { returnDocument: 'after' });
        newBalance = updatedUser?.balance;
      }
    }
    await auditLog(db, req.user._id, 'order_cancel', { order_id: order._id }, getIp(req));
    res.json({ success: true, refunded: true, new_balance: newBalance });
  } catch (e) { log.error('order cancel', e.message); res.status(500).json({ success: false, error: 'Gagal membatalkan pesanan.' }); }
});

app.post('/api/order/finish', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { order_id } = req.body;
    if (!ObjectId.isValid(order_id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    const order = await db.collection('otp_orders').findOne({ _id: new ObjectId(order_id), user_id: req.user._id });
    if (!order) return res.status(404).json({ success: false, error: 'Order tidak ditemukan.' });
    try { await smscode.finishOrder(order.provider_order_id); } catch (e) { log.warn('finish provider error', e.message); }
    await db.collection('otp_orders').updateOne({ _id: order._id }, { $set: { status: 'COMPLETED', updated_at: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal menyelesaikan pesanan.' }); }
});

app.post('/api/order/resend', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { order_id } = req.body;
    if (!ObjectId.isValid(order_id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    const order = await db.collection('otp_orders').findOne({ _id: new ObjectId(order_id), user_id: req.user._id });
    if (!order) return res.status(404).json({ success: false, error: 'Order tidak ditemukan.' });
    const r = await smscode.resendOrder(order.provider_order_id);
    res.json({ success: true, resent: r.data?.resent || false });
  } catch (e) { res.status(502).json({ success: false, error: e.message || 'Gagal mengirim ulang SMS.' }); }
});

// ============================================================
// HISTORY
// ============================================================
app.get('/api/history/orders', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    await expireUserOrders(db, req.user._id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const filter = { user_id: req.user._id };
    if (req.query.status) filter.status = req.query.status.toUpperCase();
    const total = await db.collection('otp_orders').countDocuments(filter);
    const data = await db.collection('otp_orders').find(filter).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    res.json({ success: true, data, total, page, limit });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal mengambil riwayat.' }); }
});

app.get('/api/history/deposits', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const filter = { user_id: req.user._id };
    const total = await db.collection('deposits').countDocuments(filter);
    const data = await db.collection('deposits').find(filter).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    res.json({ success: true, data, total, page, limit });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal mengambil riwayat deposit.' }); }
});

// ============================================================
// DEPOSIT (Pakasir)
// ============================================================
app.post('/api/deposit/create', authMiddleware, async (req, res) => {
  const db = req.db;
  const userId = req.user._id;
  const ip = getIp(req);
  try {
    let { amount, payment_method } = req.body;
    amount = parseInt(amount);
    payment_method = payment_method || 'qris';
    if (!pakasir.METHODS.includes(payment_method)) return res.status(400).json({ success: false, error: 'Metode pembayaran tidak valid.' });

    const settings = await getSettings(db);
    if (isNaN(amount) || amount < settings.min_deposit) return res.status(400).json({ success: false, error: `Minimal deposit ${formatRp(settings.min_deposit)}.` });
    if (amount > settings.max_deposit) return res.status(400).json({ success: false, error: `Maksimal deposit ${formatRp(settings.max_deposit)}.` });

    const pendingCount = await db.collection('deposits').countDocuments({ user_id: userId, status: 'pending' });
    if (pendingCount >= 3) return res.status(400).json({ success: false, error: 'Maksimal 3 deposit pending sekaligus.' });

    const invoice = `INV${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    let payment;
    try {
      payment = await pakasir.createPayment(payment_method, invoice, amount);
    } catch (e) {
      log.error('pakasir create', e.response?.data || e.message);
      return res.status(502).json({ success: false, error: 'Gagal membuat transaksi pembayaran. Coba lagi.' });
    }

    await db.collection('deposits').insertOne({
      user_id: userId, invoice, amount, status: 'pending', payment_method,
      payment_number: payment.payment_number, fee: payment.fee, total_payment: payment.total_payment,
      expired_at: payment.expired_at, webhook_received: false, created_at: new Date(), updated_at: new Date(),
    });

    await auditLog(db, userId, 'deposit_create', { invoice, amount, payment_method }, ip);
    res.json({ success: true, invoice, amount, payment });
  } catch (e) {
    log.error('deposit create', e.message);
    res.status(500).json({ success: false, error: 'Gagal membuat deposit.' });
  }
});

app.get('/api/deposit/status/:invoice', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { invoice } = req.params;
    const deposit = await db.collection('deposits').findOne({ invoice, user_id: req.user._id });
    if (!deposit) return res.status(404).json({ success: false, error: 'Invoice tidak ditemukan.' });

    if (deposit.status === 'pending') {
      try {
        const tx = await pakasir.detailPayment(invoice, deposit.amount);
        if (tx?.status === 'completed' && !deposit.webhook_received) {
          await processDeposit(invoice, deposit.amount, deposit.user_id, 'manual_check');
        }
      } catch (e) { log.warn('deposit status check', e.message); }
    }
    const updated = await db.collection('deposits').findOne({ invoice });
    res.json({ success: true, deposit: updated });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal memeriksa status.' }); }
});

app.post('/api/deposit/cancel', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { invoice } = req.body;
    const deposit = await db.collection('deposits').findOne({ invoice, user_id: req.user._id });
    if (!deposit) return res.status(404).json({ success: false, error: 'Invoice tidak ditemukan.' });
    if (deposit.status !== 'pending') return res.status(400).json({ success: false, error: 'Deposit tidak dapat dibatalkan.' });
    try { await pakasir.cancelPayment(invoice, deposit.amount); } catch (e) { log.warn('pakasir cancel', e.message); }
    await db.collection('deposits').updateOne({ invoice }, { $set: { status: 'canceled', updated_at: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal membatalkan deposit.' }); }
});

// ============================================================
// WEBHOOK — PAKASIR
// ============================================================
app.post('/api/webhook/pakasir', async (req, res) => {
  const ip = getIp(req);
  try {
    const db = await getDb();
    const { amount, order_id, project, status } = req.body || {};
    if (!amount || !order_id || !project || !status) return res.status(400).json({ success: false, error: 'Invalid payload' });
    if (project !== config.pakasir.slug) return res.status(400).json({ success: false, error: 'Invalid project' });
    if (status !== 'completed') return res.json({ success: true, message: 'Status not completed, skipped' });

    try {
      await db.collection('webhook_logs').insertOne({ source: 'pakasir', order_id: String(order_id), payload: req.body, processed: false, created_at: new Date() });
    } catch (e) {
      if (e.code === 11000) return res.json({ success: true, message: 'Already processed' });
      throw e;
    }

    let verified = false;
    try {
      const tx = await pakasir.detailPayment(order_id, amount);
      verified = tx?.status === 'completed' && Number(tx.amount) === Number(amount);
    } catch (e) { log.warn('pakasir verify error', e.message); }

    const deposit = await db.collection('deposits').findOne({ invoice: order_id });
    if (!deposit) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (deposit.amount !== parseInt(amount)) return res.status(400).json({ success: false, error: 'Amount mismatch' });

    await processDeposit(order_id, parseInt(amount), deposit.user_id, 'webhook');
    await db.collection('webhook_logs').updateOne({ source: 'pakasir', order_id: String(order_id) }, { $set: { processed: true } });
    await auditLog(db, deposit.user_id, 'webhook_pakasir', { order_id, amount, verified }, ip);
    res.json({ success: true });
  } catch (e) {
    log.error('webhook pakasir', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ============================================================
// PROFILE
// ============================================================
app.get('/api/profile', authMiddleware, async (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    profile: {
      id: u._id, username: u.username, email: u.email, role: u.role, balance: u.balance,
      total_deposit: u.total_deposit, total_order: u.total_order, total_refund: u.total_refund,
      total_tx: u.total_tx, created_at: u.created_at, status: u.status,
    },
  });
});

// ============================================================
// ADMIN
// ============================================================
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const [userCount, orderCount, depositAgg, orderAgg, activeOrders] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('otp_orders').countDocuments(),
      db.collection('deposits').aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).toArray(),
      db.collection('otp_orders').aggregate([{ $match: { status: { $in: ['COMPLETED', 'OTP_RECEIVED'] } } }, { $group: { _id: null, total: { $sum: '$price' }, profit: { $sum: { $subtract: ['$price', '$base_price'] } } } }]).toArray(),
      db.collection('otp_orders').countDocuments({ status: 'ACTIVE' }),
    ]);
    let providerBalance = null;
    try { const b = await smscode.getBalance(); providerBalance = b.data; } catch (e) {}

    res.json({
      success: true,
      stats: {
        total_users: userCount, total_orders: orderCount, active_orders: activeOrders,
        total_deposit_revenue: depositAgg[0]?.total || 0,
        total_order_revenue: orderAgg[0]?.total || 0,
        total_profit: orderAgg[0]?.profit || 0,
        provider_balance: providerBalance,
      },
    });
  } catch (e) { log.error('admin stats', e.message); res.status(500).json({ success: false, error: 'Gagal memuat statistik.' }); }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const q = sanitize(req.query.q || '');
    const filter = q ? { $or: [{ username: { $regex: q, $options: 'i' } }, { email: { $regex: q, $options: 'i' } }] } : {};
    const total = await db.collection('users').countDocuments(filter);
    const users = await db.collection('users').find(filter, { projection: { password_hash: 0 } }).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    res.json({ success: true, data: users, total, page, limit });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal memuat daftar user.' }); }
});

app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    const user = await db.collection('users').findOne({ _id: new ObjectId(id) }, { projection: { password_hash: 0 } });
    if (!user) return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });
    const orders = await db.collection('otp_orders').find({ user_id: user._id }).sort({ created_at: -1 }).limit(20).toArray();
    const deposits = await db.collection('deposits').find({ user_id: user._id }).sort({ created_at: -1 }).limit(20).toArray();
    res.json({ success: true, user, orders, deposits });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal memuat detail user.' }); }
});

app.post('/api/admin/users/:id/balance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    let { amount, reason } = req.body;
    amount = parseInt(amount);
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    if (!amount || isNaN(amount) || amount === 0) return res.status(400).json({ success: false, error: 'Jumlah tidak valid.' });
    const uid = new ObjectId(id);
    const isDeduct = amount < 0;
    const filter = isDeduct ? { _id: uid, balance: { $gte: Math.abs(amount) } } : { _id: uid };
    const ures = await db.collection('users').findOneAndUpdate(filter, { $inc: { balance: amount } }, { returnDocument: 'after' });
    if (!ures) return res.status(400).json({ success: false, error: 'Saldo user tidak cukup untuk dikurangi.' });
    await auditLog(db, req.user._id, 'admin_balance_adjust', { target_user: id, amount, reason: sanitize(reason || ''), new_balance: ures.balance }, getIp(req));
    res.json({ success: true, new_balance: ures.balance });
  } catch (e) { log.error('admin balance adjust', e.message); res.status(500).json({ success: false, error: 'Gagal menyesuaikan saldo.' }); }
});

app.post('/api/admin/users/:id/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const { status } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ success: false, error: 'Status tidak valid.' });
    await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: { status } });
    await auditLog(db, req.user._id, 'admin_user_status', { target_user: id, status }, getIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal mengubah status user.' }); }
});

app.post('/api/admin/users/:id/role', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const { role } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID tidak valid.' });
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ success: false, error: 'Role tidak valid.' });
    if (String(req.user._id) === id && role === 'user') return res.status(400).json({ success: false, error: 'Tidak bisa menurunkan role diri sendiri.' });
    await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: { role } });
    await auditLog(db, req.user._id, 'admin_role_change', { target_user: id, role }, getIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal mengubah role.' }); }
});

app.get('/api/admin/orders', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const filter = {};
    if (req.query.status) filter.status = req.query.status.toUpperCase();
    const total = await db.collection('otp_orders').countDocuments(filter);
    const orders = await db.collection('otp_orders').aggregate([
      { $match: filter }, { $sort: { created_at: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { 'user.password_hash': 0 } },
    ]).toArray();
    res.json({ success: true, data: orders, total, page, limit });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal memuat daftar order.' }); }
});

app.get('/api/admin/deposits', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const total = await db.collection('deposits').countDocuments(filter);
    const deposits = await db.collection('deposits').aggregate([
      { $match: filter }, { $sort: { created_at: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { 'user.password_hash': 0 } },
    ]).toArray();
    res.json({ success: true, data: deposits, total, page, limit });
  } catch (e) { res.status(500).json({ success: false, error: 'Gagal memuat daftar deposit.' }); }
});

app.get('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try { res.json({ success: true, settings: await getSettings(req.db) }); }
  catch (e) { res.status(500).json({ success: false, error: 'Gagal memuat settings.' }); }
});

app.post('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = req.db;
    let { markup_percent, min_deposit, max_deposit, deposit_options, app_name } = req.body;
    const update = {};
    if (markup_percent !== undefined) {
      markup_percent = Number(markup_percent);
      if (isNaN(markup_percent) || markup_percent < 0) return res.status(400).json({ success: false, error: 'Markup tidak valid.' });
      update.markup_percent = markup_percent;
    }
    if (min_deposit !== undefined) update.min_deposit = parseInt(min_deposit);
    if (max_deposit !== undefined) update.max_deposit = parseInt(max_deposit);
    if (Array.isArray(deposit_options)) update.deposit_options = deposit_options.map(Number).filter(n => !isNaN(n));
    if (app_name) update.app_name = sanitize(app_name);
    await db.collection('settings').updateOne({ _id: 'global' }, { $set: update }, { upsert: true });
    await auditLog(db, req.user._id, 'admin_settings_update', update, getIp(req));
    res.json({ success: true, settings: await getSettings(db) });
  } catch (e) { log.error('admin settings update', e.message); res.status(500).json({ success: false, error: 'Gagal menyimpan settings.' }); }
});

app.get('/api/admin/provider-balance', authMiddleware, adminMiddleware, async (req, res) => {
  try { const r = await smscode.getBalance(); res.json({ success: true, balance: r.data }); }
  catch (e) { res.status(502).json({ success: false, error: 'Gagal mengambil saldo provider.' }); }
});

// ============================================================
// CRON — pembersihan nomor virtual kadaluarsa secara global
// Lindungi dengan header x-cron-secret / ?secret= yang harus sama dengan env CRON_SECRET.
// Dipanggil otomatis oleh Vercel Cron (vercel.json) dan/atau scheduler eksternal.
// ============================================================
app.all('/api/cron/expire-orders', async (req, res) => {
  try {
    const secret = req.headers['x-cron-secret'] || req.query.secret || (req.headers['authorization'] || '').replace('Bearer ', '');
    if (!config.security.cronSecret || secret !== config.security.cronSecret) {
      return res.status(401).json({ success: false, error: 'Unauthorized.' });
    }
    const db = await getDb();
    const result = await expireAllOrdersGlobal(db);
    res.json({ success: true, ...result });
  } catch (e) { log.error('cron expire-orders', e.message); res.status(500).json({ success: false, error: 'Gagal menjalankan cleanup.' }); }
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan.' }));
app.use((err, req, res, next) => { log.error('Unhandled error:', err.message); res.status(500).json({ success: false, error: 'Kesalahan server internal.' }); });

if (require.main === module) {
  app.listen(config.server.port, () => log.info(`Running on port ${config.server.port}`));
}
module.exports = app;
