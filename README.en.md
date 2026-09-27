# dsh-jev-gate

**English** · [Tiếng Việt](README.md)

Puts [Jev](https://typesafe.ai/) (TypeSafe System One) into three high-value
moments of [DeepSeek Harness](https://github.com/deepseek-ai/dsh), following one
principle:

> **The LLM understands and does the work. Jev only answers CLOSED questions at
> the moments where a wrong decision is expensive.**

Jev does not generate text, does not plan, does not pick tools. It only scores a
closed question and returns a probability. This plugin uses Jev as **three
checkpoints**, not as a second brain.

## Three layers

| Layer | Hook | Question | Type | Default |
|---|---|---|---|---|
| Destructive gate | `tools/pre-execute` | Would this command destroy data irrecoverably? | `noul` | **on** |
| Completion check | `agent/turn-stopping` | Done yet? Any evidence? Does it need execution? | `noul` ×3 | **on** |
| Effort routing | `agent/request` | Does the next step need deep thinking? For how long? | `choice` ×2 | **on** |
| Spawn hint | `agent/pre-step` | Does this task have genuinely INDEPENDENT parts? | `noul` | **on** |

Layer 3 was enabled after measuring cache behaviour: changing reasoning effort
does **not** evict the prompt cache of other efforts. Cache is kept per
`(prefix, effort)`, so the only cost is the first touch of a new effort being
cold — measured to cost exactly the same as a cold new prefix.

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
│       └── p ≥ 0.7  ──► DENY (the command does not run)
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
├── LAYER 4 · spawn hint              hook: agent/pre-step (step 1 only)
│   └── asks Jev (noul): "does this task have genuinely INDEPENDENT parts?"
│       ├── p < 0.6  ──► silent
│       └── p ≥ 0.6  ──► inject one soft hint (the model decides; the plugin cannot spawn)
│
└── every decision ──► ~/.local/share/dsh-jev-gate/decisions.jsonl
```

Every Jev call **fails open**: if Jev errors, times out, or returns garbage,
work proceeds as if Jev never existed.

**One turn passing through the 3 layers** — three checkpoints at three different moments:

```
User types a prompt
      │
      ▼
LAYER 3 · agent/request      on every model call: does the next step need deep thinking?
      │                      → writes reasoningEffort, provider and model UNCHANGED
      ▼
LLM generates a reply or a tool call
      │
      ▼
LAYER 1 · tools/pre-execute  bash/pwsh only: would this command destroy data?
      │                      → p ≥ 0.7 means DENY, the command does not run
      ▼
LAYER 2 · agent/turn-stopping when the model wants to stop: done? any evidence?
      │                      → unfinished or no proof means steer to keep working
      ▼
turn ends
```

> LAYER 3 runs on **every step**, while the LLM and LAYER 1 **repeat** on every
> tool call. The diagram above draws one pass for readability.

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
- **Short timeouts.** The gate sits in the critical path of every tool call: 2s.
  Slower than that, it fails open.
- **Pinned model.** `jev-1.13.0`, not `jev-latest`, because the alias shifts
  when a new version ships and answers can change without notice.
- **Thresholds by consequence.** The destructive gate (0.7) uses a different
  threshold than the completion check (0.5). No shared number.
- **Bounded state.** Only the goal, the last 6 tool results (700 chars each),
  and the final reply are sent. Never the whole transcript.
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
    destructiveThreshold: 0.7   # p >= this blocks the destructive command
    completionThreshold: 0.5    # p < this means "not done yet"
    evidenceThreshold: 0.5      # p < this means "evidence missing"
    executionThreshold: 0.5     # p >= this means the goal needs execution
    gateTimeoutMs: 2000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    maxLeaseSteps: 10
    enableDestructiveGate: true
    enableCompletionCheck: true
    enableEffortRouting: true   # on by default
    spawnThreshold: 0.6         # p >= this hints at using subagent
    spawnTimeoutMs: 4000
    enableSpawnHint: true       # on by default
```

## Verify

```bash
bash verify.sh              # 6 items, needs DSH running + TYPESAFE_API_KEY
node tests/offline.mjs      # no secret needed — fail-open, model invariance, export contract
node tests/live-check.mjs   # needs TYPESAFE_API_KEY + network
```

`verify.sh` checks: structure, syntax, dependency resolution, profile
registration, real boot log, and real Jev calls against known-answer cases.
Exit 1 if any item fails.

CI (GitHub Actions) runs `offline.mjs` on Node 20 + 22 for every push/PR, and
`live-check.mjs` when the repo has a `TYPESAFE_API_KEY` secret. See
[`.github/workflows/verify.yml`](.github/workflows/verify.yml).

Changelog: [CHANGELOG.md](CHANGELOG.md).

## Measured results (2026-09-27, `jev-1.13.0`)

| Measurement | Result |
|---|---|
| 5 end-to-end test cases (real handler + real Jev) | 9/9 pass, reproduced 3× |
| Destructive gate on 20 real commands | 20/20 correct (recall 100%, precision 100%) |
| Does deny actually prevent execution? | yes — canary intact after a denied `rm -rf` |
| Fail-open (missing key / broken store / no llm) | 3/3 pass |
| Effort gear-shifting by difficulty | `low→low→high→low→high` across 5 steps |
| Does it change the model? | no — invariant across every test |
| Per-gate latency | median ~250ms |

## What this plugin does NOT do

- Does not route models. It never changes the model, only (optionally) the effort.
- Does not analyse the user's input. That needs an LLM, not Jev.
- Does not pick tools. The `state` Jev sees is a static catalog, while what
  decides tool choice is the tool result just returned — which only exists after
  the tool has run.
- Does not replace the agent's judgement. A recommendation is not an authorisation.

## Uninstall

```bash
dsh plugin --profile web remove dsh-jev-gate
rm -rf ~/.local/share/dsh-jev-gate
```

## License

MIT
