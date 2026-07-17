'use strict';
if (process.env.VERCEL !== '1') {
  try { require('dotenv').config(); } catch (e) {}
}

module.exports = {
  server: {
    port: process.env.PORT || 3000,
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    sessionCookieName: 'session',
    cookieMaxAge: 7 * 24 * 60 * 60 * 1000,
    cookieMaxAgeShort: 24 * 60 * 60 * 1000,
    secureCookie: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production',
  },
  mongo: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    dbName: process.env.MONGODB_DB || 'nokosotp',
  },
  // BARU: sebelumnya tidak ada sama sekali, padahal api/index.js memakai
  // config.cors.origins untuk whitelist CORS -> menyebabkan TypeError saat
  // module di-load ("Cannot read properties of undefined (reading 'origins')"),
  // yang membuat seluruh app crash di Vercel (cold start gagal untuk semua request).
  cors: {
    // Daftar origin tambahan yang diizinkan, dipisah koma via env CORS_ORIGINS.
    // Contoh: CORS_ORIGINS=https://receotp.my.id,https://www.receotp.my.id
    origins: (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  smscode: {
    apiToken: process.env.SMSCODE_API_TOKEN || '',
    baseUrl: 'https://api.smscode.gg/v1',
  },
  pakasir: {
    slug: process.env.PAKASIR_SLUG || '',
    apiKey: process.env.PAKASIR_API_KEY || '',
    baseUrl: 'https://app.pakasir.com',
  },
  security: {
    bcryptRounds: 10,
    maxLoginAttempts: 5,
    lockoutDuration: 15 * 60 * 1000,
    sessionTokenLength: 48,
    minPasswordLength: 8,
    rateLimitWindow: 60 * 1000,
    rateLimitMax: 150,
    adminSetupKey: process.env.ADMIN_SETUP_KEY || '',
    cronSecret: process.env.CRON_SECRET || '',
  },
  app: {
    appName: process.env.APP_NAME || 'ReceOTP',
    minDeposit: 1000,
    maxDeposit: 10_000_000,
    depositOptions: [10000, 25000, 50000, 100000, 250000],
    defaultMarkupPercent: 15,
  },
};
