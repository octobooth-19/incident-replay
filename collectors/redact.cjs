'use strict';

const { isIP } = require('node:net');
const { validateEvent } = require('../src/validate.cjs');

const fields = ['id', 'ts', 'source', 'service', 'severity', 'signature', 'trace_id', 'ref', 'text'];

function isCard(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = Number(digits[i]);
    const doubled = (digits.length - i) % 2 === 0 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

function highEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= (/^[a-f0-9]+$/i.test(value) ? 3.3 : 3.8);
}

function createRedactor() {
  const counts = { aws: 0, github: 0, secret: 0, email: 0, ip: 0, card: 0, entropy: 0 };

  function mask(kind) {
    counts[kind]++;
    return `[REDACTED_${kind.toUpperCase()}]`;
  }

  const awsKey = /(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g;
  const githubKey = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/g;
  const rules = [
    [/\b(aws_secret_access_key|aws_session_token|api[_-]?key|access[_-]?token|password|secret|token)["']?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^\s"',;&}\]]+))/gi,
      ([value, label, ...parts]) => {
        const key = parts.find((part) => part !== undefined);
        const kind = /^aws_/i.test(label) || /^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(key) ? 'aws'
          : /^(?:github_pat_|gh[pousr]_)/.test(key) ? 'github' : 'secret';
        const offset = value.lastIndexOf(key);
        return value.slice(0, offset) + mask(kind) + value.slice(offset + key.length);
      }],
    [/\b((?:Bearer|Basic)[ \t]+)([A-Za-z0-9+/_=.-]+)/gi,
      ([, prefix, key]) => prefix + mask(/^(?:github_pat_|gh[pousr]_)/.test(key) ? 'github' : 'secret')],
    [awsKey, () => mask('aws')],
    [githubKey, () => mask('github')],
    [/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, () => mask('email')],
    [/(?<![A-F0-9:])([A-F0-9:]*:[A-F0-9:]*:[A-F0-9:.]*)(?:%[A-Z0-9_.-]+)?/gi,
      ([, ip]) => isIP(ip.replace(/\.$/, '')) === 6 ? mask('ip') + (ip.endsWith('.') ? '.' : '') : null],
    [/(?<!\d)(?<!\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g, ([ip]) => isIP(ip) === 4 ? mask('ip') : null],
    [/(?<!\d)(?:\d[ -]?){12,18}\d(?![ -]?\d)/g, ([value]) => isCard(value) ? mask('card') : null],
    [/[A-Za-z0-9_+-]{20,}={0,2}/g, ([value]) => highEntropy(value) ? mask('entropy') : null],
  ];

  function redact(text) {
    // Keep already-masked spans separate so later detectors can't swallow placeholders.
    let segments = [{ text }];
    for (const [pattern, replacement] of rules) {
      segments = segments.flatMap((segment) => {
        if (segment.masked) return segment;
        const parts = [];
        let start = 0;
        for (const match of segment.text.matchAll(pattern)) {
          const masked = replacement(match);
          if (masked === null) continue;
          if (match.index > start) parts.push({ text: segment.text.slice(start, match.index) });
          parts.push({ text: masked, masked: true });
          start = match.index + match[0].length;
        }
        parts.push({ text: segment.text.slice(start) });
        return parts;
      });
    }
    return segments.map((segment) => segment.text).join('');
  }

  return {
    redact,
    report: () => ({ total: Object.values(counts).reduce((sum, count) => sum + count, 0), counts: { ...counts } }),
  };
}

function redactEvents(events) {
  const redactor = createRedactor();
  const safeEvents = events.map((event) => {
    if (!validateEvent(event).valid) throw new Error('Invalid Event input');
    const safe = {};
    for (const field of fields) {
      if (!Object.hasOwn(event, field)) continue;
      const value = event[field];
      // Only a canonical commit reference has a typed SHA, not arbitrary 40-character strings.
      const commitRef = field === 'ref' && event.signature === 'github.commit' &&
        /^(https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/commit\/)([a-f0-9]{40})$/i.exec(value);
      safe[field] = field === 'ts' || field === 'source' || field === 'severity' ? value
        : commitRef ? redactor.redact(commitRef[1]) + commitRef[2] : redactor.redact(value);
    }
    return safe;
  });
  return { events: safeEvents, redactionReport: redactor.report() };
}

module.exports = { redactEvents };
