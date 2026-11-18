'use strict';

const { readFile } = require('node:fs/promises');
const { finishEvents } = require('./event.cjs');

async function collectAlerts(path, { service } = {}) {
  let input;
  try {
    input = await readFile(path, 'utf8');
  } catch {
    throw new Error('Could not read alert input');
  }
  let alerts;
  try {
    alerts = JSON.parse(input);
  } catch {
    throw new Error('Invalid alert JSON');
  }
  if (!Array.isArray(alerts)) throw new Error('Expected an array of alert objects');
  return finishEvents(alerts.map((alert, index) => {
    if (!alert || typeof alert !== 'object' || Array.isArray(alert)) {
      throw new Error(`Expected an alert object at record ${index + 1}`);
    }
    const { ts, timestamp, severity = 'warn', text, message, signature, trace_id } = alert;
    return {
      source: 'alert',
      ts: ts ?? timestamp,
      service: alert.service ?? service,
      severity,
      ref: `${path}#${index + 1}`,
      text: text ?? message,
      ...(signature !== undefined && { signature }),
      ...(trace_id !== undefined && { trace_id }),
    };
  }));
}

module.exports = { collectAlerts };
