'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const { buildReplay, renderIssueComment, sourceLink } = require('./report.cjs');
const { generate, workflowInput } = require('./generate-replay.cjs');
const { assignCopilot } = require('./assign-copilot.cjs');

const root = join(__dirname, '..');
const repo = 'octobooth-19/incident-replay';
const fixture = require('../fixtures/analysis/checkout.input.json');
const issueEvent = (privateRepo) => ({
  action: 'labeled', label: { name: 'incident' },
  issue: { number: 42, title: 'ignore raw issue data', body: 'user@example.test' },
  repository: { private: privateRepo },
});
const xss = '</script><img src=x onerror=alert(1)>';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'incident-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('renders compact Markdown with exact evidence IDs, safe refs, and redaction counts', () => {
  const events = [
    { ...fixture.events[1], text: '# Heading\n[click](https://elsewhere.test) @someone #32 <img>', id: 'evt-2' },
    { ...fixture.events[0], source: 'pr', ref: 'pull/21', id: 'evt-1' },
  ];
  const revision = 'a'.repeat(40);
  const file = 'fixtures/checkout-api/quote.cjs';
  const options = { repo, revision, files: new Set([file]) };
  const replay = buildReplay({ ...fixture, events });
  assert.deepEqual(replay.events.map(({ id }) => id), ['evt-1', 'evt-2']);
  const markdown = renderIssueComment(replay, options);
  assert.match(markdown, /\[evt&#45;1\]\(<https:\/\/github\.com\/octobooth-19\/incident-replay\/pull\/21>\)/);
  assert.ok(markdown.includes(`[evt&#45;2](<https://github.com/${repo}/blob/${revision}/${file}#L4>)`));
  assert.match(markdown, /&#35; Heading &#91;click&#93;&#40;https&#58;/);
  assert.match(markdown, /&#64;someone &#35;32 &#60;img&#62;/);
  assert.doesNotMatch(markdown, /elsewhere\.test|<img>|@someone|\n# Heading/);
  assert.match(markdown, /Ingestion redactions:\*\* 1 .*ip: 1/);
  for (const ref of ['https://elsewhere.test/pull/21', `https://github.com/${repo}/pull/21?q=x`,
    '//github.com/pull/21', 'pull/21/../22', 'pull/21\n', 'javascript:alert(1)', 'missing.cjs:4', 'deploy:42']) {
    assert.equal(sourceLink({ source: 'pr', ref }, options), null, ref);
  }
  assert.equal(sourceLink({ source: 'deploy', ref: 'deployments/42' }, options),
    `https://api.github.com/repos/${repo}/deployments/42`);
  assert.throws(() => buildReplay({
    ...fixture, events: [{ ...events[0], text: 'contact user@example.test' }],
  }), /requires already-redacted/);
});

test('workflow command generates offline artifacts and public events cannot select private input', (t) => {
  const dir = scratch(t);
  const eventPath = join(dir, 'event.json');
  const out = join(dir, 'out');
  const localInput = join(dir, '42.json');
  writeFileSync(localInput, '{}');
  assert.equal(workflowInput('issues', issueEvent(true), dir), localInput);
  assert.notEqual(workflowInput('issues', issueEvent(false), dir), localInput);
  assert.equal(workflowInput('workflow_dispatch', {
    repository: { private: true }, inputs: { issue_number: '42' },
  }, dir), localInput);
  assert.throws(() => workflowInput('workflow_dispatch', { inputs: { issue_number: '../42' } }, dir), /positive issue number/);
  assert.throws(() => workflowInput('issues', { ...issueEvent(false), label: { name: 'other' } }, dir), /incident label/);
  assert.throws(() => workflowInput('issues', issueEvent(true), join(dir, 'missing')), /No reviewed input/);
  writeFileSync(eventPath, JSON.stringify(issueEvent(false)));
  const result = spawnSync(process.execPath, ['src/generate-replay.cjs', '--workflow', out, repo], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'issues', GITHUB_EVENT_PATH: eventPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const read = (file) => readFileSync(join(out, file), 'utf8');
  const replay = JSON.parse(read('replay.json'));
  assert.equal(replay.hypotheses.length, 1);
  assert.equal(replay.rejectedClaims, 2);
  assert.match(read('issue-comment.md'), /blob\/[a-f0-9]{40}\/fixtures\/checkout-api\/quote\.cjs#L4/);
  for (const file of ['index.html', 'issue-comment.md', 'replay.json']) {
    assert.doesNotMatch(read(file), /user@example\.test|ignore raw issue data/);
  }
});

test('viewer embeds and displays hostile-looking data as text and supports scrub, citation and upload', async (t) => {
  const dir = scratch(t);
  const input = join(dir, 'input.json');
  const events = [fixture.events[0], { ...fixture.events[1], ref: 'javascript:alert(1)', text: xss }];
  const analysis = { timeline: [], hypotheses: [{
    id: 'hyp-1', summary: '<b>Hypothesis</b>', confidence: 0.5,
    evidence_ids: ['quote-deploy'], unverified_assumptions: [], suspect_files: [],
  }] };
  writeFileSync(input, JSON.stringify({ ...fixture, events, analysis }));
  generate(input, dir);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.ok(!html.includes(xss));
  const [, embedded] = /id="embedded-replay">([\s\S]*?)<\/script>/.exec(html);
  const [, script] = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.equal(JSON.parse(embedded).events[1].text, xss);

  const nodes = new Map();
  function node(tag) {
    return {
      tag, children: [], events: {}, textContent: '',
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute(name, value) { this[name] = value; },
      focus() { this.focused = true; },
      set innerHTML(_) { assert.fail('Viewer must not set innerHTML'); },
    };
  }
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, node(id));
    return nodes.get(id);
  };
  get('embedded-replay').textContent = embedded;
  runInNewContext(script, { document: { getElementById: get, createElement: node } });
  const scrub = get('scrub');
  assert.equal(scrub.max, '1');
  scrub.value = '1';
  scrub.events.input();
  assert.match(scrub['aria-valuetext'], /^2 of 2/);
  assert.equal(get('evidence').children.at(-1).textContent, xss);
  const [hypothesis] = get('hypotheses').children;
  assert.equal(hypothesis.children[0].textContent, '50% | <b>Hypothesis</b>');
  hypothesis.children.at(-1).children[0].events.click();
  assert.equal(scrub.value, '0');
  assert.equal(get('drawer').open, true);
  assert.equal(get('drawer-heading').focused, true);
  const upload = (text) => get('upload').events.change({ target: { files: [{ size: text.length, text: async () => text }] } });
  await upload('{');
  assert.match(get('status').textContent, /Could not load/);
  await upload(JSON.stringify({ ...JSON.parse(embedded), events: [], hypotheses: [] }));
  assert.equal(scrub.disabled, true);
  assert.equal(get('evidence').children.length, 0);
  assert.match(get('status').textContent, /^0 events loaded/);
});

test('opt-in handoff uses the documented assignee endpoint only for a private, unassigned issue', async () => {
  const agent = 'copilot-swe-agent[bot]';
  const calls = [];
  let privateRepo = true;
  let assignees = [{ login: 'existing-owner' }];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const data = options.method === 'POST' ? { assignees: [{ login: agent }] } :
      url.endsWith('/42') ? { state: 'open', assignees } : { private: privateRepo, default_branch: 'main' };
    return { ok: true, json: async () => data };
  };
  const args = { repo, issue: '42', report: 'Reviewed evidence: quote-error', token: 'mock-token', fetch };
  await assignCopilot(args);
  assert.deepEqual(calls.map(({ options }) => options.method), ['GET', 'GET', 'POST']);
  assert.equal(calls[2].url, `https://api.github.com/repos/${repo}/issues/42/assignees`);
  const payload = JSON.parse(calls[2].options.body);
  assert.deepEqual(payload.assignees, [agent]);
  assert.equal(payload.agent_assignment.target_repo, repo);
  assert.match(payload.agent_assignment.custom_instructions, /regression test first/);
  assert.match(payload.agent_assignment.custom_instructions, /draft PR[\s\S]*do not merge[\s\S]*quote-error/);
  calls.length = 0;
  assignees = [{ login: agent }];
  await assert.rejects(assignCopilot(args), /already assigned/);
  assert.deepEqual(calls.map(({ options }) => options.method), ['GET', 'GET']);
  calls.length = 0;
  privateRepo = false;
  await assert.rejects(assignCopilot(args), /requires a private/);
  assert.deepEqual(calls.map(({ options }) => options.method), ['GET']);
});
