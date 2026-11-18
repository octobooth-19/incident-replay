'use strict';

const { performance } = require('node:perf_hooks');
const { normalizeTimestamp, compareTimestamps, finishEvents } = require('./event.cjs');

const maxRetries = 2;
const allowedLimits = { maxPages: [1, 20], timeBudgetMs: [1, 60_000], requestTimeoutMs: [1, 30_000] };

function assertLimit(name, value) {
  const [min, max] = allowedLimits[name];
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`Expected ${name} between ${min} and ${max}`);
  }
}

function retryDelay(response, attempt) {
  const headers = response.headers;
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (retryAfter) {
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const reset = Number(headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now());
  return Math.min(250 * 2 ** attempt, 2_000);
}

function isRateLimited(response) {
  const retryAfter = response.headers?.get?.('retry-after');
  return response.status === 429 || (response.status === 403 &&
    (response.headers?.get?.('x-ratelimit-remaining') === '0' || retryAfter !== null && retryAfter !== undefined));
}

async function request(url, { fetch, token, deadline, requestTimeoutMs, sleep }) {
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('GitHub collection time budget exhausted');
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(requestTimeoutMs, remaining));
    let timer;
    let timeout;
    let response;
    try {
      timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('GitHub request timed out'));
        }, timeoutMs);
      });
      const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (token) headers.Authorization = `Bearer ${token}`;
      response = await Promise.race([
        fetch(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      clearTimeout(timer);
      const timedOut = error?.message === 'GitHub request timed out';
      if (attempt < maxRetries && deadline - performance.now() > 0) {
        const delay = Math.min(250 * 2 ** attempt, deadline - performance.now());
        if (delay > 0) {
          await sleep(delay);
          continue;
        }
      }
      throw new Error(timedOut ? 'GitHub request timed out' : 'GitHub REST request failed');
    }
    if (response?.ok) {
      try {
        const body = await Promise.race([response.json(), timeout]);
        clearTimeout(timer);
        return { response, body };
      } catch (error) {
        clearTimeout(timer);
        if (error?.message === 'GitHub request timed out') {
          if (attempt < maxRetries && deadline - performance.now() > 0) {
            const delay = Math.min(250 * 2 ** attempt, deadline - performance.now());
            if (delay > 0) {
              await sleep(delay);
              continue;
            }
          }
          throw new Error('GitHub request timed out');
        }
        throw new Error('GitHub REST returned invalid JSON');
      }
    }
    clearTimeout(timer);
    const rateLimited = isRateLimited(response ?? {});
    if ((rateLimited || response?.status >= 500) && attempt < maxRetries) {
      const delay = rateLimited ? retryDelay(response, attempt) : Math.min(250 * 2 ** attempt, 2_000);
      const wait = Math.min(delay, deadline - performance.now());
      if (deadline - performance.now() <= 0) throw new Error('GitHub collection time budget exhausted');
      await sleep(wait);
      continue;
    }
    throw new Error(`GitHub REST request failed (HTTP ${Number.isInteger(response?.status) ? response.status : 'unknown'})`);
  }
}

async function* pages(path, query, {
  fetch, token, collection, deadline, requestTimeoutMs, maxPages, sleep,
}) {
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error('GitHub pagination limit reached');
    const url = new URL(path, 'https://api.github.com');
    url.search = new URLSearchParams({ ...query, per_page: '100', page: String(page) });
    const { response, body } = await request(url, { fetch, token, deadline, requestTimeoutMs, sleep });
    const items = collection ? body?.[collection] : body;
    if (!Array.isArray(items)) throw new Error('GitHub REST returned an unexpected response');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('GitHub REST returned an invalid item');
      }
      yield item;
    }
    // Follow the relation, not the URL: never forward credentials to a response-supplied host.
    if (!/<[^>]*>\s*;\s*rel="next"/.test(response.headers?.get?.('link') ?? '')) return;
    if (page === maxPages) throw new Error('GitHub pagination limit reached');
  }
}

function isRepository(repo) {
  return typeof repo === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    !repo.endsWith('/.') && !repo.endsWith('/..');
}

function numberRef(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid GitHub item ID');
  return value;
}

function failureLabel(error) {
  if (error.message === 'GitHub request timed out') return 'request timeout';
  if (error.message === 'GitHub collection time budget exhausted') return 'time budget exhausted';
  if (error.message === 'GitHub pagination limit reached') return 'page limit reached';
  const status = /^GitHub REST request failed \(HTTP (\d+|unknown)\)$/.exec(error.message);
  if (status) return `HTTP ${status[1]}`;
  if (error.message === 'GitHub REST returned invalid JSON') return 'invalid response';
  return 'request or data validation error';
}

async function collectGitHub({
  repo, since, until, service, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  fetch = globalThis.fetch, maxPages = 10, timeBudgetMs = 30_000,
  requestTimeoutMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!isRepository(repo)) throw new Error('Expected GitHub repository as owner/name');
  const start = normalizeTimestamp(since);
  const end = normalizeTimestamp(until);
  if (compareTimestamps(start, end) > 0) throw new Error('Expected since to be before or equal to until');
  for (const name of Object.keys(allowedLimits)) assertLimit(name, { maxPages, timeBudgetMs, requestTimeoutMs }[name]);
  if (typeof fetch !== 'function' || typeof sleep !== 'function') throw new TypeError('Expected fetch and sleep functions');
  service ??= repo.split('/')[1];
  if (typeof service !== 'string' || !service.length) throw new Error('Expected a non-empty service');
  const api = `/repos/${repo}`;
  const web = `https://github.com/${repo}`;
  const deadline = performance.now() + timeBudgetMs;
  const events = [];
  function add(time, source, signature, ref, text, severity = 'info') {
    const ts = normalizeTimestamp(time);
    if (compareTimestamps(ts, start) >= 0 && compareTimestamps(ts, end) <= 0) {
      if (typeof text !== 'string') throw new Error('GitHub REST returned missing Event text');
      events.push({ ts, source, signature, ref, text, severity, service });
    }
  }

  // GitHub queries use whole seconds. Round the server window out, then filter precisely locally.
  const floor = start.slice(0, 19) + 'Z';
  const endSecond = end.slice(0, 19) + 'Z';
  const ceiling = end.endsWith('.000Z') ? endSecond : new Date(Date.parse(endSecond) + 1000).toISOString();
  const sources = [
    {
      label: 'commits',
      path: `${api}/commits`,
      query: { since: floor, until: ceiling },
      map: (item) => {
        if (typeof item.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(item.sha)) throw new Error('Invalid GitHub commit SHA');
        add(item.commit?.committer?.date, 'commit', 'github.commit', `${web}/commit/${item.sha}`, item.commit?.message);
      },
    },
    {
      label: 'pull requests',
      path: `${api}/pulls`,
      query: { state: 'all', sort: 'created', direction: 'desc' },
      map: (item) => {
        const ref = `${web}/pull/${numberRef(item.number)}`;
        add(item.created_at, 'pr', 'github.pr.opened', ref, item.title);
        if (item.merged_at) add(item.merged_at, 'pr', 'github.pr.merged', ref, item.title);
        else if (item.closed_at) add(item.closed_at, 'pr', 'github.pr.closed', ref, item.title);
      },
    },
    {
      label: 'deployments',
      path: `${api}/deployments`,
      query: {},
      map: (item) => add(item.created_at, 'deploy', 'github.deployment',
        `https://api.github.com${api}/deployments/${numberRef(item.id)}`,
        item.description || `Deployment to ${item.environment ?? 'unknown environment'}`),
    },
    {
      label: 'Actions runs',
      path: `${api}/actions/runs`,
      query: {},
      collection: 'workflow_runs',
      map: (item) => add(item.created_at, 'actions_run', 'github.actions.run',
        `${web}/actions/runs/${numberRef(item.id)}`, item.display_title ?? item.name,
        item.conclusion === 'failure' ? 'error' : 'info'),
    },
  ];
  const warnings = [];
  const omissions = [];
  const failures = [];
  let completedSources = 0;
  for (const source of sources) {
    try {
      for await (const item of pages(source.path, source.query, {
        fetch, token, collection: source.collection, deadline, requestTimeoutMs, maxPages, sleep,
      })) source.map(item);
      completedSources++;
    } catch (error) {
      omissions.push(source.label);
      failures.push(error);
      warnings.push(`GitHub collection incomplete: ${source.label} may be partial or omitted (${failureLabel(error)}).`);
    }
  }
  if (completedSources === 0) {
    const first = failures[0];
    if (first?.message.startsWith('GitHub REST request failed (HTTP ')) throw first;
    throw new Error('GitHub collection failed; no sources completed.');
  }
  const result = finishEvents(events.sort((a, b) => compareTimestamps(a.ts, b.ts)));
  result.warnings = warnings;
  result.omissions = omissions;
  return result;
}

module.exports = { collectGitHub };
