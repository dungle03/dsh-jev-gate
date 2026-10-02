# dsh-jev-gate

**English** · [Tiếng Việt](README.md)

![dsh-jev-gate architecture](assets/architecture.png)

*Interactive version (pan/zoom, light/dark theme, search): open
[`assets/architecture.html`](assets/architecture.html) in a browser.*

Puts [Jev](https://typesafe.ai/) (TypeSafe System One) into **eight high-value
moments** of [DeepSeek Harness](https://github.com/deepseek-ai/dsh), following
one principle:

> **The LLM understands and does the work. Jev only answers CLOSED questions at
> the moments where a wrong decision is expensive.**

Jev does not generate text, does not plan, does not write code. It only scores a
closed question and returns a probability. This plugin uses Jev as **eight
checkpoints**, not as a second brain.

## Eight layers

| Layer | Hook | Question | Type | Default |
|---|---|---|---|---|
| **1** · Destructive gate | `tools/pre-execute` | Would this command destroy data irrecoverably? | `noul` | **on** |
| **1b** · User authorization | `tools/pre-execute` (only when layer 1 blocks) | Did the user actually ask to delete this exact thing? | `choice` | **on** |
| **2** · Completion check | `agent/turn-stopping` | Done yet? Any evidence? Does it need execution? | `noul` ×3 | **on** |
| **3** · Effort routing | `agent/request` | (deterministic rules — no Jev call) | — | **on** (sticky per turn) |
| **4+5** · Approach + context choice | `agent/pre-step` (step 1) | Which approach is optimal? Which files must be read first? | `choice` + `noul` ×N | **on** |
| **6** · Tool-failure recovery | `tools/post-execute` | The tool failed — retry, change approach, diagnose, or report? | `choice` | **on** |
| **7** · Quality review | `agent/turn-stopping` | (auto-calls `jev_review` when the turn ends and the diff is large enough) | MCP tool | **on** |
| **8** · Source-search escalation | `agent/pre-step` + `tools/post-execute` | (runs `jg` when the task is "where does X live?") | `jg` CLI | **on** |

Layer 3 does **not** call Jev. Default `low`; escalate to `high` only when the
previous turn shows a measured failure signal (≥2 tool errors or ≥1 test
failure). Sticky within a turn.

**Why the per-request classifier was removed (2026-10-01).** Measured over 120
consecutive requests: the old mechanism flipped effort `low↔high` on
**113/120** of them, 54.5% of its decisions had confidence < 0.5, and it burned
**55%** of all Jev tokens with a ~281 ms call sitting on the critical path. The
most expensive layer was changing a near-random decision. Research: measured
signals beat predicted difficulty (arXiv 2505.00127), and a per-step router only
wins when it is a small *trained* model (<5 ms, arXiv 2603.07915) — not a
1,180-token API classifier.

### Why the "Context choice" layer exists

This is the clearest cost target. Most input tokens are burned by the model
hunting for the relevant files itself through a chain of tool calls (`glob` →
`grep` → `read` → read again), when most of those tokens only answer the question
"which file is worth reading".

The plugin lists candidates by **file name** (one breadth-first `readdir`, ranked
by tokens matching the task), then asks Jev one `noul` question **per** candidate.
All questions ride in **one request**, so 13 batched questions cost 271ms — the
same as a single question. The host applies `contextFileThreshold` (0.6), sorts
by probability, and truncates to `contextMaxFiles` (3).

Why N `noul` questions instead of one multi-branch `choice`: the file list is
generated per repository, while `choice.criteria` must be fixed in code — criteria
cannot be built from a runtime list.

Measured on the real API (`jev-1.13.0`), after the 0.3.2 prompt fix:

| Case | File it should pick | p | Unrelated files |
|---|---|---|---|
| Login-session bug | `src/auth/session.ts` | **0.88–0.90** | `README.md` 0.06, `assets/logo.svg` 0.02 |
| Recolour the logo | `assets/logo.svg` | **0.94** | every other file 0.02–0.03 |
| Add a migration | `src/db/migrations/0012.sql` | **0.87** | `src/auth/session.ts` 0.10 |
| Write onboarding docs | `docs/onboarding.md` | **0.65** | `package.json` 0.07 |

Before 0.3.2 the two "creates a new artifact" cases scored only **0.39** and
**0.34** — below the 0.6 threshold. The prompt was missing the "a sibling of the
same kind defines the format for the new artifact" branch. See the 0.3.2
CHANGELOG entry for the before/after table and the three validation suites.

### Why the "Source-search escalation" layer exists (Layer 8)

Layer 5 lists candidate files by **name**. Measured on a real session
(`777a1746`, 2026-09-30), it hinted `weknora-dsh-setup-guide.md` across **four
consecutive turns** and the agent **never opened it** (0/4). The same session
ran **152** raw `grep`/`find`/`rg` commands and used the `jevgrep` skill
**zero** times, despite it being in the catalog. A filename is not enough for
the model to trust; it would rather grep.

Layer 8 fills exactly that gap with the `jg` CLI (the `jevgrep` skill): it asks
Jev "where does this behaviour live?" and returns **file list + line ranges +
verbatim source excerpts** in one run. That is content, not a name — it answers
the question the model actually has.

It escalates at two moments, both with the same single action:

- **A. `agent/pre-step` (step 1)** — when the user's task reads as "where does X
  live" (`chỗ nào xử lý`, `tìm file nào`, `where is X handled`, `which file
  implements`, `trace this bug`). Runs before the agent spends a single command.
- **B. `tools/post-execute`** — after `jevGrepSearchTaskThreshold` raw
  search commands **in a row** within the same turn. Catches the case where the
  task does not announce itself as a search but the agent is in fact digging.

The threshold of 3 is not a guess. Measuring the longest consecutive raw-search
run per turn on the real session: search turns (1, 3, 4, 5, 7, 8) all reached
**≥3**; short answer turns (2, 9, 10) only **1**. A non-search command resets the
run — the spiral is *consecutive* commands.

Why not replace Layer 5 outright: `jg` measures **~0.9s warm / ~2.6s cold**,
added to step 1 of *every* turn including turns that are not searches.
Conditional escalation keeps ordinary turns cheap.

Like every other layer: **absolute fail-open**. `jg` missing from PATH, exiting
non-zero, timing out, or returning nothing → stay silent and continue. It only
**injects a hint** with an escape clause, never edits files, never runs anything
else.

### Why the "Tool-failure recovery" layer exists

A failed tool usually makes the model retry the same call a few times before
changing approach — each attempt is a full generation. A 250ms question answers
instead. The four branches are four situations different in kind, so there is no
threshold to tune: `retry` (transient), `alternate` (wrong approach), `diagnose`
(cause unknown), and `stop-and-report` (cannot be resolved alone).

This layer **skips** commands blocked by layer 1 itself: that is not a tool
failure but a gate decision, and layer 1 already has its own message. It is
recognised by `error.info.code === 'JEV_DESTRUCTIVE'`. A `failureMaxPerTurn` cap
stops a repeatedly failing command from generating endless hints.

Measured (`jev-1.13.0`, 6 runs/case, stable 6/6 per case):

| Error | Branch Jev picks | Expected |
|---|---|---|
| `request timed out after 30000ms` | `retry` | retry ✓ |
| `cat: ... No such file or directory` | `alternate` 0.81 | alternate ✓ |
| test failure, cause unknown | `diagnose` 0.95 | diagnose ✓ |
| `AWS_ACCESS_KEY_ID not set` | `stop-and-report` 0.93 | stop-and-report ✓ |
| `ECONNREFUSED 127.0.0.1:5432` | `diagnose` | diagnose ✓ (retrying a dead DB is pointless) |

### Why the "Quality review" layer exists

Measured across 110 real sessions: the `mcp__jev-review__jev_review` tool is
**registered and present in the prompt** (the `mcp:jev-review` section is injected
by `dsh-mcp-client`), yet it was called **once** — and that was the plugin author
testing it. In real work: **zero times**.

So "the tool exists" does not mean "the tool gets used". Every Jev channel except
`dsh-jev-gate` is **passive**: MCP tools, skills, and CLIs all wait for the agent
to decide to call them. Only an engine hook runs by itself. This layer hooks
`jev_review` into `turn-stopping`.

Four abuse gates, because this hook blocks the turn:

| Gate | Condition | Why |
|---|---|---|
| 1 | Only when the turn truly ends | Reviewing half-finished code is meaningless |
| 2 | Main turn only (`delegationDepth === 0`) | Subagents do not own the workspace change; reviewing there multiplies calls by worker count |
| 3 | Diff ≥ `reviewMinChangedLines` (20 lines) | Reviewing an empty diff or a typo fix burns money for nothing |
| 4 | Cap `reviewMaxPerTurn` (1) | Without it, every turn-stopping pass is another call |

Scores are returned via `agent.steer` as a **report**, not an instruction: scores
are evidence, not an objective to optimise.

Latency: `jev_review` takes ~100ms on a healthy API, ~0.7–2.5s when the API is
slow. A missing tool, missing service, or a failed review all **fail open** — the
turn ends normally.

### Why the `jev-review` skill is no longer needed

Two things used to teach the agent to use `jev_review` in parallel: a **skill**
named `jev-review`, and the **MCP server's own instructions** (1,242 characters,
injected into the system prompt by `dsh-mcp-client` via `systemPrompt.section`).

Measured across 115 real sessions: the MCP instructions are present in **26
sessions**. They reach the model **independently of the skill**. Comparing the
content shows most of the skill duplicates them — the score→improve→rescore loop,
the baseline, `previousEvaluation`, not repeating identical calls, not gaming
scores.

And the skill **never led to a single review call in real work**. Of the four times
`jev_review` was ever called:

| Session | Skill called first? | Who called it |
|---|---|---|
| `f5a2e8a7` | yes | the author testing (`Add a clamp helper`) |
| `6865243e` | **no** | an MCP integration test (`Smoke-test the DSH MCP integration`) |

All four were tests, not real work. So the skill was **deleted** — one instruction
source remains, the MCP server, plus layer 7 calling it automatically at turn end.

The `jev_review` tool itself is unchanged: registered through `mcp-jev-review`, the
agent can still call it, and its instructions still reach the prompt.

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
│   └── deterministic: default low, escalate on measured failure signals
│       └── writes reasoningEffort  ──► provider and model UNCHANGED
│
├── LAYER 4+5 · approach + context    hook: agent/pre-step (step 1 only)
│   └── ONE Jev request, two question kinds:
│       ├── choice "which approach is optimal?" (layer 4)
│       │   ├── one-command-scan   ──► "run the single command, do not split it"
│       │   ├── scripted-analysis  ──► "write one short script and read its result"
│       │   ├── parallel-workers   ──► "delegate to subagents in parallel"
│       │   └── guided-interview   ──► "clarify with the user first"
│       │       (silent below conf 0.3; the model decides, the plugin does not act)
│       └── noul ×N "must this file be read?" (layer 5)
│           ├── the plugin lists candidates by FILE NAME (BFS readdir + ranking)
│           ├── p ≥ 0.6 → keep, sort descending, truncate to contextMaxFiles (3)
│           └── injects "read these first" — a hint, not a restriction
│
├── LAYER 6 · tool-failure recovery   hook: tools/post-execute
│   └── only when a tool actually failed (skips layer 1 denials):
│       ├── retry           ──► "transient; run the same call once more"
│       ├── alternate       ──► "wrong approach; change tool/flag/path"
│       ├── diagnose        ──► "cause unknown; investigate first"
│       └── stop-and-report ──► "cannot be resolved alone; report it"
│           (returned via additionalContexts → spliced into the next step)
│
├── LAYER 7 · quality review          hook: agent/turn-stopping
│   └── auto-calls `jev_review` (MCP) when the turn ends:
│       ├── four gates: turn really ended / main turn / diff ≥ 20 lines / cap 1
│       ├── assembles a unified diff from the workspaceChanges service
│       └── scores → agent.steer (a report, not an instruction)
│
├── LAYER 8 · source-search escalation  hook: agent/pre-step + tools/post-execute
│   └── runs `jg` (the jevgrep skill) ONCE when the task is "where does X live":
│       ├── A. step 1: task reads as a search (where is / which file / chỗ nào)
│       ├── B. after N consecutive grep/find/rg commands with no progress
│       ├── `jg` returns files + line ranges + verbatim excerpts → inject hint
│       └── no `jg` / error / timeout / empty → stay silent, fail-open
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
LAYER 4+5 · agent/pre-step  step 1 only, ONE Jev request:
      │                     which approach is optimal + which files to read first
      ▼
LAYER 8 · agent/pre-step     step 1 only, only when the task is "where does X live":
      │                     → runs `jg`, injects verbatim source excerpts (edits nothing)
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
LAYER 6 · tools/post-execute the tool just failed: retry / change / diagnose / report
      │                      → injects a hint for the next step
      ▼
LAYER 8 · tools/post-execute after N consecutive grep/find/rg commands with no progress:
      │                      → runs `jg` ONCE, injects verbatim source excerpts
      ▼
LAYER 2 · agent/turn-stopping when the model wants to stop: done? any evidence?
      │                      → unfinished or no proof means steer to keep working
      ▼
LAYER 7 · agent/turn-stopping turn truly ended with a large-enough diff
      │                      → auto-calls jev_review, steers scores back as a report
      ▼
turn ends
```

> LAYER 4+5 and LAYER 8 (branch A) run once per turn (step 1). LAYER 3 runs on
> most steps (it now reuses a confident decision for the next step). LAYER 7 runs
> once per turn, only when the turn produced a large-enough diff. The LLM,
> LAYER 1, LAYER 1b, LAYER 6 and LAYER 8 (branch B) **repeat** on every tool
> call. The diagram above draws one pass for readability.

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

### Layer 8 also needs the `jg` CLI (optional)

Layer 8 calls `jg` (the [jevgrep](https://github.com/dzhng/jevgrep) skill) to
fetch verbatim source excerpts. It is **optional**: without `jg` this layer
disables itself silently and the other seven layers run normally.

```bash
npm install --global @dzhng/jevgrep   # needs Node 22+
jg doctor                             # must print "Jev connection verified"
```

`jg` uses its own credential store and does **not** read `TYPESAFE_API_KEY` from
above. If `jg doctor` reports a missing credential, run `jg auth` once in your
own terminal (it opens a hidden prompt for the key; never paste the key into
chat).

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
    contextFileThreshold: 0.6   # p >= this means the file is worth reading
    contextCandidateLimit: 12   # max candidates handed to Jev
    contextMaxFiles: 3          # max files named in the hint
    failureMaxPerTurn: 2        # max recovery hints per turn
    gateTimeoutMs: 2000
    authorizationTimeoutMs: 4000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    spawnTimeoutMs: 6000
    contextTimeoutMs: 6000
    failureTimeoutMs: 4000
    effortDefault: low          # effort when the previous turn was clean
    effortEscalateTo: high      # raised when the previous turn shows failure signals
    effortEscalateToolErrors: 2   # ≥2 tool errors in the previous turn escalates
    effortEscalateTestFailures: 1 # ≥1 test failure in the previous turn escalates
    completionMaxPerTurn: 2     # max completion checks per turn
    reviewMinChangedLines: 20   # do not review diffs smaller than this
    reviewMaxPerTurn: 1         # max reviews per turn
    reviewMaxDiffChars: 24000   # max diff characters sent to the review
    reviewServerName: jev-review
    reviewReportToAgent: true   # report scores back to the agent via steer
    jevGrepSearchTaskThreshold: 3  # consecutive grep/find/rg commands before escalating; 0 disables branch B
    jevGrepMaxPerTurn: 1        # max jevgrep escalations per turn
    jevGrepTimeoutMs: 120000     # budget for one `jg` run (NEW query is cold for 66s–2m5s); on expiry, fail open
    jevGrepFailureBreaker: 3    # disable layer 8 for the session after N consecutive jg failures
    jevGrepBackground: true     # run jg in the BACKGROUND, never blocking the turn
    jevGrepExcerptCap: 4000     # max excerpt characters injected into context
    enableDestructiveGate: true
    enableAuthorizationOverride: true   # user-authorization layer — off restores the old block-everything behaviour
    enableCompletionCheck: true
    enableEffortRouting: true
    enableSpawnHint: true
    enableContextTriage: true           # context file-selection layer
    enableFailureRecovery: true         # tool-failure recovery layer
    enableQualityReview: true           # auto-call jev_review when the turn ends
    enableJevgrepEscalation: true       # source-search escalation via `jg` (requires the jevgrep skill)
```

Layer 8 needs the `jg` CLI on PATH (see
[Install](#layer-8-also-needs-the-jg-cli-optional)). Without it the layer
disables itself silently — no error, nothing blocked.

## Verify

```bash
bash verify.sh              # 7 items, needs DSH running + TYPESAFE_API_KEY
node tests/offline.mjs      # 159 checks, no secret needed
node tests/live-check.mjs   # 24 checks, needs TYPESAFE_API_KEY + network
```

- `verify.sh` — 7 items: location, structure, syntax, dependency resolution, profile
  registration, real boot log, real Jev calls against known-answer cases.
  Exit 1 if any item fails.
- `tests/offline.mjs` — no secret needed: fail-open, model invariance, shell-tool
  gating only, layer-4 guards, genuine-user-message filtering, export contract,
  and Layer 8 (parsing `jg` output, search-task / raw-search detection, per-turn
  cap, fail-open). The Layer 8 tests use a **fake** `jg` script on PATH — they
  never call the real `jg`, so they run in CI with no network and no `jg`.
- `tests/live-check.mjs` — real Jev API calls against known-answer cases.

- `tools/repair-session-source.mjs` — repairs old session logs corrupted by
  versions < 0.3.1, which wrote `source` as a bare string (see CHANGELOG 0.3.1).
  Run it while dsh is stopped:

  ```bash
  node tools/repair-session-source.mjs --check   # list logs that need repair
  node tools/repair-session-source.mjs           # repair every session in $DSH_HOME
  ```

  Each file keeps its original beside it as `.bak-sourcekind-<time>`, and the new
  bytes must pass strict validation before publication. Logs held open by another
  process are skipped.

CI (GitHub Actions) runs `offline.mjs` on Node 20 + 22 for every push/PR, and
`live-check.mjs` when the repo has a `TYPESAFE_API_KEY` secret. See
[`.github/workflows/verify.yml`](.github/workflows/verify.yml).

Changelog: [CHANGELOG.md](CHANGELOG.md).

## Measured results (2026-09-27 → 30, `jev-1.13.0`)

| Measurement | Result |
|---|---|
| Destructive gate on 20 real commands | 20/20 correct (recall 100%, precision 100%) |
| Does deny actually prevent execution? | yes — canary intact after a denied `rm -rf` |
| Layer 1b · user authorization — pasted content claiming authority | 0/66 returned `authorized` |
| Layer 1b · user authorization — destructive commands not asked for | 0/48 returned `authorized` |
| Layer 1b · user authorization — legitimate user-requested cleanup | 46/48 returned `authorized` |
| Layer 1b · user authorization fails closed on error | yes — a session read error still blocks |
| Completion check: evidence vs bare claim | 3/3 branches correct |
| Fail-open layer 1 (missing key / broken store / no llm) | 3/3 pass |
| Effort gear-shifting by difficulty | `low→low→high→low→high` across 5 steps |
| Approach choice | 9/10 correct (disk scan → one command; 5 topics → parallel; vague → clarify) |
| Context choice — threshold margin | files worth reading **0.65–0.98**, unrelated files **0.02–0.18** |
| Context choice — strict 6-case expectation | 5/6 (for "flaky test" Jev picked only the test file — reasonable) |
| Tool-failure recovery, 6 runs/case | 4/4 cases stable 6/6 each |
| Layers 5+6 end-to-end (real handler + real Jev) | 12/12 correct, layer 1 not regressed (p=0.95) |
| Layer 5 latency (13 questions batched in 1 request) | median 271ms — same as one question |
| Layer 6 latency (1 question) | median 267ms |
| Layer 3 — Jev cost by layer | **65%** (3,238,650 / 4,958,494 tokens) |
| Layer 3 — the old lease in practice | `lease=1` in **1,777/1,830 runs (97%)** — the mechanism was effectively dead |
| Layer 3 — confidence vs stability | conf 0.6 → next step keeps the effort 88%; conf 0.9 → 95% |
| Layer 3 — what reuse skips | **32%** of Jev calls, wrong 8% (missed an increase 4.3%) |
| Dropping the `lease` question | saves **148 input + 43 output** tokens per call |
| Layer 7 — how often `jev_review` ran across 110 real sessions | **once** (author testing, real handler + real MCP, scores steered to the agent), 0 times in real work |
| Layer 7 — `jev_review` latency | ~100ms |
| **Layer 7 on 16,905 real log lines (0.4.0)** | fired **66 times**, `reviewed` **0 times** — `seq` bug, fixed in 0.4.1 |
| **Layer 7 after 0.4.1 (real provider repro)** | before `diff.length=0` → after `diff.length=52` |
| **Layer 7 first real run (0.4.1)** | `decision:"reviewed"` — 154 lines / 3 files |
| **Layer 2 on real logs (0.4.0)** | turn=9 fired **16 times**, never `accept` — cap added in 0.4.1 |
| **Layer 1b — delete request at message 10/25 (0.4.2)** | `unrelated` → **`authorized`** (previously blocked in error) |
| **Layer 1b — delete request at message 18/25 (0.4.2)** | `unrelated` → **`authorized`** |
| **Layer 1b — is widening the window to 10 enough? (0.4.2)** | **no** — still blocks at message 10/25; must match by content |
| **`DELETE_HINT` with Vietnamese diacritics (0.4.2)** | `\b` missed `xoá`/`dẹp` → Unicode lookaround matches all |
| **Layer 5 file hint — did the agent read it? (session `777a1746`)** | **0/4** — hinted across 4 consecutive turns, agent never opened the file |
| **Layer 8 — why it is needed (session `777a1746`)** | 152 raw `grep`/`find`/`rg` commands, **0** uses of the `jevgrep` skill despite it being in the catalog |
| **Layer 8 — what the threshold of 3 is based on** | longest consecutive raw-search run: search turns 1/3/4/5/7/8 all **≥3**; short turns 2/9/10 only **1** |
| **Layer 8 — real `jg` latency** | **~0.9s warm** (cached), **~2.6s cold**; E2E through the real handler 2.4s |
| **Layer 8 — E2E with the real `jg`** | injected the correct verbatim excerpts for 2 files (`handler.js`, `auth.js`) |
| **Layer 8 — offline tests** | 60 new checks, using a fake `jg` on PATH (never calls the real one, runs in CI) |
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
- **Does not read files for the model.** Layer 5 only *names* files worth reading;
  the model still calls the read tool. It also reads no file contents to score —
  only file names inside the workspace.
- **Layer 8 does read contents, but only when triggered.** When the task is
  "where does X live" (or the agent has dug through several consecutive `grep`
  commands), Layer 8 runs `jg` to fetch verbatim excerpts. It **does not** edit
  files, **does not** run anything else, and **does not** replace reading the
  real files — the hint always carries "verify against the real files before
  changing anything". It needs the `jg` CLI; without it the layer disables
  itself silently.
- **Does not fix what the review finds.** Layer 7 only reports scores back to the
  agent; the agent decides whether another justified improvement is warranted.
- **Does not replace the agent's judgement.** A recommendation is not an authorisation.

## Uninstall

```bash
dsh plugin --profile web remove dsh-jev-gate
rm -rf ~/.local/share/dsh-jev-gate
```

## License

MIT
