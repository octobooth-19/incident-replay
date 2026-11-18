'use strict';

const { posix } = require('node:path');
const { fileURLToPath } = require('node:url');
const { normalizeTimestamp, compareTimestamps } = require('../collectors/event.cjs');
const { assertEvents, compareStrings } = require('./replay-events.cjs');

const sources = new Set(require('./schemas/event.schema.json').properties.source.enum);
const isTelemetry = ({ source }) => source === 'log' || source === 'alert';
const isError = ({ severity }) => severity === 'error' || severity === 'critical';

function normalizeEvents(events, sourceOffsetsMs = {}) {
  assertEvents(events);
  if (!sourceOffsetsMs || typeof sourceOffsetsMs !== 'object' || Array.isArray(sourceOffsetsMs) ||
      Object.entries(sourceOffsetsMs).some(([source, offset]) => !sources.has(source) || !Number.isSafeInteger(offset))) {
    throw new TypeError('Expected integer clock offsets in milliseconds keyed by Event source');
  }
  return events.map((event) => {
    const ts = normalizeTimestamp(event.ts);
    const offset = Object.hasOwn(sourceOffsetsMs, event.source) ? sourceOffsetsMs[event.source] : 0;
    const adjusted = new Date(Date.parse(ts) + offset);
    if (!Number.isFinite(adjusted.getTime()) || adjusted.getUTCFullYear() < 0 || adjusted.getUTCFullYear() > 9999) {
      throw new RangeError('Clock offset moved an Event outside the supported UTC range');
    }
    // Date truncates beyond milliseconds; a whole-millisecond offset leaves that remainder unchanged.
    return { ...event, ts: adjusted.toISOString().slice(0, -1) + ts.slice(23) };
  }).sort((a, b) => compareTimestamps(a.ts, b.ts) || compareStrings(a.id, b.id));
}

function groups(events, keyFor) {
  const byKey = new Map();
  for (const event of events) {
    const key = keyFor(event);
    if (key === undefined) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(event.id);
  }
  return [...byKey];
}

function errorSignature(event) {
  if (!isTelemetry(event) || !isError(event)) return undefined;
  if (event.signature !== undefined) return event.signature;
  const firstLine = event.text.trimStart().split(/\r?\n/, 1)[0].trim();
  return firstLine.replace(/\b(?:0x[0-9a-f]+|\d+)\b/gi, '#').replace(/\s+/g, ' ') || undefined;
}

function errorBuckets(events, bucketMs) {
  const byStart = new Map();
  for (const event of events) {
    if (!isTelemetry(event)) continue;
    const start = Math.floor(Date.parse(event.ts) / bucketMs) * bucketMs;
    if (!byStart.has(start)) byStart.set(start, { startMs: start, total: 0, errorIds: [] });
    const bucket = byStart.get(start);
    bucket.total++;
    if (isError(event)) bucket.errorIds.push(event.id);
  }
  return [...byStart.values()].map((bucket) => ({ ...bucket, rate: bucket.errorIds.length / bucket.total }));
}

function findChangePoint(buckets, { bucketMs, minRateIncrease, minBucketEvents }) {
  for (let i = 1; i < buckets.length; i++) {
    const previous = buckets[i - 1];
    const current = buckets[i];
    if (current.startMs - previous.startMs === bucketMs &&
        previous.total >= minBucketEvents && current.total >= minBucketEvents &&
        (current.errorIds.length * previous.total - previous.errorIds.length * current.total) /
          (previous.total * current.total) >= minRateIncrease) {
      return {
        ts: new Date(current.startMs).toISOString(),
        baselineRate: previous.rate,
        rate: current.rate,
        evidenceIds: [...current.errorIds],
      };
    }
  }
  return null;
}

function stackPaths(text) {
  const paths = [];
  for (const line of text.split(/\r?\n/)) {
    const frame = /^\s*at\s+(?:.*?\s+\((.+)\)|((?:async )?\S+))\s*$/.exec(line);
    let path = (frame?.[1] ?? frame?.[2])?.replace(/^async /, '').match(/^(.+):\d+:\d+$/)?.[1];
    if (!path) continue;
    if (path.startsWith('file://')) {
      try {
        path = fileURLToPath(path, { windows: false });
      } catch {
        continue; // An unsupported or malformed stack frame is not file evidence.
      }
    }
    if (/^\w+:/.test(path) && !/^[a-z]:[/\\]/i.test(path)) continue;
    paths.push(posix.normalize(path.replaceAll('\\', '/')));
  }
  return paths;
}

function rankSuspects(events, changePoint, deploymentChanges) {
  if (!Array.isArray(deploymentChanges)) throw new TypeError('Expected an array of deployment changes');
  const byId = new Map(events.map((event) => [event.id, event]));
  const seen = new Set();
  const compare = (a, b) => b.score - a.score || compareTimestamps(b.deployedAt, a.deployedAt) ||
    compareStrings(a.commitId, b.commitId) || compareStrings(a.deploymentId, b.deploymentId);
  const suspects = [];
  const errorsByService = new Map();
  if (changePoint) {
    for (const event of events) {
      if (!isTelemetry(event) || !isError(event) || compareTimestamps(event.ts, changePoint.ts) < 0) continue;
      const paths = stackPaths(event.text);
      if (paths.length === 0) continue;
      if (!errorsByService.has(event.service)) errorsByService.set(event.service, []);
      errorsByService.get(event.service).push({ id: event.id, paths });
    }
  }
  for (const [index, change] of deploymentChanges.entries()) {
    const deployment = byId.get(change?.deploymentId);
    const commit = byId.get(change?.commitId);
    const files = change?.files;
    if (deployment?.source !== 'deploy' || commit?.source !== 'commit' || !Array.isArray(files) ||
        [...files].some((file) => typeof file !== 'string' || !file.trim() || /[:\\]/.test(file) ||
          posix.isAbsolute(file) || ['.', '..'].includes(posix.normalize(file)) ||
          posix.normalize(file).startsWith('../'))) {
      throw new TypeError(`Invalid deployment change at record ${index + 1}`);
    }
    const key = JSON.stringify([deployment.id, commit.id]);
    if (seen.has(key)) throw new TypeError(`Duplicate deployment change at record ${index + 1}`);
    seen.add(key);
    if (!changePoint || compareTimestamps(deployment.ts, changePoint.ts) >= 0) continue;
    const overlap = new Set();
    const evidenceIds = [deployment.id, commit.id];
    const changed = new Set(files.map((file) => posix.normalize(file)));
    for (const { id, paths } of errorsByService.get(deployment.service) ?? []) {
      let matched = false;
      for (const file of changed) {
        if (paths.some((path) => path === file || (/^(?:\/|[a-z]:\/)/i.test(path) && path.endsWith(`/${file}`)))) {
          overlap.add(file);
          matched = true;
        }
      }
      if (matched) evidenceIds.push(id);
    }
    suspects.push({
      commitId: commit.id, deploymentId: deployment.id, deployedAt: deployment.ts,
      score: overlap.size, matchedFiles: [...overlap].sort(compareStrings), evidenceIds,
    });
  }
  const ranked = new Map();
  for (const suspect of suspects.sort(compare)) {
    if (!ranked.has(suspect.commitId)) ranked.set(suspect.commitId, suspect);
  }
  return [...ranked.values()];
}

function correlateEvents(events, {
  sourceOffsetsMs, bucketMs = 60_000, minRateIncrease = 0.25, minBucketEvents = 1, deploymentChanges = [],
} = {}) {
  if (!Number.isSafeInteger(bucketMs) || bucketMs < 1 || bucketMs > 86_400_000 ||
      !Number.isFinite(minRateIncrease) || minRateIncrease <= 0 || minRateIncrease > 1 ||
      !Number.isSafeInteger(minBucketEvents) || minBucketEvents < 1) {
    throw new TypeError('Invalid error-bucket configuration');
  }
  const normalized = normalizeEvents(events, sourceOffsetsMs);
  const buckets = errorBuckets(normalized, bucketMs);
  const changePoint = findChangePoint(buckets, { bucketMs, minRateIncrease, minBucketEvents });
  return {
    events: normalized,
    errorClusters: groups(normalized, (event) => {
      const signature = errorSignature(event);
      return signature === undefined ? undefined : JSON.stringify([event.service, signature]);
    }).map(([key, eventIds]) => {
      const [service, signature] = JSON.parse(key);
      return { service, signature, eventIds };
    }),
    traces: groups(normalized, (event) => event.trace_id && !/\[REDACTED_/i.test(event.trace_id)
      ? event.trace_id : undefined).map(([traceId, eventIds]) => ({ traceId, eventIds })),
    buckets,
    changePoint,
    suspects: rankSuspects(normalized, changePoint, deploymentChanges),
  };
}

module.exports = { correlateEvents, normalizeEvents };
