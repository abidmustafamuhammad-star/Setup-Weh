'use strict';
const { MongoClient } = require('mongodb');
const config = require('../config');

let cachedClient = null;
let cachedDb = null;
let indexesEnsured = false;

async function ensureIndexes(db) {
  if (indexesEnsured) return;
  try {
    await Promise.all([
      db.collection('users').createIndex({ username: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ token: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
      db.collection('deposits').createIndex({ invoice: 1 }, { unique: true }),
      db.collection('webhook_logs').createIndex({ source: 1, order_id: 1 }, { unique: true }),
      db.collection('otp_orders').createIndex({ user_id: 1, created_at: -1 }),
      db.collection('otp_orders').createIndex({ status: 1, expires_at: 1 }),
      db.collection('otp_orders_expired_log').createIndex({ user_id: 1, archived_at: -1 }),
    ]);
  } catch (e) {
    console.error('[db] ensureIndexes failed:', e.message);
  }
  indexesEnsured = true;
}

async function getDb() {
  if (cachedDb) return cachedDb;

  if (!cachedClient) {
    cachedClient = new MongoClient(config.mongo.uri, {
      maxPoolSize: 10,
    });
    await cachedClient.connect();
  }

  cachedDb = cachedClient.db(config.mongo.dbName);
  await ensureIndexes(cachedDb);
  return cachedDb;
}

module.exports = { getDb };
