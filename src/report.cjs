'use strict';

const { validateAnalysisResponse } = require('./analyze.cjs');
const { correlateEvents } = require('./correlate.cjs');
const { compareTimestamps, normalizeTimestamp } = require('../collectors/event.cjs');
const { createRedactor } = require('../collectors/redact.cjs');

const categories = Object.keys(createRedactor().report().counts);
function buildReplay(input) {
  const {
    events, correlation, analysis = { hypotheses: [], timeline: [] }, redactionReport,
    warnings = [], omissions = [],
  } = input;
  const counts = redactionReport?.counts;
  if (!counts || Object.keys(counts).length !== categories.length ||
      categories.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    throw new TypeError('Expected collector redaction counts');
  }
  const total = categories.reduce((sum, key) => sum + counts[key], 0);
  if (!Number.isSafeInteger(total) || total !== redactionReport.total) {
    throw new TypeError('Invalid collector redaction total');
  }
  const safeWarnings = new Set([
    'commits', 'pull requests', 'deployments', 'Actions runs',
  ]);
  const safeReasons = new Set([
    'request timeout', 'time budget exhausted', 'page limit reached', 'invalid response',
    'request or data validation error',
  ]);
  if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== 'string' ||
      !/^GitHub collection incomplete: (commits|pull requests|deployments|Actions runs) may be partial or omitted \((request timeout|time budget exhausted|page limit reached|HTTP \d+|invalid response|request or data validation error)\)\.$/.test(warning)) ||
      !Array.isArray(omissions) || omissions.some((omission) => !safeWarnings.has(omission))) {
    throw new TypeError('Invalid collection warnings');
  }
  if (warnings.some((warning) => !safeReasons.has(warning.match(/\((.*)\)\.$/)?.[1]) &&
      !/\(HTTP \d+\)\.$/.test(warning))) throw new TypeError('Invalid collection warning reason');
  const correlated = correlateEvents(events, correlation);
  const ordered = correlated.events;
  const { hypotheses, timeline, rejected } = validateAnalysisResponse(JSON.stringify(analysis), ordered);
  return {
    version: 1,
    events: ordered,
    timeline: timeline.map((claim) => ({ ...claim, ts: normalizeTimestamp(claim.ts) }))
      .sort((a, b) => compareTimestamps(a.ts, b.ts)),
    hypotheses,
    redactionReport: { total, counts: Object.fromEntries(categories.map((key) => [key, counts[key]])) },
    rejectedClaims: rejected.length,
    warnings: [...warnings],
    omissions: [...omissions],
    correlation: {
      changePoint: correlated.changePoint,
      suspects: correlated.suspects.map(({ score, evidenceIds }) => ({ score, evidenceIds })),
    },
  };
}

function validRepo(repo) {
  return typeof repo === 'string' && repo.trim() === repo && /^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repo) &&
    !repo.endsWith('/.') && !repo.endsWith('/..');
}

function sourceLink(event, { repo, revision, files } = {}) {
  if (!validRepo(repo) || event.ref.trim() !== event.ref) return null;
  const web = `https://github.com/${repo}`;
  const api = `https://api.github.com/repos/${repo}`;
  const routes = {
    commit: [/^commit\/[a-f0-9]{7,40}$/i, web],
    pr: [/^pull\/[1-9]\d*$/, web],
    deploy: [/^deployments\/[1-9]\d*$/, api],
    actions_run: [/^actions\/runs\/[1-9]\d*$/, web],
  };
  const route = Object.hasOwn(routes, event.source) ? routes[event.source] : null;
  if (route) {
    const [pattern, base] = route;
    const ref = event.ref.startsWith(`${base}/`) ? event.ref.slice(base.length + 1) : event.ref;
    if (pattern.test(ref)) return `${base}/${ref}`;
  }
  const match = /^(.*?)(?:#L([1-9]\d*)|:([1-9]\d*))?$/.exec(event.ref);
  if (!match || !/^[a-f0-9]{40}$/i.test(revision) || !files?.has(match[1])) return null;
  const path = match[1].split('/').map((part) => encodeURIComponent(part)).join('/');
  const line = match[2] ?? match[3];
  return `${web}/blob/${revision}/${path}${line ? `#L${line}` : ''}`;
}

function encodeMarkdown(text) {
  // Encode Markdown punctuation, including autolink punctuation, before GitHub parses the comment.
  return text.replace(/[!-/:-@[-`{-~]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeMarkdown(value, limit = 240) {
  const text = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  const bounded = text.length > limit ? `${text.slice(0, limit)}...` : text;
  return encodeMarkdown(bounded);
}

function renderIssueComment(replay, repository) {
  const evidence = new Map(replay.events.map((event) => [event.id, event]));
  const cite = (id) => {
    const event = evidence.get(id);
    const url = event && sourceLink(event, repository);
    const label = encodeMarkdown(id).replace(/[\s\u0000-\u001f\u007f]/g, (char) => `&#${char.charCodeAt(0)};`);
    return url ? `[${label}](<${url}>)`
      : `${label} (${escapeMarkdown(event?.ref ?? 'unavailable')})`;
  };
  const citations = (ids) => ids.slice(0, 4).map(cite).join(', ') +
    (ids.length > 4 ? `, +${ids.length - 4} more in replay` : '');
  const timeline = replay.timeline.length ? replay.timeline : replay.events.map((event) => ({
    ts: event.ts, summary: event.text, evidence_ids: [event.id],
  }));
  const lines = ['## Incident replay', '', '### Timeline'];
  for (const claim of timeline.slice(0, 10)) {
    lines.push(`- **${claim.ts}** ${escapeMarkdown(claim.summary)} — ${citations(claim.evidence_ids)}`);
  }
  if (timeline.length === 0) lines.push('No events recorded.');
  if (timeline.length > 10) lines.push(`- ${timeline.length - 10} more entries in the replay bundle.`);
  lines.push('', '### Correlation');
  if (replay.correlation?.changePoint) {
    const { ts, baselineRate, rate, evidenceIds } = replay.correlation.changePoint;
    lines.push(`- Error-rate increase at **${ts}** from ${Math.round(baselineRate * 100)}% to ${Math.round(rate * 100)}% — ${citations(evidenceIds)}.`);
  } else {
    lines.push('- No qualifying adjacent-bucket error-rate increase detected.');
  }
  if (replay.correlation?.suspects.length) {
    lines.push(`- Deployment-linked candidates: ${replay.correlation.suspects.length}; scores count distinct changed files matching error stack frames.`);
    for (const suspect of replay.correlation.suspects.slice(0, 5)) {
      lines.push(`  - Score ${suspect.score} — ${citations(suspect.evidenceIds)}`);
    }
  }
  lines.push('', '### Hypotheses');
  for (const hypothesis of replay.hypotheses.slice(0, 5)) {
    lines.push(`- **${Math.round(hypothesis.confidence * 100)}%** ${escapeMarkdown(hypothesis.summary)} — ${citations(hypothesis.evidence_ids)}`);
  }
  if (replay.hypotheses.length === 0) lines.push('No evidence-backed hypotheses supplied.');
  if (replay.hypotheses.length > 5) lines.push(`- ${replay.hypotheses.length - 5} more hypotheses in the replay bundle.`);
  const { total, counts } = replay.redactionReport;
  lines.push('', `**Ingestion redactions:** ${total} (${categories.map((key) => `${key}: ${counts[key]}`).join(', ')}).`);
  if (replay.rejectedClaims) lines.push(`Offline claims omitted for unknown evidence: ${replay.rejectedClaims}.`);
  if (replay.warnings?.length) {
    lines.push('', '### Collection warnings');
    for (const warning of replay.warnings) lines.push(`- ${warning}`);
    if (replay.omissions?.length) lines.push(`- Omitted sources: ${replay.omissions.join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { buildReplay, renderIssueComment, sourceLink, validRepo };
