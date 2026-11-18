'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateEvent, validateHypothesis } = require('./validate.cjs');

const event = {
  id: 'evt_0142',
  ts: '2026-11-18T14:02:11.320Z',
  source: 'log',
  service: 'checkout-api',
  severity: 'error',
  ref: 'checkout.jsonl#L12',
  text: 'Quoted total disagreed with cart quantity',
};

const hypothesis = {
  id: 'hyp_1',
  summary: 'The subtotal refactor stopped accounting for quantity',
  confidence: 0.78,
  evidence_ids: ['evt_0098', 'evt_0142'],
  unverified_assumptions: [],
  suspect_files: ['fixtures/checkout-api/quote.cjs'],
};

test('Event accepts minimal and enriched records', () => {
  assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
  assert.deepEqual(validateEvent({
    ...event,
    ts: '2024-02-29T00:00:00Z',
    signature: 'QuoteTotalMismatch',
    trace_id: 'abc123',
  }), { valid: true, errors: [] });
});

test('Event requires a source reference and rejects unknown properties', () => {
  const { ref, ...withoutRef } = event;
  assert.deepEqual(validateEvent({ ...withoutRef, extra: true }), {
    valid: false,
    errors: ['$.ref: is required', '$.extra: is not allowed'],
  });
  assert.equal(validateEvent({ ...event, ref: '' }).valid, false);
});

test('Event rejects invalid enums and optional field types', () => {
  const result = validateEvent({ ...event, source: 'other', severity: 'urgent', trace_id: 123 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.split(':')[0]), [
    '$.source', '$.severity', '$.trace_id',
  ]);
});

test('Event rejects malformed and impossible timestamps', () => {
  for (const ts of [
    '2026-02-29T14:02:11Z',
    '2026-04-31T14:02:11Z',
    '2026-11-18T24:00:00Z',
    '2026-11-18T14:02:11+00:00',
    '2026-11-18',
    '2026-11-18T14:02:11Z\n',
  ]) {
    const result = validateEvent({ ...event, ts });
    assert.equal(result.valid, false, JSON.stringify(ts));
    assert.match(result.errors[0], /^\$\.ts:/);
  }
});

test('Hypothesis accepts valid records, including confidence endpoints', () => {
  for (const confidence of [0, hypothesis.confidence, 1]) {
    assert.deepEqual(validateHypothesis({ ...hypothesis, confidence }), { valid: true, errors: [] });
  }
});

test('Hypothesis rejects invalid confidence without coercing types', () => {
  for (const confidence of [-0.01, 1.01, '0.5', NaN, Infinity]) {
    const result = validateHypothesis({ ...hypothesis, confidence });
    assert.equal(result.valid, false, String(confidence));
    assert.match(result.errors[0], /^\$\.confidence:/);
  }
});

test('Hypothesis requires at least one unique, nonempty evidence ID', () => {
  const { evidence_ids, ...withoutEvidence } = hypothesis;
  assert.deepEqual(validateHypothesis(withoutEvidence).errors, ['$.evidence_ids: is required']);
  for (const ids of [[], ['evt_0142', 'evt_0142'], [''], [142], 'evt_0142']) {
    const result = validateHypothesis({ ...hypothesis, evidence_ids: ids });
    assert.equal(result.valid, false, JSON.stringify(ids));
    assert.match(result.errors[0], /^\$\.evidence_ids(?:\[0\])?:/);
  }
});

test('Hypothesis requires typed assumption and suspect-file lists', () => {
  const { suspect_files, ...withoutFiles } = hypothesis;
  assert.deepEqual(validateHypothesis({
    ...withoutFiles, unverified_assumptions: [false], extra: true,
  }), {
    valid: false,
    errors: [
      '$.suspect_files: is required',
      '$.unverified_assumptions[0]: must be of type string',
      '$.extra: is not allowed',
    ],
  });
});

test('both validators reject non-object inputs', () => {
  for (const validate of [validateEvent, validateHypothesis]) {
    for (const value of [null, [], 'record']) {
      assert.deepEqual(validate(value), { valid: false, errors: ['$: must be of type object'] });
    }
  }
});
