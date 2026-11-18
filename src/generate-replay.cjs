'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync, mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { buildReplay, renderIssueComment, validRepo } = require('./report.cjs');

const root = join(__dirname, '..');
const demo = join(root, 'fixtures/analysis/checkout.input.json');
const maxBytes = 5 * 1024 * 1024;
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));

function isIssueNumber(value) {
  return typeof value === 'string' && value.trim() === value && /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value));
}

function workflowInput(eventName, event, incidentDir) {
  let issue;
  if (eventName === 'issues') {
    if (event.action !== 'labeled' || event.label?.name !== 'incident') {
      throw new Error('Expected an incident label event');
    }
    issue = String(event.issue?.number);
  } else if (eventName === 'workflow_dispatch') {
    issue = event.inputs?.issue_number ?? '';
  } else {
    throw new Error('Unexpected workflow trigger');
  }
  if (issue !== '' && !isIssueNumber(issue)) throw new Error('Expected a positive issue number');
  if (event.repository?.private !== true || issue === '') return demo;
  const path = join(incidentDir, `${issue}.json`);
  if (existsSync(path)) return path;
  throw new Error('No reviewed input for this private issue');
}

function generate(inputPath, outputDir, repo) {
  if (repo !== undefined && !validRepo(repo)) throw new Error('Expected GitHub repository as owner/name');
  const input = readJSON(inputPath);
  if (inputPath === demo) input.analysis = readJSON(join(root, 'fixtures/analysis/checkout.response.json'));
  const replay = buildReplay(input);
  const json = `${JSON.stringify(replay, null, 2)}\n`;
  if (Buffer.byteLength(json) > maxBytes) throw new Error('Replay bundle exceeds 5 MiB');
  const template = readFileSync(join(root, 'viewer/index.html'), 'utf8');
  // Script data is raw HTML text, even when its MIME type is application/json.
  const embedded = json.replace(/</g, '\\u003c');
  const viewer = template.replace(
    '<script type="application/json" id="embedded-replay">null</script>',
    () => `<script type="application/json" id="embedded-replay">${embedded}</script>`,
  );
  let repository;
  if (repo) {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const files = new Set(execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
      cwd: root, encoding: 'utf8',
    }).split('\0').filter(Boolean));
    repository = { repo, revision, files };
  }
  const comment = renderIssueComment(replay, repository);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outputDir, 'replay.json'), json, { mode: 0o600 });
  writeFileSync(join(outputDir, 'index.html'), viewer, { mode: 0o600 });
  writeFileSync(join(outputDir, 'issue-comment.md'), comment, { mode: 0o600 });
}

function main([input, output, repo], env = process.env) {
  if (!input || !output) throw new Error('Usage: node src/generate-replay.cjs <input.json|--demo|--workflow> <output-dir> [owner/repo]');
  const path = input === '--workflow'
    ? workflowInput(env.GITHUB_EVENT_NAME, readJSON(env.GITHUB_EVENT_PATH), join(root, 'incidents'))
    : input === '--demo' ? demo : input;
  generate(path, output, repo);
  console.log(path === demo ? 'Generated fictional demo replay.' : 'Generated replay from reviewed input.');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {
    // Filesystem and JSON parser errors can contain private paths or source text.
    console.error('Replay generation failed. Check that the reviewed input exists and has valid redacted Events, analysis and redaction counts.');
    process.exitCode = 1;
  }
}

module.exports = { generate, workflowInput, isIssueNumber };
