'use strict';

const { readFile } = require('node:fs/promises');
const { timestampPattern, normalizeTimestamp, finishEvents } = require('./event.cjs');

const plainLine = new RegExp(`^(?:\\[(${timestampPattern})\\]|(${timestampPattern}))\\s+(.*)$`);
const levelPrefix = /^(?:\[(debug|info|warn(?:ing)?|error|critical|fatal)\]|(debug|info|warn(?:ing)?|error|critical|fatal))(?:[ \t]*:[ \t]*|[ \t]+|$)/i;

function severity(level) {
  if (level === undefined) return 'info';
  if (typeof level !== 'string') throw new Error('Invalid severity');
  const lower = level.toLowerCase();
  return lower === 'warning' ? 'warn' : lower === 'fatal' ? 'critical' : lower;
}

function parseLine(line, format) {
  if (format === 'jsonl') {
    const item = JSON.parse(line);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Expected a JSON object');
    const { ts, timestamp, severity: level, level: alternateLevel, text, message, service, signature, trace_id } = item;
    return {
      ts: normalizeTimestamp(ts ?? timestamp),
      severity: severity(level ?? alternateLevel),
      text: text ?? message,
      ...(service !== undefined && { service }),
      ...(signature !== undefined && { signature }),
      ...(trace_id !== undefined && { trace_id }),
    };
  }
  const match = plainLine.exec(line);
  if (!match) throw new Error('Missing timestamp');
  const [, bracketed, bare, message] = match;
  const level = levelPrefix.exec(message);
  return {
    ts: normalizeTimestamp(bracketed ?? bare),
    severity: severity(level?.[1] ?? level?.[2]),
    text: level ? message.slice(level[0].length) : message,
  };
}

async function collectLogs(path, { format = path.endsWith('.jsonl') ? 'jsonl' : 'text', service } = {}) {
  if (!['jsonl', 'text'].includes(format)) throw new Error('Log format must be jsonl or text');
  let input;
  try {
    input = await readFile(path, 'utf8');
  } catch {
    throw new Error('Could not read log input');
  }
  const events = [];
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let parsed;
    try {
      parsed = parseLine(raw.trimStart(), format);
    } catch {
      throw new Error(`Invalid ${format} log at line ${index + 1}`);
    }
    events.push({ source: 'log', service, ...parsed, ref: `${path}:${index + 1}` });
  }
  return finishEvents(events);
}

module.exports = { collectLogs };
