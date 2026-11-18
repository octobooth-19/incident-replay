'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { quote } = require('./quote.cjs');

test('a single $25 item costs $30 with shipping', () => {
  assert.deepEqual(quote([{ unitPriceCents: 2500, quantity: 1 }]), {
    subtotalCents: 2500,
    shippingCents: 500,
    totalCents: 3000,
  });
});
