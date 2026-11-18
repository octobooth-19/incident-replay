'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redactEvents } = require('../collectors/redact.cjs');
const { correlateEvents, normalizeEvents } = require('./correlate.cjs');

function event(id, time, overrides = {}) {
  return Object.freeze({
    id, ts: `2026-11-18T13:${time}Z`, source: 'log', service: 'checkout-api',
    severity: 'info', ref: `checkout.log:${id}`, text: '', ...overrides,
  });
}

test('corrects source clock offsets without changing records and keeps precise, deterministic order', () => {
  const records = Object.freeze([
    event('c', '00:00.00123'),
    event('b', '00:59.99912', { source: 'alert' }),
    event('a', '00:00.00112'),
    event('d', '00:00.00223', { source: 'deploy' }),
  ]);
  const offsets = { alert: -59_998, deploy: -1 };
  const normalized = normalizeEvents(records, offsets);
  assert.deepEqual(normalized.map(({ id, ts }) => [id, ts.slice(14)]), [
    ['a', '00:00.00112Z'], ['b', '00:00.00112Z'], ['c', '00:00.00123Z'], ['d', '00:00.00123Z'],
  ]);
  assert.deepEqual(normalizeEvents([...records].reverse(), offsets), normalized);
  assert.equal(records[1].ts, '2026-11-18T13:00:59.99912Z');
  assert.throws(() => normalizeEvents(records, { log: 0.1 }), /clock offsets/);
  assert.throws(() => normalizeEvents([records[0], records[0]]), /Duplicate Event ID at record 2/);
});

test('clusters error signatures within service and groups only explicit, unmasked trace IDs', () => {
  const { events } = redactEvents([
    event('a', '00:00', { severity: 'error', text: 'Timeout after 123 ms\n  at handler (api.js:1:2)', trace_id: 'trace-1' }),
    event('b', '00:01', { severity: 'critical', text: 'Timeout after 456 ms', trace_id: 'trace-1' }),
    event('c', '00:01', { severity: 'error', service: 'billing', text: 'Timeout after 789 ms', trace_id: 'trace-1' }),
    event('d', '00:02', { severity: 'error', signature: 'quote.failed', trace_id: 'buyer@example.test' }),
    event('e', '00:03', { severity: 'error', signature: 'quote.failed', trace_id: '[REDACTED_EMAIL]' }),
    event('f', '00:04', { signature: 'quote.failed' }),
  ]);
  assert.equal(Object.hasOwn(events[3], 'trace_id'), false);
  const { errorClusters, traces } = correlateEvents(events);
  assert.deepEqual(errorClusters, [
    { service: 'checkout-api', signature: 'Timeout after # ms', eventIds: ['a', 'b'] },
    { service: 'billing', signature: 'Timeout after # ms', eventIds: ['c'] },
    { service: 'checkout-api', signature: 'quote.failed', eventIds: ['d', 'e'] },
  ]);
  assert.deepEqual(traces, [{ traceId: 'trace-1', eventIds: ['a', 'b', 'c'] }]);
});

test('detects an error-rate rise at a half-open bucket boundary after clock correction', () => {
  const events = [
    event('before', '00:59.99999'),
    event('error', '00:59.999', { source: 'alert', severity: 'error' }),
    event('healthy', '01:59.99999'),
    event('later', '03:00', { severity: 'error' }),
    event('ci', '00:01', { source: 'actions_run', severity: 'error' }),
  ];
  const opts = { sourceOffsetsMs: { alert: 1 } };
  const { buckets, changePoint } = correlateEvents(events, opts);
  assert.deepEqual(buckets.map(({ startMs, total, rate }) => [new Date(startMs).toISOString().slice(14), total, rate]),
    [['00:00.000Z', 1, 0], ['01:00.000Z', 2, 0.5], ['03:00.000Z', 1, 1]]);
  assert.deepEqual(changePoint, { ts: '2026-11-18T13:01:00.000Z', baselineRate: 0, rate: 0.5, evidenceIds: ['error'] });
  assert.equal(correlateEvents(events, { ...opts, minRateIncrease: 0.6 }).changePoint, null);
  assert.equal(correlateEvents(events, { ...opts, minBucketEvents: 2 }).changePoint, null);
  assert.deepEqual(correlateEvents([]), { events: [], errorClusters: [], traces: [], buckets: [], changePoint: null, suspects: [] });
});

test('ranks deployed commits by distinct stack-file overlap with deterministic ties', () => {
  const text = 'Error: quote failed\n  at quote (file:///app/src/quote.js:1:2)\n' +
    '  at quote (/app/src/quote.js:2:3)\n  at src/money.js:3:4\n  at node:internal/main:1:2';
  const events = [
    event('before', '00:15'),
    event('error', '01:00', { severity: 'error', text }),
    event('unrelated', '01:01', { service: 'other', severity: 'error', text: 'Error\n  at src/other.js:1:2' }),
    event('first-deploy', '00:30', { source: 'deploy' }),
    event('latest-deploy', '00:59.9999', { source: 'deploy' }),
    event('late-deploy', '01:00', { source: 'deploy' }),
    ...['a', 'b', 'c', 'd', 'e'].map((id) => event(id, '00:00', { source: 'commit' })),
  ];
  const deploymentChanges = [
    { deploymentId: 'latest-deploy', commitId: 'c', files: ['src/quote.js'] },
    { deploymentId: 'first-deploy', commitId: 'b', files: ['src/money.js'] },
    { deploymentId: 'first-deploy', commitId: 'a', files: ['./src/quote.js', 'src/money.js', 'src/money.js'] },
    { deploymentId: 'latest-deploy', commitId: 'a', files: ['src/money.js'] },
    { deploymentId: 'latest-deploy', commitId: 'b', files: ['src/money.js'] },
    { deploymentId: 'latest-deploy', commitId: 'd', files: ['src/other.js'] },
    { deploymentId: 'late-deploy', commitId: 'e', files: ['src/quote.js', 'src/money.js'] },
  ];
  const { suspects } = correlateEvents(events, { deploymentChanges });
  assert.deepEqual(suspects.map(({ commitId, score }) => [commitId, score]), [['a', 2], ['b', 1], ['c', 1], ['d', 0]]);
  assert.deepEqual(suspects[0], {
    commitId: 'a', deploymentId: 'first-deploy', deployedAt: '2026-11-18T13:00:30.000Z',
    score: 2, matchedFiles: ['src/money.js', 'src/quote.js'], evidenceIds: ['first-deploy', 'a', 'error'],
  });
  assert.deepEqual(correlateEvents([...events].reverse(), { deploymentChanges: [...deploymentChanges].reverse() }).suspects, suspects);
  assert.deepEqual(correlateEvents(events, { deploymentChanges, sourceOffsetsMs: { deploy: 1 } })
    .suspects.map(({ commitId }) => commitId), ['a', 'b']);
});
