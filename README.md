# Incident Replay

Phase 1 adds ingestion and local redaction to the Phase 0 data contracts.
`fixtures/` holds the fictional `checkout-api` and sample collector inputs.
Correlation, analysis, publication, and workflows are not implemented.

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
node --test collectors/ingestion.test.cjs src/validate.test.cjs fixtures/checkout-api/quote.test.cjs
```

## Collect and redact events

The CommonJS collectors return `{ events, redactionReport }`. Events conform
to the existing Event schema. The report contains a total and per-category
replacement counts, never the original values. Collectors redact free-form
fields including message text, service, signature, trace ID, and source
reference before returning results. Event IDs are derived from redacted
metadata. Keep source files local: the file collectors never make network
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
deployments and Actions runs use creation time. The existing Event schema
has no PR or Actions source: PR events use `commit`, while Actions runs
use `deploy`. `github.*` signatures distinguish the event kinds. Results
are sorted by event time. The collector reads paginated repository metadata;
it does not fetch Actions logs, artifacts, or deployment statuses. GitHub tests
use mocked REST responses and make no live requests.

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
