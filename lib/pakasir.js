'use strict';
const axios = require('axios');
const config = require('../config');

const client = axios.create({ baseURL: config.pakasir.baseUrl, timeout: 15000 });

async function createPayment(method, orderId, amount) {
  const { data } = await client.post(`/api/transactioncreate/${method}`, {
    project: config.pakasir.slug, order_id: orderId, amount, api_key: config.pakasir.apiKey,
  });
  return data.payment;
}

async function detailPayment(orderId, amount) {
  const { data } = await client.get('/api/transactiondetail', {
    params: { project: config.pakasir.slug, order_id: orderId, amount, api_key: config.pakasir.apiKey },
  });
  return data.transaction;
}

async function cancelPayment(orderId, amount) {
  const { data } = await client.post('/api/transactioncancel', {
    project: config.pakasir.slug, order_id: orderId, amount, api_key: config.pakasir.apiKey,
  });
  return data;
}

const METHODS = ['qris', 'bri_va', 'bni_va', 'cimb_niaga_va', 'permata_va', 'maybank_va', 'sampoerna_va', 'bnc_va', 'atm_bersama_va', 'artha_graha_va'];

module.exports = { createPayment, detailPayment, cancelPayment, METHODS };
