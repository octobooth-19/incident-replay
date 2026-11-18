'use strict';

const assert = require('node:assert/strict');
const { copyFile, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { validateEvent } = require('../src/validate.cjs');
const { collectLogs } = require('./log.cjs');
const { collectAlerts } = require('./alert.cjs');
const { collectGitHub } = require('./github.cjs');
const { redactEvents } = require('./redact.cjs');

const fixtures = (...paths) => join(__dirname, '../fixtures/ingestion', ...paths);

function assertSafe(result, seeds, expectedCounts) {
  for (const event of result.events) assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
  const serialized = JSON.stringify(result);
  for (const [index, seed] of seeds.entries()) {
    assert.ok(!serialized.includes(seed), `Seed ${index + 1} was retained`);
  }
  for (const [kind, count] of Object.entries(result.redactionReport.counts)) {
    assert.equal(count, expectedCounts[kind] ?? 0, `Unexpected ${kind} count`);
  }
  assert.equal(result.redactionReport.total, Object.values(expectedCounts).reduce((sum, count) => sum + count, 0));
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'incident-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('JSONL collection normalizes timestamps, keeps line refs, and redacts seeded values', async () => {
  const file = fixtures('checkout.jsonl');
  const result = await collectLogs(file, { service: 'checkout-api' });
  assert.deepEqual(result.events.map(({ ts, severity, ref }) => [ts, severity, ref]), [
    ['2026-11-18T13:01:02.1234Z', 'warn', `${file}:1`],
    ['2026-11-18T13:02:03.000Z', 'error', `${file}:3`],
  ]);
  assert.equal(result.events[0].signature, 'quote.retry');
  assert.equal(result.events[0].trace_id, '[REDACTED_GITHUB]');
  assert.deepEqual(await collectLogs(file, { service: 'checkout-api' }), result);
  assertSafe(result, [
    'buyer@example.test', '192.0.2.42', 'AKIA0000000000000000', 'ghp_000000000000000000000000000000000000',
    '4111-1111-1111-1111', '0123456789abcdef0123456789abcdef', 'sentinel-ignored-json-field',
  ], { aws: 1, github: 1, email: 1, ip: 1, card: 1, entropy: 1 });
});

test('text collection handles bracketed and bare timestamps and redacts source paths', async (t) => {
  const email = 'operator@example.test';
  const file = join(await tempDir(t), `${email}.log`);
  await copyFile(fixtures('checkout.log'), file);
  const result = await collectLogs(file, { service: 'checkout-api' });
  assert.deepEqual(result.events.map(({ ts, severity }) => [ts, severity]), [
    ['2026-11-18T13:02:03.000Z', 'error'],
    ['2026-11-18T13:02:04.000Z', 'info'],
    ['2026-11-18T13:02:05.000Z', 'info'],
  ]);
  assert.match(result.events[0].ref, /\[REDACTED_EMAIL\]:1$/);
  assert.equal(result.events[2].text, 'service started');
  assertSafe(result, [email, '2001:db8::42', 'fictional dummy key'], { ip: 1, aws: 1, email: 3 });
});

test('alert fixtures redact service, signature, trace ID and message', async () => {
  const result = await collectAlerts(fixtures('alerts.json'));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].source, 'alert');
  assert.equal(result.events[0].severity, 'critical');
  assert.match(result.events[0].ref, /alerts\.json#1$/);
  assertSafe(result, [
    'alerts@example.test', '198.51.100.55', 'github_pat_000000000000000000000000000000000000',
    'Q7mK2sV9wX4nA6jB8rD5fH', 'sentinel-ignored-alert-field',
  ], { email: 1, ip: 1, github: 1, entropy: 1 });
});

test('invalid input fails without leaking raw file paths, lines or record data', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'do-not-echo@example.test.jsonl');
  await assert.rejects(collectLogs(file), { message: 'Could not read log input' });
  await writeFile(file, '\n{"message":"password=fixture-dummy",');
  await assert.rejects(collectLogs(file), { message: 'Invalid jsonl log at line 2' });
  await writeFile(file, '{"ts":"2026-02-30T00:00:00Z","message":"password=fixture-dummy"}');
  await assert.rejects(collectLogs(file), { message: 'Invalid jsonl log at line 1' });
  await assert.rejects(collectAlerts(file), { message: 'Expected an array of alert objects' });
});

test('standalone redaction masks all free-form fields without editing its input', () => {
  const original = {
    id: 'id@example.test', source: 'log', ts: '2026-11-18T13:00:00Z', severity: 'info',
    service: 'checkout-api', signature: 'quote.failure', trace_id: 'trace-12',
    ref: 'https://example.test/192.0.2.4?token=token',
    text: 'peer=::ffff:192.0.2.42 card=4111 1111 1111 1111',
  };
  const result = redactEvents([original]);
  assert.equal(result.events[0].ref, 'https://example.test/[REDACTED_IP]?token=[REDACTED_SECRET]');
  assertSafe(result, ['id@example.test', '::ffff:192.0.2.42', '4111 1111 1111 1111', 'token=token'],
    { email: 1, ip: 2, secret: 1, card: 1 });
  assert.equal(original.id, 'id@example.test');
});

test('GitHub collection uses read-only REST, pages safely, and filters every kind by time', async () => {
  const start = '2026-11-18T13:00:00.0012Z';
  const end = '2026-11-18T13:05:00Z';
  const before = '2026-11-18T13:00:00.0011Z';
  const after = '2026-11-18T13:05:01Z';
  const token = 'dummy-test-only-token';
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const commit = (date, message) => ({ sha, commit: { committer: { date }, message } });
  const calls = [];
  const result = await collectGitHub({
    repo: 'example/checkout-api', since: start, until: end, token,
    fetch: async (url, options) => {
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      const path = url.pathname.replace('/repos/example/checkout-api/', '');
      const page = url.searchParams.get('page');
      calls.push(`${path}:${page}`);
      switch (`${path}:${page}`) {
        case 'commits:1':
          assert.equal(url.searchParams.get('since'), '2026-11-18T13:00:00Z');
          assert.equal(url.searchParams.get('until'), end);
          return Response.json([commit(before, 'outside window')], {
            headers: { Link: '<https://untrusted.example.test/?page=2>; rel="next"' },
          });
        case 'commits:2':
          return Response.json([commit(start, 'Rotate key for github-user@example.test')]);
        case 'pulls:1':
          return Response.json([
            { number: 12, created_at: before, merged_at: end, closed_at: end, title: 'Handle 192.0.2.9' },
            { number: 13, created_at: end, closed_at: after, title: 'Open a PR' },
            { number: 14, created_at: before, closed_at: start, title: 'Close without merging' },
          ]);
        case 'deployments:1':
          return Response.json([
            { id: 21, created_at: end, description: 'password="dummy deployment password"' },
            { id: 22, created_at: before, description: 'outside window' },
          ]);
        case 'actions/runs:1':
          return Response.json({ workflow_runs: [
            { id: 31, created_at: end, display_title: 'CI', conclusion: 'failure' },
            { id: 32, created_at: after, name: 'outside window' },
          ] });
        default: assert.fail('Unexpected REST request');
      }
    },
  });
  assert.deepEqual(calls, ['commits:1', 'commits:2', 'pulls:1', 'deployments:1', 'actions/runs:1']);
  assert.deepEqual(result.events.map(({ source, signature }) => [source, signature]), [
    ['commit', 'github.commit'], ['commit', 'github.pr.closed'], ['commit', 'github.pr.merged'],
    ['commit', 'github.pr.opened'], ['deploy', 'github.deployment'], ['deploy', 'github.actions.run'],
  ]);
  assert.equal(result.events[0].ref, `https://github.com/example/checkout-api/commit/${sha}`);
  assert.equal(result.events.at(-1).severity, 'error');
  assertSafe(result, ['github-user@example.test', '192.0.2.9', 'dummy deployment password', token, 'outside window'],
    { email: 1, ip: 1, secret: 1 });
});

test('GitHub rejects invalid inputs before fetch and does not echo REST error bodies', async () => {
  const since = '2026-11-18T13:00:00.0001Z';
  const until = '2026-11-18T13:00:00Z';
  const options = { repo: 'example/checkout-api', since, until, fetch: () => assert.fail('Unexpected fetch') };
  await assert.rejects(collectGitHub({ ...options, repo: 'example/..' }), /owner\/name/);
  await assert.rejects(collectGitHub(options), /since to be before or equal/);
  await assert.rejects(collectGitHub({
    ...options, since: until, fetch: async () => new Response('password=fixture-dummy', { status: 403 }),
  }), { message: 'GitHub REST request failed (HTTP 403)' });
});
