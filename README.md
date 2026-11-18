# Incident Replay

Phase 0 only. `src/` contains the data contracts, `fixtures/` holds the
fictional `checkout-api`, and `collectors/`, `viewer/`, and `.github/workflows/`
are placeholders. No ingestion, analysis, workflow, or deployment is configured.

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
node --test src/validate.test.cjs fixtures/checkout-api/quote.test.cjs
```

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
