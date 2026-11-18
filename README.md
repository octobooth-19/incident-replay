# Incident Replay

Incident Replay collects, redacts, and correlates service events. It also
prepares an analysis prompt and validates saved model responses locally.
`fixtures/` holds the fictional `checkout-api` and replay examples.
Replay reports are generated offline; there is no live incident-analysis model caller or Pages deployment.

## Validate records

Use Node.js 20+; no install is needed. The [Event](src/schemas/event.schema.json)
and [Hypothesis](src/schemas/hypothesis.schema.json) contracts use JSON Schema
Draft 2020-12. For parsed JSON records, `require('./src/validate.cjs')` exports
`validateEvent(record)` and `validateHypothesis(record)`. Each returns
`{ valid, errors }`, with field paths in the errors.

Events require a source reference and use UTC timestamps ending in `Z` (no
leap seconds). `signature` and `trace_id` are optional. Hypotheses require at
least one distinct evidence ID; validation checks the IDs' shape, not whether
they resolve to events.

```sh
node --test
```

## Collect and redact events

The CommonJS collectors return `{ events, redactionReport }`. Events conform
to the existing Event schema. The report contains a total and per-category
replacement counts, never the original values. Collectors redact free-form
fields including message text, service, signature, trace ID, and source
reference before returning results. Event IDs are derived from redacted
metadata. If any part of a trace ID matches a redaction rule, the entire
`trace_id` field is omitted and its matches still count in the report. Those
events cannot be grouped by trace ID, but they will not falsely share a
placeholder. Unchanged trace IDs remain available for grouping.
Keep source files local: the file collectors never make network
requests, and the GitHub collector only makes read-only REST requests using
the repository and query parameters, not local fixture or log data.

Redaction is **best-effort, not a guarantee** that all secrets or personal
data have been removed. It recognizes common AWS and GitHub credentials,
labeled secrets, high-entropy strings, email addresses, IPv4/IPv6 addresses,
and Luhn-valid card numbers. Encoded, unusually formatted, and unlabeled
low-entropy values can be missed; ordinary identifiers can be masked.
Review the output before sharing it outside the local trust boundary.
`require('./collectors/redact.cjs').redactEvents(events)` also accepts
already-valid Event arrays for standalone use.

Run this example from the repository root with Node.js 20+ (no install):

```sh
node <<'NODE'
const { collectLogs } = require('./collectors/log.cjs');
const { collectAlerts } = require('./collectors/alert.cjs');

async function main() {
  const options = { service: 'checkout-api' };
  for (const result of [
    await collectLogs('fixtures/ingestion/checkout.jsonl', options),
    await collectLogs('fixtures/ingestion/checkout.log', options),
    await collectAlerts('fixtures/ingestion/alerts.json', options),
  ]) console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
```

- **Logs:** A `.jsonl` file uses one object per nonblank line, with `ts` or
  `timestamp`, `text` or `message`, optional `severity` or `level`, and
  optional `service`, `signature`, and `trace_id`. Other files default to
  plain text: start each nonblank line with a zoned ISO timestamp (optionally
  in brackets), followed by an optional severity label and the message. Set
  `format: 'jsonl'` or `format: 'text'` to override the extension. Supply a
  fallback `service` when the records do not specify one. References include
  the file path and physical line number.
- **Alerts:** Supply a JSON array with `ts` or `timestamp`, `text` or
  `message`, and optional `severity` (defaults to `warn`), `service`,
  `signature`, and `trace_id`. The `service` option is the fallback.
  References include the path and one-based record number.

Timestamps require `Z` or a numeric UTC offset, are normalized to UTC,
and retain fractional precision. Malformed input fails the batch; errors do
not include input records or contents.

For GitHub, set `GH_TOKEN` or `GITHUB_TOKEN` in the environment if your
repository or rate limit requires authentication. Use read access to Contents,
Pull requests, Deployments, and Actions. For example:

```js
const { collectGitHub } = require('./collectors/github.cjs');
const result = await collectGitHub({
  repo: 'owner/repo',
  since: '2026-11-18T13:00:00Z',
  until: '2026-11-18T14:00:00Z',
  service: 'checkout-api', // optional; defaults to the repository name
});
```

The window is inclusive. Commits from the default branch use committer
time; pull requests emit opening and merge or unmerged-close events;
deployments and Actions runs use creation time. The Event sources are
`commit`, `pr`, `deploy`, and `actions_run`, respectively. PR signatures
distinguish opening, merging, and closing without a merge. Results
are sorted by event time. The collector reads paginated repository metadata;
it does not fetch Actions logs, artifacts, or deployment statuses. GitHub tests
use mocked REST responses and make no live requests.

## Correlate an incident

Pass reviewed, redacted collector Events to `correlateEvents` in
[`src/correlate.cjs`](src/correlate.cjs). For example, given the combined
Event array and the IDs of a known deployment and commit:

```js
const { correlateEvents } = require('./src/correlate.cjs');
const replay = correlateEvents(events, {
  sourceOffsetsMs: { alert: -250 }, // subtract 250 ms from a fast alert clock
  deploymentChanges: [{ deploymentId, commitId, files: ['src/quote.js'] }],
});
```

- `events` contains copies with corrected UTC timestamps, sorted by timestamp
  then Event ID, preserving sub-millisecond precision. `normalizeEvents`
  exposes just this step. IDs and original records are unchanged.
- `errorClusters` groups error and critical log/alert Events by service and
  signature. If no signature is provided, it uses the first message line
  with numeric tokens and whitespace normalized. `traces` groups explicitly
  present unmasked trace IDs across services; omitted IDs never match.
- `buckets` counts error/critical Events as a share of all log/alert Events
  in each populated UTC interval `[startMs, startMs + bucketMs)`. The default
  bucket is one minute. `changePoint` marks the first boundary where the rate
  rises by `minRateIncrease` (default 0.25), comparing adjacent populated
  buckets with at least `minBucketEvents` (default 1) records each. Gaps do not
  count as healthy baselines, and no qualifying rise returns `null`.
- `suspects` scores commits explicitly linked to deployments strictly before
  that boundary. Each distinct changed file matching a Node.js stack frame
  from an error at or after the boundary in the deployed service adds one
  point. Relative paths match exactly; absolute paths match by repository
  path suffix. Ties favor newer deployments, then commit and deployment ID.
  Only the best-ranked deployment per commit is returned. Ranking is a
  heuristic, not evidence of causation.

The GitHub collector does not provide deploy-to-commit links or changed
files. Supply those as local, reviewed metadata in `deploymentChanges`, using
Event IDs and already-redacted repository-relative file paths. No metadata is
fetched and no commit is inferred from timing alone.

## Prepare and validate offline analysis

```js
const { buildAnalysisPrompt, validateAnalysisResponse } = require('./src/analyze.cjs');
const prompt = buildAnalysisPrompt(replay.events); // { system, user }, no request is sent
const analysis = validateAnalysisResponse(savedResponseText, replay.events);
```

Only supply already-redacted Events and use the exact same evidence set for
prompt construction and validation. The prompt builder applies the Phase 1
checks again and rejects detectable unredacted fields, treating Phase 1's
SHA-256 Event IDs as opaque identifiers. This check is not a substitute for
reviewing the collector output. The prompt carries only Event data, not the
deployment metadata or raw source records.

The [analysis schema](src/schemas/analysis.schema.json) requires
`hypotheses` and `timeline` arrays. Every claim must cite at least one distinct
Event ID. Invalid JSON or a schema violation (including absent or empty
citations) rejects the response. A well-formed claim that cites any unknown ID
is removed and reported in `rejected` by array name and index without
echoing its content. Retained prose also passes through best-effort redaction.
Resolved IDs establish that the cited records exist, not that they prove the
claim. Golden tests replay local response snapshots in `fixtures/analysis/`;
no test contacts a model.

## Render a replay and review an issue comment

```sh
node src/generate-replay.cjs --demo /tmp/checkout-replay octobooth-19/incident-replay
```

Open the generated `index.html` directly in a browser, or open
[`viewer/index.html`](viewer/index.html) and select the generated `replay.json`.
No server or network connection is needed. Use the slider (including arrow keys),
Previous/Next buttons, or a claim's Evidence buttons to open the corresponding event.
`issue-comment.md` is a concise preview for manual posting **after review**. It
preserves event IDs in citations and only links recognized same-repository GitHub
references or paths tracked at the current Git commit (`path:line` and `path#Lline`
are supported). Unrecognized refs, including local-only paths, remain text. Omit
`owner/repo` to render without links.

Replace `--demo` with a local input JSON file for a real replay. Its
`events` must already be redacted, `redactionReport` is the collector's
`{ total, counts }` (sum corresponding categories when combining collectors),
and `analysis`, if present, is the saved response object described above.
Optional `correlation` accepts the existing correlation options. Without
analysis, the comment falls back to the event timeline and makes no hypotheses.
Keep real inputs and outputs local unless approved for sharing; automated
redaction cannot guarantee removal of all sensitive data.

### GitHub Actions

On the default branch, applying the `incident` label or manually dispatching
**Incident replay** builds an Actions artifact containing the HTML, JSON, and
Markdown. Enable Actions and create the `incident` label. A blank manual
dispatch runs the fictional demo. A public repository runs **only** the
fictional demo, even if an issue number is supplied. In a private repository,
a numbered run uses `incidents/<issue-number>.json` from the default branch
and fails if the input is missing. Only commit approved redacted input there
if repository history and the Actions artifact's audience are both appropriate;
otherwise use the local generator. The workflow never reads the issue body,
posts the comment, assigns agents, or deploys to Pages. Artifacts expire after
seven days.

### Opt-in Copilot handoff

Enable Copilot cloud agent for the repository and organization, and use an
eligible GitHub user with write access. In a **private** repository, prepare a
dedicated open handoff issue. Review its title, body, and comments so Copilot
isn't given any raw incident context. Review the generated Markdown and trim it
to the relevant redacted evidence (at most 16 KB). Then run:

```sh
# Set COPILOT_ASSIGNMENT_TOKEN in the environment first; do not commit it.
node src/assign-copilot.cjs --reviewed owner/private-repo 123 /path/to/reviewed-report.md
```

This uses GitHub's [documented REST issue assignment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api#using-the-rest-api).
Use a user token, not the Actions `GITHUB_TOKEN`. GitHub documents fine-grained
PAT permissions of Metadata read and Actions, Contents, Issues, and Pull
requests read/write (or `repo` for a classic PAT). The assignment asks Copilot
to use only the reviewed excerpt as incident evidence, demonstrate a focused
test failing against unchanged code, and propose a fix in a draft PR without
merging. These are instructions, not access controls; the maintainer must
review the PR and confirm the failing baseline and draft status.

## Reproduce the checkout regression

The CLI quotes a fixed cart with two $25 items. The correct result is $50 with
free shipping. The refactor drops item quantity, so the demo actually quotes
$25 plus $5 shipping, for a $30 total.

```sh
node fixtures/checkout-api/quote.cjs
node --test fixtures/checkout-api/quote.regression.cjs  # intentionally exits 1
git --no-pager log --oneline -- fixtures/checkout-api
git --no-pager show 23555e8 -- fixtures/checkout-api/quote.cjs
```

To run the same regression test against the good commit without changing your
current branch:

```sh
git worktree add --detach ../incident-replay-baseline 90d3400
(cd ../incident-replay-baseline && node --test fixtures/checkout-api/quote.regression.cjs)
git worktree remove ../incident-replay-baseline
```
