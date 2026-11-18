'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { buildAnalysisPrompt, validateAnalysisResponse } = require('./analyze.cjs');
const { finishEvents } = require('../collectors/event.cjs');
const { correlateEvents } = require('./correlate.cjs');

const events = [
  { id: 'quote-deploy', ts: '2026-11-18T13:00:30.000Z', source: 'deploy', service: 'checkout-api',
    severity: 'info', ref: 'deploy:1', text: 'Checkout deployed.' },
  { id: 'quote-error', ts: '2026-11-18T13:01:00.000Z', source: 'log', service: 'checkout-api',
    severity: 'error', ref: 'checkout.log:1', text: 'Quote failed.\n  at quote (src/quote.js:4:2)' },
];
const fixture = (name) => readFileSync(join(__dirname, '../fixtures/analysis', name), 'utf8');

test('replays a saved checkout response against its golden result without a model', () => {
  const prompt = buildAnalysisPrompt(correlateEvents(events).events);
  assert.deepEqual(JSON.parse(prompt.user), { events });
  assert.match(prompt.system, /untrusted evidence/);
  assert.match(prompt.system, /"additionalProperties":false/);
  assert.deepEqual(validateAnalysisResponse(fixture('checkout.response.json'), events),
    JSON.parse(fixture('checkout.expected.json')));
});

test('accepts collector redaction and stable IDs, but rejects raw input and masked trace placeholders', () => {
  const raw = { ...events[1], text: 'password="fixture-secret [REDACTED_EMAIL] suffix"', trace_id: 'buyer@example.test' };
  assert.throws(() => buildAnalysisPrompt([raw]), {
    message: 'Analysis requires already-redacted Events without masked trace IDs',
  });
  assert.throws(() => buildAnalysisPrompt([{ ...events[1], trace_id: '[REDACTED_EMAIL]' }]), /already-redacted/);
  const { events: collected } = finishEvents([raw]);
  const { user, system } = buildAnalysisPrompt(correlateEvents(collected).events);
  const [record] = JSON.parse(user).events;
  assert.equal(record.id, collected[0].id);
  assert.equal(record.text, 'password="[REDACTED_SECRET]"');
  assert.equal(Object.hasOwn(record, 'trace_id'), false);
  assert.doesNotMatch(user + system, /fixture-secret|buyer@example\.test|suffix/);
  const { events: unquoted } = finishEvents([{ ...raw, text: 'token=fixture-secret; retrying' }]);
  assert.equal(JSON.parse(buildAnalysisPrompt(unquoted).user).events[0].text, 'token=[REDACTED_SECRET]; retrying');
});

test('rejects invalid JSON and strict shape errors without echoing response content', () => {
  assert.throws(() => validateAnalysisResponse('```json\nbuyer@example.test\n```', events), { message: 'Invalid analysis JSON' });
  const valid = { ts: events[1].ts, summary: 'Quote failed.', evidence_ids: ['quote-error'] };
  for (const invalid of [
    null, [], {}, { hypotheses: [], timeline: [], 'buyer@example.test': true },
    { hypotheses: [], timeline: [{ ts: valid.ts, summary: valid.summary }] },
    { hypotheses: [], timeline: [{ ...valid, evidence_ids: [] }] },
    { hypotheses: [], timeline: [{ ...valid, evidence_ids: ['quote-error', 'quote-error'] }] },
    { hypotheses: [], timeline: [{ ...valid, ts: '2026-02-30T00:00:00Z' }] },
    { hypotheses: [{ id: 'a', summary: 'Guess', confidence: 1.5, evidence_ids: ['quote-error'],
      unverified_assumptions: [], suspect_files: [] }], timeline: [] },
  ]) {
    assert.throws(() => validateAnalysisResponse(JSON.stringify(invalid), events),
      { message: 'Analysis response does not match the output schema' });
  }
});

test('handles empty evidence and never returns raw IDs or sensitive model text', () => {
  const response = {
    hypotheses: [],
    timeline: [
      { ts: events[1].ts, summary: 'Contact buyer@example.test', evidence_ids: ['quote-error'] },
      { ts: events[1].ts, summary: 'Secret claim', evidence_ids: ['private@example.test'] },
    ],
  };
  assert.deepEqual(validateAnalysisResponse(JSON.stringify(response), events), {
    hypotheses: [],
    timeline: [{ ...response.timeline[0], summary: 'Contact [REDACTED_EMAIL]' }],
    rejected: [{ kind: 'timeline', index: 1, reason: 'unknown_evidence' }],
  });
  assert.deepEqual(JSON.parse(buildAnalysisPrompt([]).user), { events: [] });
  assert.deepEqual(validateAnalysisResponse(JSON.stringify(response), []).timeline, []);
  assert.deepEqual(validateAnalysisResponse('{"hypotheses":[],"timeline":[]}', []),
    { hypotheses: [], timeline: [], rejected: [] });
});
