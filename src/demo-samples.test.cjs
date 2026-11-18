'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { generate } = require('./generate-replay.cjs');
const { validateAnalysis, validateEvent } = require('./validate.cjs');

const demoDir = join(__dirname, '..', 'demo');

test('standalone demo inputs generate valid replay bundles', () => {
  const files = readdirSync(demoDir).filter((file) => file.endsWith('.json'));
  assert.ok(files.length > 0);
  const output = mkdtempSync(join(tmpdir(), 'incident-replay-samples-'));
  try {
    for (const file of files) {
      const path = join(demoDir, file);
      const input = JSON.parse(readFileSync(path, 'utf8'));
      for (const event of input.events) {
        assert.deepEqual(validateEvent(event), { valid: true, errors: [] }, `${file}: ${event.id}`);
      }
      assert.deepEqual(validateAnalysis(input.analysis), { valid: true, errors: [] }, file);
      const destination = join(output, file);
      generate(path, destination);
      const replay = JSON.parse(readFileSync(join(destination, 'replay.json'), 'utf8'));
      assert.equal(replay.events.length, input.events.length, file);
      assert.equal(replay.rejectedClaims, 0, file);
      assert.equal(replay.hypotheses.length, input.analysis.hypotheses.length, file);
      assert.equal(replay.timeline.length, input.analysis.timeline.length, file);
      assert.ok(readFileSync(join(destination, 'index.html'), 'utf8').includes('embedded-replay'), file);
      assert.ok(readFileSync(join(destination, 'issue-comment.md'), 'utf8').includes('Incident replay'), file);
      if (file === 'deployment-regression.json') {
        assert.equal(replay.correlation.changePoint.ts, '2026-04-15T10:01:00.000Z');
        assert.equal(replay.correlation.suspects[0].score, 1);
      }
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
