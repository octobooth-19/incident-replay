'use strict';

const { readFileSync } = require('node:fs');
const { validRepo } = require('./report.cjs');
const { isIssueNumber } = require('./generate-replay.cjs');

async function postIssueComment({ repo, issue, markdown, token, fetch = globalThis.fetch }) {
  if (!validRepo(repo) || !isIssueNumber(issue)) throw new Error('Expected owner/repo and a positive issue number');
  if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > 65_000) {
    throw new Error('Expected a non-empty generated Markdown comment under 65 KB');
  }
  if (!token) throw new Error('Missing GitHub workflow token');
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}/comments`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ body: markdown }),
    });
  } catch {
    throw new Error('Could not post the generated incident replay comment');
  }
  if (!response.ok) throw new Error(`Could not post the generated incident replay comment (HTTP ${response.status})`);
}

function workflowIssue(eventName, event) {
  if (eventName === 'issues' && event.action === 'labeled' && event.label?.name === 'incident') {
    const number = String(event.issue?.number ?? '');
    if (isIssueNumber(number)) return number;
  }
  if (eventName === 'workflow_dispatch') {
    const number = event.inputs?.issue_number ?? '';
    if (number === '' || isIssueNumber(number)) return number;
  }
  throw new Error('Workflow event does not identify a target incident issue');
}

if (require.main === module) {
  try {
    const [markdownPath, repo = process.env.GITHUB_REPOSITORY] = process.argv.slice(2);
    if (!markdownPath || !process.env.GITHUB_EVENT_PATH) throw new Error();
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const issue = workflowIssue(process.env.GITHUB_EVENT_NAME, event);
    if (!issue) {
      console.log('No issue selected; skipped posting the replay comment.');
    } else {
      postIssueComment({
        repo,
        issue,
        markdown: readFileSync(markdownPath, 'utf8'),
        token: process.env.GITHUB_TOKEN,
      }).then(() => console.log('Posted the generated replay comment.')).catch(() => {
        console.error('Could not post the generated incident replay comment. Check issue permissions and workflow logs.');
        process.exitCode = 1;
      });
    }
  } catch {
    console.error('Could not determine the target issue or read the generated replay comment.');
    process.exitCode = 1;
  }
}

module.exports = { postIssueComment, workflowIssue };
