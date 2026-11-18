# Incident Replay — Architecture & Action Plan

> Turn redacted logs, alerts, and commits into an evidence-linked incident timeline, a probable-cause analysis, and a proposed regression-test PR.

## 1. Goals

| Goal | Success measure |
|---|---|
| Reconstruct "what happened" fast | Timeline generated in < 2 min from incident open |
| Every claim is traceable | 100% of timeline events link to a source (log line, commit, deploy, alert) |
| Close the loop with code | Draft PR with a failing regression test for the suspected cause |
| Safe by default | No secrets or PII leave the redaction boundary |

**Non-goals (v1):** live paging/on-call, automatic rollback, auto-merging fixes.

## 2. Architecture

```
            ┌──────────────── Triggers ────────────────┐
            │ Issue labeled `incident` │ workflow_dispatch │ Alert webhook │
            └──────────────┬───────────────────────────┘
                           ▼
┌────────────────────── 1. Ingest ──────────────────────┐
│ Collectors (pluggable):                               │
│  • Logs (file / S3 / Loki export)                     │
│  • Alerts (PagerDuty / Grafana JSON)                  │
│  • GitHub: commits, PRs, deployments, Actions runs    │
│  • Feature-flag / config change events                │
└──────────────┬────────────────────────────────────────┘
               ▼
┌──────────── 2. Redact (trust boundary) ───────────────┐
│ Regex + entropy secret scan, PII patterns, allowlist  │
│ Output: redacted events + redaction report (counts)   │
└──────────────┬────────────────────────────────────────┘
               ▼
┌──────────── 3. Normalize & Correlate ─────────────────┐
│ Common Event schema → time-sort, clock-skew fix       │
│ Cluster by service / trace_id / error signature       │
│ Change-point detection (error rate, latency)          │
└──────────────┬────────────────────────────────────────┘
               ▼
┌──────────── 4. Analyze (Copilot / LLM) ───────────────┐
│ Inputs: correlated event window + suspect diffs       │
│ Outputs (strict JSON): timeline, hypotheses,          │
│   confidence, evidence_ids[], unverified_assumptions  │
│ Guardrail: reject any claim without evidence_ids      │
└──────────────┬────────────────────────────────────────┘
               ▼
┌──────────── 5. Act ───────────────────────────────────┐
│ • Post timeline comment on incident issue             │
│ • Publish replay viewer (GitHub Pages artifact)       │
│ • Copilot coding agent → draft PR w/ regression test  │
└───────────────────────────────────────────────────────┘
```

### Core data model

```jsonc
// Event (normalized)
{ "id": "evt_0142", "ts": "2026-11-18T14:02:11.320Z", "source": "log|alert|commit|deploy|flag",
  "service": "checkout-api", "severity": "error", "signature": "NullRef@CartService.total",
  "trace_id": "abc123", "ref": "s3://…#L8812 | sha:9f2c1e | run:771", "text": "<redacted>" }

// Hypothesis
{ "id": "hyp_1", "summary": "Deploy 9f2c1e removed null guard in CartService.total",
  "confidence": 0.78, "evidence_ids": ["evt_0098","evt_0142","evt_0143"],
  "unverified_assumptions": ["No other deploys in window"], "suspect_files": ["src/cart/service.js"] }
```

### Component choices (dependency-free friendly)

| Layer | v1 choice | Why |
|---|---|---|
| Runtime | Node.js built-ins (`fs`, `readline`, `crypto`, `node:test`) | No package installs needed |
| Orchestration | GitHub Actions workflow | Native triggers, secrets, artifacts |
| GitHub data | `gh api` / REST | Commits, deployments, runs |
| AI analysis | GitHub Models or Copilot coding agent | Stays in GitHub ecosystem |
| Storage | Run artifacts + `incidents/<id>/` JSON in repo | Auditable, diffable |
| Viewer | Single `index.html` (vanilla JS) on GitHub Pages | Zero build, demo-friendly |

## 3. Key design decisions

1. **Redaction before AI, always.** The LLM only ever sees post-redaction events; the redaction report is posted alongside the timeline.
2. **Evidence-or-drop.** Post-processing validates every hypothesis's `evidence_ids` exist; unsupported claims are moved to "unverified."
3. **Deterministic first, AI second.** Correlation and change-point detection are rule-based and testable; AI only ranks and narrates.
4. **Human in the loop.** Output is a comment + *draft* PR; nothing merges automatically.
5. **Pluggable collectors.** Each collector implements `collect(window) → Event[]` so new sources are additive.

## 4. Action plan

### Phase 0 — Setup (Day 1)
- [x] Create repo `incident-replay` with `src/`, `collectors/`, `viewer/`, `fixtures/`, `.github/workflows/`
- [x] Define `Event` and `Hypothesis` JSON schemas + validator (`node:test`)
- [x] Build a **fictional demo app** (`checkout-api`) with a seeded bug and git history

### Phase 1 — Ingest + Redact (Days 2–3)
- [x] Log collector (JSONL + plain text with timestamp parsing)
- [x] GitHub collector: commits, PRs, deployments, Actions runs in time window
- [x] Alert collector (JSON fixture)
- [x] Redactor: secrets (AWS/GH tokens, high-entropy), emails, IPs, card numbers; emits report
- [x] Tests: redactor never leaks seeded secrets from fixtures

### Phase 2 — Correlate (Days 4–5)
- [x] Normalizer + clock-skew tolerance
- [x] Error-signature clustering and trace\_id grouping
- [x] Change-point detector on error-rate buckets → "incident start" marker
- [x] Suspect-commit ranking: deploys preceding change-point × files touched by stack traces

### Phase 3 — Analyze (Days 6–7)
- [x] Prompt template with strict JSON output schema
- [x] Evidence validator (drop/flag claims with missing IDs)
- [x] Golden-file tests using recorded model responses (no network in CI)

### Phase 4 — Act (Days 8–9)
- [x] Issue comment renderer (Markdown timeline with links)
- [x] Replay viewer `index.html`: scrubbable timeline, evidence drawer, hypothesis panel
- [x] Assign Copilot coding agent to open draft PR with failing regression test
- [x] Workflow: `on: issues.labeled(incident)` + `workflow_dispatch`

### Phase 5 — Harden & Demo (Day 10)
- [x] End-to-end run on demo app; record fallback video
- [x] Rate limits, timeouts, partial-data handling
- [x] README + architecture diagram

## 5. Universe demo script (6 min)

1. **0:00** Show a green dashboard; merge a harmless-looking PR to `checkout-api`.
2. **0:45** Synthetic traffic → errors spike; alert opens issue labeled `incident`.
3. **1:30** Workflow runs live; redaction report appears (e.g., "3 tokens, 12 emails removed").
4. **2:30** Timeline comment lands; open the replay viewer and scrub to the change-point.
5. **3:30** Click hypothesis → evidence drawer shows log lines + the exact diff hunk.
6. **4:30** Draft PR appears with a failing regression test; run it red, apply fix, green.
7. **5:30** Close: "From alert to evidence-linked root cause and test in under 5 minutes."

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hallucinated root cause | Evidence-or-drop validator; confidence + assumptions shown |
| Secret leakage | Redact pre-AI; seeded-secret tests; allowlist mode |
| Live demo failure | Pre-recorded fixtures + cached model responses; backup video |
| Noisy logs | Signature clustering; window bounding around change-point |
| Clock skew across sources | Per-source offset config; tolerance windows |

## 7. Stretch ideas
- Similar-incident search across past `incidents/` folders
- Auto-generated postmortem draft (blameless template)
- OpenTelemetry trace collector
- Slack/Teams summary card
