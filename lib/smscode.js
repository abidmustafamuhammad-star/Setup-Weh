'use strict';
const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.smscode.baseUrl,
  timeout: 15000,
  headers: { Authorization: `Bearer ${config.smscode.apiToken}` },
});

function unwrap(promise) {
  return promise
    .then(r => r.data)
    .catch(err => {
      const data = err.response?.data;
      if (data && data.success === false) {
        const e = new Error(data.error?.message || 'Server API error');
        e.code = data.error?.code;
        e.status = err.response.status;
        e.details = data.error?.details;
        throw e;
      }
      const e = new Error(err.message || 'Server network error');
      e.code = 'NETWORK_ERROR';
      throw e;
    });
}

module.exports = {
  getCountries: () => unwrap(client.get('/catalog/countries')),
  getServices: (countryId) => unwrap(client.get('/catalog/services', { params: countryId ? { country_id: countryId } : {} })),
  getProducts: (params) => unwrap(client.get('/catalog/products', { params })),
  getBalance: () => unwrap(client.get('/balance')),
  listOrders: (params) => unwrap(client.get('/orders', { params })),
  getOrder: (id) => unwrap(client.get(`/orders/${id}`)),
  getActiveOrders: () => unwrap(client.get('/orders/active')),
  createOrder: (body, idempotencyKey) => unwrap(client.post('/orders/create', body, {
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  })),
  cancelOrder: (id) => unwrap(client.post('/orders/cancel', { id })),
  finishOrder: (id) => unwrap(client.post('/orders/finish', { id })),
  resendOrder: (id) => unwrap(client.post('/orders/resend', { id })),
};
