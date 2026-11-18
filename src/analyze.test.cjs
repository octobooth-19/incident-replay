'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { analyzeWithCopilot, buildAnalysisPrompt, validateAnalysisResponse } = require('./analyze.cjs');
const { finishEvents } = require('../collectors/event.cjs');
const { correlateEvents } = require('./correlate.cjs');

const events = [
  { id: 'quote-deploy', ts: '2026-11-18T13:00:30.000Z', source: 'deploy', service: 'checkout-api',
    severity: 'info', ref: 'deploy:1', text: 'Checkout deployed.' },
  { id: 'quote-error', ts: '2026-11-18T13:01:00.000Z', source: 'log', service: 'checkout-api',
    severity: 'error', ref: 'checkout.log:1', text: 'Quote failed.\n  at quote (src/quote.js:4:2)' },
];
const fixture = (name) => readFileSync(join(__dirname, '../fixtures/analysis', name), 'utf8');
const suspectDiffs = [{ path: 'src/quote.cjs', patch: '@@ -1 +1 @@\n- old total\n+ new total', reviewed: true }];

function correlatedSuspect() {
  const collected = finishEvents([
    { ts: '2026-11-18T12:59:30Z', source: 'commit', service: 'checkout-api', severity: 'info',
      ref: 'commit/0123456789abcdef', text: 'Checkout change.' },
    { ts: '2026-11-18T12:59:45Z', source: 'deploy', service: 'checkout-api', severity: 'info',
      ref: 'deployments/42', text: 'Checkout deployment.' },
    { ts: '2026-11-18T13:00:10Z', source: 'log', service: 'checkout-api', severity: 'info',
      ref: 'checkout.log:1', text: 'Quote request started.' },
    { ts: '2026-11-18T13:01:10Z', source: 'log', service: 'checkout-api', severity: 'error',
      ref: 'checkout.log:2', text: 'Quote failed.\n    at quote (/app/src/quote.cjs:4:2)' },
  ]).events;
  return correlateEvents(collected, {
    deploymentChanges: [{
      deploymentId: collected[1].id,
      commitId: collected[0].id,
      files: ['src/quote.cjs'],
    }],
  });
}

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

test('prepares reviewed suspect diffs as redacted, cited evidence and rejects unsupported files', () => {
  const correlation = correlatedSuspect();
  assert.deepEqual(correlation.suspects[0].matchedFiles, ['src/quote.cjs']);
  const prompt = buildAnalysisPrompt(correlation.events, { correlation, suspectDiffs });
  const input = JSON.parse(prompt.user);
  const [diff] = input.suspect_diffs;
  assert.match(diff.id, /^diff-[a-f0-9]{64}$/);
  assert.equal(diff.reviewed, true);
  assert.equal(input.correlation.changePoint.ts, correlation.changePoint.ts);
  assert.match(prompt.system, /cite each path with its matching diff ID/);
  const response = {
    hypotheses: [{
      id: 'quote-change',
      summary: 'The reviewed quote change may be related to the error.',
      confidence: 0.6,
      evidence_ids: [correlation.suspects[0].evidenceIds.at(-1), diff.id],
      unverified_assumptions: [],
      suspect_files: ['src/quote.cjs'],
    }],
    timeline: [{ ts: correlation.changePoint.ts, summary: 'Quote errors increased.',
      evidence_ids: [diff.id] }],
  };
  assert.deepEqual(validateAnalysisResponse(JSON.stringify(response), correlation.events, {
    correlation, suspectDiffs,
  }), { hypotheses: response.hypotheses, timeline: response.timeline, rejected: [] });
  const unsupported = structuredClone(response);
  unsupported.hypotheses[0].suspect_files = ['src/other.cjs'];
  assert.deepEqual(validateAnalysisResponse(JSON.stringify(unsupported), correlation.events, {
    correlation, suspectDiffs,
  }).rejected, [{ kind: 'hypotheses', index: 0, reason: 'unsupported_suspect_file' }]);
  unsupported.hypotheses[0].suspect_files = ['src/quote.cjs'];
  unsupported.hypotheses[0].evidence_ids = [correlation.events[0].id];
  assert.deepEqual(validateAnalysisResponse(JSON.stringify(unsupported), correlation.events, {
    correlation, suspectDiffs,
  }).rejected, [{ kind: 'hypotheses', index: 0, reason: 'unsupported_suspect_file' }]);
  unsupported.hypotheses[0].evidence_ids = ['diff-unknown'];
  assert.deepEqual(validateAnalysisResponse(JSON.stringify(unsupported), correlation.events, {
    correlation, suspectDiffs,
  }).rejected, [{ kind: 'hypotheses', index: 0, reason: 'unknown_evidence' }]);
  assert.throws(() => buildAnalysisPrompt(correlation.events, {
    correlation, suspectDiffs: [{ ...suspectDiffs[0], reviewed: false }],
  }), /Invalid reviewed suspect diff/);
  assert.throws(() => buildAnalysisPrompt(correlation.events, {
    correlation, suspectDiffs: [{ ...suspectDiffs[0], patch: 'token=fixture-secret' }],
  }), /must be redacted/);
  assert.throws(() => buildAnalysisPrompt(correlation.events, {
    correlation, suspectDiffs: [{ ...suspectDiffs[0], path: 'src/other.cjs' }],
  }), /Invalid reviewed suspect diff/);
});

test('calls Copilot only after explicit opt-in and validates its response without enabling tools', async () => {
  const correlation = correlatedSuspect();
  let invocation;
  const runCopilot = async (options) => {
    invocation = options;
    const input = JSON.parse(options.prompt.split('Evidence JSON:\n')[1]);
    const [diff] = input.suspect_diffs;
    return JSON.stringify({
      hypotheses: [{
        id: 'quote-change',
        summary: 'The reviewed quote change may be related to the error.',
        confidence: 0.6,
        evidence_ids: [correlation.events.at(-1).id, diff.id],
        unverified_assumptions: [],
        suspect_files: ['src/quote.cjs'],
      }],
      timeline: [],
    });

  };
  let calls = 0;
  await assert.rejects(analyzeWithCopilot(correlation, {
    suspectDiffs,
    runCopilot: async () => { calls++; },
  }), /Live analysis is disabled/);
  assert.equal(calls, 0);
  const analysis = await analyzeWithCopilot(correlation, {
    enabled: true, model: 'gpt-6-astra', suspectDiffs, runCopilot,
  });
  assert.equal(analysis.hypotheses[0].suspect_files[0], 'src/quote.cjs');
  assert.deepEqual(invocation.args.slice(0, 2), ['--available-tools=ask_user', '--disable-builtin-mcps']);
  assert.ok(invocation.args.includes('--no-ask-user'));
  assert.ok(!invocation.args.includes('--allow-all-tools'));
  assert.ok(!invocation.args.includes('-p'));
  assert.ok(invocation.args.includes('--no-custom-instructions'));
  assert.ok(invocation.args.includes('--model'));
  assert.ok(!invocation.args.some((arg) => arg.includes('Evidence JSON')));
  const unsafeCorrelation = structuredClone(correlation);
  unsafeCorrelation.suspects[0].extra = 'token=fixture-secret';
  await assert.rejects(analyzeWithCopilot(unsafeCorrelation, {
    enabled: true, suspectDiffs, runCopilot,
  }), /already-redacted metadata/);
  await assert.rejects(analyzeWithCopilot(correlation, {
    enabled: true, suspectDiffs, runCopilot: async () => { throw new Error('token=fixture-secret'); },
  }), /Copilot CLI failed/);
  await assert.rejects(analyzeWithCopilot(correlation, {
    enabled: true, suspectDiffs, runCopilot: async () => 'not JSON',
  }), /Invalid analysis JSON/);
});

test('passes reviewed evidence to a local mock CLI over stdin, not command arguments', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-replay-cli-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = join(dir, 'copilot');
  writeFileSync(command, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.includes('Evidence JSON:') || process.argv.some((arg) => arg.includes('Evidence JSON:'))) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('{"hypotheses":[],"timeline":[]}');
});
`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  try {
    const result = await analyzeWithCopilot(correlatedSuspect(), { enabled: true, suspectDiffs });
    assert.deepEqual(result, { hypotheses: [], timeline: [], rejected: [] });
  } finally {
    process.env.PATH = originalPath;
  }
});
