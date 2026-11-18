'use strict';

const { join, relative } = require('node:path');
const { collectAlerts } = require('../collectors/alert.cjs');
const { collectLogs } = require('../collectors/log.cjs');
const { finishEvents } = require('../collectors/event.cjs');
const response = require('../fixtures/analysis/checkout.response.json');

const root = join(__dirname, '..');
const fixture = (...parts) => join(root, 'fixtures', ...parts);

function sumRedactions(results) {
  const counts = Object.fromEntries(Object.keys(results[0].redactionReport.counts).map((key) => [key, 0]));
  for (const result of results) {
    for (const [key, count] of Object.entries(result.redactionReport.counts)) counts[key] += count;
  }
  return { total: Object.values(counts).reduce((sum, count) => sum + count, 0), counts };
}

async function buildDemoInput() {
  const collected = await Promise.all([
    collectLogs(fixture('ingestion', 'checkout.jsonl'), { service: 'checkout-api' }),
    collectLogs(fixture('ingestion', 'checkout.log'), { service: 'checkout-api' }),
    collectLogs(fixture('ingestion', 'demo-checkout.jsonl'), { service: 'checkout-api' }),
    collectAlerts(fixture('ingestion', 'alerts.json'), { service: 'checkout-api' }),
  ]);
  const rootPrefix = `${root}/`;
  const fixtureEvents = collected.flatMap(({ events }) => events.map((event) => ({
    ...event,
    ref: event.ref.startsWith(rootPrefix) ? relative(root, event.ref) : event.ref,
  })));
  const [deploy, commit] = finishEvents([
    {
      ts: '2026-11-18T13:00:30.000Z', source: 'deploy', service: 'checkout-api', severity: 'info',
      ref: 'fixtures/analysis/checkout.input.json#L1', text: 'Checkout API demo deployment.',
    },
    {
      ts: '2026-11-18T13:00:00.000Z', source: 'commit', service: 'checkout-api', severity: 'info',
      ref: 'fixtures/checkout-api/quote.cjs:1', text: 'Fictional checkout quote change.',
    },
  ]).events;
  const all = finishEvents([...fixtureEvents, deploy, commit]).events;
  const quoteError = all.find((event) => event.source === 'log' && event.severity === 'error');
  const databaseAlert = all.find((event) => event.source === 'alert');
  if (!quoteError || !databaseAlert) throw new Error('Fictional checkout demo fixtures are incomplete');
  const ids = { 'quote-deploy': deploy.id, 'quote-error': quoteError.id, 'database-alert': databaseAlert.id };
  const analysis = structuredClone(response);
  for (const collection of [analysis.hypotheses, analysis.timeline]) {
    for (const claim of collection) claim.evidence_ids = claim.evidence_ids.map((id) => ids[id]);
  }
  return {
    events: all,
    correlation: {
      deploymentChanges: [{
        deploymentId: deploy.id,
        commitId: commit.id,
        files: ['fixtures/checkout-api/quote.cjs'],
      }],
    },
    analysis,
    redactionReport: sumRedactions(collected),
  };
}

module.exports = { buildDemoInput };
