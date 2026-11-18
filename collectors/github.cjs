'use strict';

const { normalizeTimestamp, compareTimestamps, finishEvents } = require('./event.cjs');

async function* pages(path, query, { fetch, token, collection }) {
  for (let page = 1; ; page++) {
    const url = new URL(path, 'https://api.github.com');
    url.search = new URLSearchParams({ ...query, per_page: '100', page: String(page) });
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('GitHub REST request failed');
    }
    if (!response.ok) throw new Error(`GitHub REST request failed (HTTP ${response.status})`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('GitHub REST returned invalid JSON');
    }
    const items = collection ? body?.[collection] : body;
    if (!Array.isArray(items)) throw new Error('GitHub REST returned an unexpected response');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('GitHub REST returned an invalid item');
      }
      yield item;
    }
    // Follow the relation, not the URL: never forward credentials to a response-supplied host.
    if (!/<[^>]*>\s*;\s*rel="next"/.test(response.headers.get('link') ?? '')) return;
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

async function collectGitHub({
  repo, since, until, service, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, fetch = globalThis.fetch,
} = {}) {
  if (!isRepository(repo)) throw new Error('Expected GitHub repository as owner/name');
  const start = normalizeTimestamp(since);
  const end = normalizeTimestamp(until);
  if (compareTimestamps(start, end) > 0) throw new Error('Expected since to be before or equal to until');
  service ??= repo.split('/')[1];
  if (typeof service !== 'string' || !service.length) throw new Error('Expected a non-empty service');
  const api = `/repos/${repo}`;
  const web = `https://github.com/${repo}`;
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
  for await (const item of pages(`${api}/commits`, { since: floor, until: ceiling }, { fetch, token })) {
    if (typeof item.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(item.sha)) throw new Error('Invalid GitHub commit SHA');
    add(item.commit?.committer?.date, 'commit', 'github.commit', `${web}/commit/${item.sha}`, item.commit?.message);
  }
  for await (const item of pages(`${api}/pulls`, { state: 'all', sort: 'created', direction: 'desc' }, { fetch, token })) {
    const ref = `${web}/pull/${numberRef(item.number)}`;
    add(item.created_at, 'commit', 'github.pr.opened', ref, item.title);
    if (item.merged_at) add(item.merged_at, 'commit', 'github.pr.merged', ref, item.title);
    else if (item.closed_at) add(item.closed_at, 'commit', 'github.pr.closed', ref, item.title);
  }
  for await (const item of pages(`${api}/deployments`, {}, { fetch, token })) {
    add(item.created_at, 'deploy', 'github.deployment', `https://api.github.com${api}/deployments/${numberRef(item.id)}`,
      item.description || `Deployment to ${item.environment ?? 'unknown environment'}`);
  }
  for await (const item of pages(`${api}/actions/runs`, {}, { fetch, token, collection: 'workflow_runs' })) {
    add(item.created_at, 'deploy', 'github.actions.run', `${web}/actions/runs/${numberRef(item.id)}`,
      item.display_title ?? item.name, item.conclusion === 'failure' ? 'error' : 'info');
  }
  return finishEvents(events.sort((a, b) => compareTimestamps(a.ts, b.ts)));
}

module.exports = { collectGitHub };
