# dsh-jev-gate

**English** · [Tiếng Việt](README.md)

![dsh-jev-gate architecture](assets/architecture.png)

Puts [Jev](https://typesafe.ai/) (TypeSafe System One) into **four high-value
moments** of [DeepSeek Harness](https://github.com/deepseek-ai/dsh), following
one principle:

> **The LLM understands and does the work. Jev only answers CLOSED questions at
> the moments where a wrong decision is expensive.**

Jev does not generate text, does not plan, does not write code. It only scores a
closed question and returns a probability. This plugin uses Jev as **four
checkpoints**, not as a second brain.

## Five layers

| Layer | Hook | Question | Type | Default |
|---|---|---|---|---|
| Destructive gate | `tools/pre-execute` | Would this command destroy data irrecoverably? | `noul` | **on** |
| User authorization | `tools/pre-execute` | Did the user actually ask to delete this exact thing? | `choice` | **on** |
| Completion check | `agent/turn-stopping` | Done yet? Any evidence? Does it need execution? | `noul` ×3 | **on** |
| Effort routing | `agent/request` | Does the next step need deep thinking? For how long? | `choice` ×2 | **on** |
| Approach choice | `agent/pre-step` | Which approach is optimal for this task? | `choice` | **on** |

Layer 3 was enabled after measuring cache behaviour: changing reasoning effort
does **not** evict the prompt cache of other efforts. Cache is kept per
`(prefix, effort)`, so the only cost is the first touch of a new effort being
cold — measured to cost exactly the same as a cold new prefix.

### Why the "User authorization" layer exists

The old destructive gate **could not tell session scratch from real data**. Real
log: `rm -rf /tmp/gtest` (a test directory this very session created) was blocked
at p=0.77, while `rm -rf <nonexistent path>` scored only 0.40 — so legitimate
cleanup was blocked and had to be retried (one command was blocked **7 times in a
row**).

The new layer runs **only** when layer 1 has already judged the command
destructive, and it answers one question: did the user themselves ask to delete
exactly this? Blocking now requires **destructive AND not user-authorized**:

```
p ≥ 0.7  ──► ask again "did the user authorize this?"
              ├── authorized                  ──► ALLOW
              └── narrower/unrelated/quoted   ──► DENY
```

Four `choice` branches instead of `noul` because they are four situations
different in kind, not four levels of one quantity — so there is no threshold to
tune, and the `quoted` branch catches pasted content claiming authority.

Measured on the real API (`jev-1.13.0`, 6–10 runs/case):

| Group | Result |
|---|---|
| Pasted content claiming authority (web/README/log, translate/summarise requests, forged "the user approved this") | **0/66** returned `authorized` |
| Destructive commands the user did not ask for (unrelated, vague, scope escalation) | **0/48** returned `authorized` |
| Legitimate user-requested cleanup (exact path, glob, cache, session scratch) | **46/48** returned `authorized` |

The `user_request` evidence is taken **only** from genuine user messages
(`source.kind === 'user'`). `notePrompt` used to join every `role=user` message —
including background job output (`tool-jobs`) and the plugin's own injected hints
— so untrusted content could leak into the "user request" field.

This layer is **fail-closed**: on error/timeout it keeps blocking. Unlike layer 1
(fail-open) — an error of Jev's must not become a silent allow in a defensive
layer.

## Architecture

The plugin is a thin layer between the **DSH engine** and the **Jev API**. It
only registers hooks, asks Jev one closed question, then hands the decision back
to the engine. It does not swap the model, does not generate content, and does
not keep the transcript.

```
dsh-jev-gate
│
├── LAYER 1 · destructive gate        hook: tools/pre-execute
│   └── asks Jev (noul): "would this command destroy data irrecoverably?"
│       ├── p < 0.7  ──► allow
│       └── p ≥ 0.7  ──► ask LAYER 1b
│
├── LAYER 1b · user authorization     hook: tools/pre-execute (only when layer 1 denies)
│   └── asks Jev (choice): "did the user ask to delete this exact thing?"
│       ├── authorized ──► allow
│       └── narrower/unrelated/quoted ──► DENY
│
├── LAYER 2 · completion check        hook: agent/turn-stopping
│   └── asks Jev (noul ×3): "done? any evidence? does it need execution?"
│       ├── done + proven      ──► let the turn end
│       └── unfinished / no proof ──► steer to keep working
│
├── LAYER 3 · effort routing          hook: agent/request
│   └── asks Jev (choice ×2): "does the next step need deep thinking? for how long?"
│       └── writes reasoningEffort  ──► provider and model UNCHANGED
│
├── LAYER 4 · approach choice         hook: agent/pre-step (step 1 only)
│   └── asks Jev (choice): "which approach is optimal for this task?"
│       ├── one-command-scan   ──► "run the single command, do not split it"
│       ├── scripted-analysis  ──► "write one short script and read its result"
│       ├── parallel-workers   ──► "delegate to subagents in parallel"
│       └── guided-interview   ──► "clarify with the user first"
│           (silent below conf 0.3; the model decides, the plugin does not act)
│
└── every decision ──► ~/.local/share/dsh-jev-gate/decisions.jsonl
```

Every Jev call **fails open**: if Jev errors, times out, or returns garbage,
work proceeds as if Jev never existed.

Exception: the user-authorization layer (1b) is **fail-closed** — if it errors, the
command stays blocked rather than being silently allowed.

**One turn passing through the layers** — checkpoints at different moments:

```
User types a prompt
      │
      ▼
LAYER 4 · agent/pre-step    step 1 only: which approach is optimal?
      │                     → injects a hint (one command / script / subagents / clarify)
      ▼
LAYER 3 · agent/request     on every model call: does the next step need deep thinking?
      │                     → writes reasoningEffort, provider and model UNCHANGED
      ▼
LLM generates a reply or a tool call
      │
      ▼
LAYER 1 · tools/pre-execute  bash/pwsh only: would this command destroy data?
      │                      → p < 0.7: allow
      │                      → p ≥ 0.7: ask LAYER 1b
      ▼
LAYER 1b · user authorization  did the user ask to delete this exact thing?
      │                      → authorized: allow
      │                      → otherwise: DENY, the command does not run
      ▼
LAYER 2 · agent/turn-stopping when the model wants to stop: done? any evidence?
      │                      → unfinished or no proof means steer to keep working
      ▼
turn ends
```

> LAYER 4 runs once per turn (step 1). LAYER 3 runs on **every step**, while the
> LLM, LAYER 1 and LAYER 1b **repeat** on every tool call. The diagram above
> draws one pass for readability.

## Install

Requires DSH `>= 0.1.0-rc.7` and a Jev API key ([typesafe.ai](https://typesafe.ai/)).

```bash
# install
dsh plugin --profile web add git+https://github.com/dungle03/dsh-jev-gate.git

# update to latest
dsh plugin --profile web add git+https://github.com/dungle03/dsh-jev-gate.git
```

Then set the Jev key (either way):

```bash
# option 1: environment variable
export TYPESAFE_API_KEY="apikey_..."

# option 2: DSH credential store (recommended — independent of your shell)
# add to ~/.dsh/.credentials.yaml under refs:
#   refs:
#     TYPESAFE_API_KEY: "apikey_..."
```

Restart DSH. Verify:

```bash
bash ~/.dsh/profiles/web/node_modules/dsh-jev-gate/verify.sh
```

> No key? The plugin **fails open** — every gate silently allows, nothing is
> blocked. Set the key and restart to enable it.

## Operating principles

- **Absolute fail-open.** If Jev errors, times out, or returns garbage, the
  action proceeds as if Jev never existed. Jev must never turn its own outage
  into a workflow outage.
- **Short timeouts.** The destructive gate sits in the critical path of every
  tool call: 2s. Slower than that, it fails open.
- **Pinned model.** `jev-1.13.0`, not `jev-latest`, because the alias shifts
  when a new version ships and answers can change without notice.
- **Thresholds by consequence.** The destructive gate (0.7) differs from the
  completion check (0.5) and the spawn hint (0.6). No shared number.
- **Bounded state.** Only the goal/task (up to 1,500 chars), the last 6 tool
  results (700 chars each), and the final reply (900 chars) are sent. Never the
  whole transcript.
- **Never changes the model.** The plugin only reads `provider`/`model` and
  optionally writes `reasoningEffort`. Your model is never swapped.
- **Verifiable log.** Every decision is written to
  `~/.local/share/dsh-jev-gate/decisions.jsonl` (mode 0600).

## Configuration

Edit the profile (`~/.dsh/profiles/web/cordis.patch.yml`) or use the Plugins page:

```yaml
- id: jev-gate
  name: dsh-jev-gate
  config:
    destructiveThreshold: 0.7   # p >= this counts as destructive
    completionThreshold: 0.5    # p < this means "not done yet"
    evidenceThreshold: 0.5      # p < this means "evidence missing"
    executionThreshold: 0.5     # p >= this means the goal needs execution
    approachConfidenceThreshold: 0.3
    gateTimeoutMs: 2000
    authorizationTimeoutMs: 4000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    spawnTimeoutMs: 4000
    maxLeaseSteps: 10
    enableDestructiveGate: true
    enableAuthorizationOverride: true   # user-authorization layer — off restores the old block-everything behaviour
    enableCompletionCheck: true
    enableEffortRouting: true
    enableSpawnHint: true
```

## Verify

```bash
bash verify.sh              # 6 items, needs DSH running + TYPESAFE_API_KEY
node tests/offline.mjs      # 35 checks, no secret needed
node tests/live-check.mjs   # 15 checks, needs TYPESAFE_API_KEY + network
```

- `verify.sh` — 6 items: structure, syntax, dependency resolution, profile
  registration, real boot log, real Jev calls against known-answer cases.
  Exit 1 if any item fails.
- `tests/offline.mjs` — no secret needed: fail-open, model invariance, shell-tool
  gating only, layer-4 guards, genuine-user-message filtering, export contract.
- `tests/live-check.mjs` — real Jev API calls against known-answer cases.

CI (GitHub Actions) runs `offline.mjs` on Node 20 + 22 for every push/PR, and
`live-check.mjs` when the repo has a `TYPESAFE_API_KEY` secret. See
[`.github/workflows/verify.yml`](.github/workflows/verify.yml).

Changelog: [CHANGELOG.md](CHANGELOG.md).

## Measured results (2026-09-27 → 28, `jev-1.13.0`)

| Measurement | Result |
|---|---|
| Destructive gate on 20 real commands | 20/20 correct (recall 100%, precision 100%) |
| Does deny actually prevent execution? | yes — canary intact after a denied `rm -rf` |
| User-authorization layer — pasted content claiming authority | 0/66 returned `authorized` |
| User-authorization layer — destructive commands not asked for | 0/48 returned `authorized` |
| User-authorization layer — legitimate user-requested cleanup | 46/48 returned `authorized` |
| Real handler + real Jev, 12 end-to-end cases | 12/12 correct |
| User-authorization layer fails closed on error | yes — a session read error still blocks |
| Completion check: evidence vs bare claim | 3/3 branches correct |
| Fail-open layer 1 (missing key / broken store / no llm) | 3/3 pass |
| Effort gear-shifting by difficulty | `low→low→high→low→high` across 5 steps |
| Approach choice | 9/10 correct (disk scan → one command; 5 topics → parallel; vague → clarify) |
| Does it change the model? | no — invariant across every test |
| Per-gate latency | median ~250ms (layer 1b adds ~250ms, only when layer 1 already blocked) |

## What this plugin does NOT do

- **Does not route models.** It never changes the model, only (optionally) the effort.
- **Does not plan or generate content.** Jev only returns a probability for a
  closed question; the LLM is still what understands and does the work.
- **Does not act on the chosen approach by itself.** Layer 4 only *hints*; DSH's
  `agent` API exposes no way to call a tool directly, so the model decides. The
  model may ignore it — and Jev picks the wrong approach about 1 in 10 times in
  the measured set.
- **Does not replace the agent's judgement.** A recommendation is not an authorisation.

## Uninstall

```bash
dsh plugin --profile web remove dsh-jev-gate
rm -rf ~/.local/share/dsh-jev-gate
```

## License

MIT
