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

Layer 3 was enabled after measuring cache behaviour: changing reasoning effort
does **not** evict the prompt cache of other efforts. Cache is kept per
`(prefix, effort)`, so the only cost is the first touch of a new effort being
cold — measured to cost exactly the same as a cold new prefix.

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
```

## Verify

```bash
bash verify.sh
```

The script checks 6 items: structure, syntax, dependency resolution, profile
registration, real boot log, and real Jev calls against known-answer cases.
Exit 1 if any item fails.

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
