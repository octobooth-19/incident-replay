'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { quote } = require('./quote.cjs');

test('two $25 items qualify for free shipping at the $50 threshold', () => {
  assert.deepEqual(quote([{ unitPriceCents: 2500, quantity: 2 }]), {
    subtotalCents: 5000,
    shippingCents: 0,
    totalCents: 5000,
  });
});
