'use strict';

const { createHash } = require('node:crypto');
const { validateEvent } = require('../src/validate.cjs');
const { redactEvents } = require('./redact.cjs');

const timestampPattern = '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})';
const timestamp = new RegExp(`^(${timestampPattern})$`);

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !timestamp.test(value)) throw new Error('Expected a zoned ISO timestamp');
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const wallTime = new Date(`${iso.slice(0, 19)}Z`);
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(wallTime.getTime()) ||
      wallTime.toISOString().slice(0, 19) !== iso.slice(0, 19) ||
      !/^\d{4}-/.test(date.toISOString())) {
    throw new Error('Invalid calendar timestamp');
  }
  // Preserve precision beyond milliseconds so window boundaries don't collapse.
  const fraction = (iso.match(/\.(\d+)/)?.[1] ?? '').replace(/0+$/, '');
  return `${date.toISOString().slice(0, 19)}.${fraction.padEnd(3, '0')}Z`;
}

function compareTimestamps(left, right) {
  // All inputs are normalized; remove Z so a shorter fractional prefix sorts first.
  const a = left.slice(0, -1);
  const b = right.slice(0, -1);
  return a < b ? -1 : a > b ? 1 : 0;
}

function finishEvents(records) {
  const events = records.map((event, index) => {
    const record = { ...event, id: 'pending', ts: normalizeTimestamp(event.ts) };
    const { valid } = validateEvent(record);
    if (!valid) throw new Error(`Invalid Event at record ${index + 1} (check the Event schema)`);
    return record;
  });
  const result = redactEvents(events);
  const seen = new Map();
  for (const event of result.events) {
    const key = JSON.stringify([event.source, event.service, event.signature ?? null, event.ref, event.ts]);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    event.id = createHash('sha256').update(`${key}:${occurrence}`).digest('hex');
  }
  return result;
}

module.exports = { timestampPattern, normalizeTimestamp, compareTimestamps, finishEvents };
