# Benchmarking against Claude Code / Codex CLI

This harness's entire pitch is "same task, less spend." That claim is currently unverified — there's
no head-to-head measurement against the general-purpose coding agents it's implicitly competing
with. This doc lays out how to build one.

## Why this is answerable

Both comparison targets already support scripted, non-interactive, single-shot invocation with
structured usage output, which is the actual prerequisite for a fair bench:

- **Claude Code**: `claude -p "<prompt>" --output-format json` runs the agentic loop to completion
  and exits, returning `total_cost_usd`, token counts, and the final result as JSON.
- **Codex CLI**: `codex exec --json "<prompt>"` does the equivalent — one-shot, non-interactive,
  streams progress to stderr, final message and usage to stdout as JSON.
- **This harness**: `src/cli.ts` / `src/demo-real.ts` already wire a single request through the
  full pipeline once; `src/executor/executor.ts` already accumulates `inputTokens`/`outputTokens`
  per subtask and feeds them to `src/budget/budget-governor.ts`. The piece that doesn't exist yet
  is summing that across a whole run and attaching a dollar cost per model from the registry's
  declared cost-per-token.

So the adapter layer for all three is thin: shell out, capture stdout, parse a JSON blob (or,
for this harness, read it directly out of process since it's a library, not just a CLI).

## Task suite: use an existing benchmark, don't invent one

Reinventing a task set would spend all the effort on data generation instead of measurement, and
the results wouldn't be comparable to any published numbers. Two existing suites cover this well
and both already have official pass/fail scoring:

- **SWE-bench Verified / Lite** — real GitHub issues + repos, each with a hidden test patch that
  determines pass/fail deterministically. This is what Anthropic and OpenAI already report Claude
  Code's and Codex's numbers against, so results are also externally checkable. Needs the official
  `swebench` eval harness (Docker-based) to grade — don't hand-roll the grading step.
- **Terminal-Bench** — broader agentic terminal tasks, useful as a supplement since SWE-bench is
  scoped to "fix this issue in this repo" and won't exercise this harness's decomposition/routing
  behavior much on tasks that are naturally single-subtask.

Start with **SWE-bench Lite**, since Verified is larger and Lite still has held-out tests as the
ground truth. Pick a small fixed pilot slice (~15–20 instances) rather than the full set — running
three agents over the full instance count multiplies cost three-fold for a measurement, not a
result you ship.

### Using SWE-bench Lite concretely

1. **Install the official harness** (separate from this repo — it's a Python package that does
   checkout + grading, this repo only produces the patches it grades):

   ```bash
   git clone https://github.com/SWE-bench/SWE-bench.git
   cd SWE-bench && pip install -e .
   ```

   Needs Docker running. Verified on this machine (Darwin/arm64, `swebench` 5.0.0rc0): no
   arch-related flag is needed — `run_evaluation` builds the instance image locally and runs
   fine on arm64 by default (confirmed via the gold-patch check in step 5, ~3.5 min for one
   instance including the image build). Budget more time/disk for a larger slice — image builds
   are the slow part regardless of instance count (the docs cite ~120GB free space, 16GB RAM as
   the baseline assumption for a full, non-pilot run).

2. **Pick a fixed pilot slice of instance IDs once, reuse it for all three agents.** Reproducibility
   across agents requires the exact same instances every time:

   ```python
   from datasets import load_dataset
   ds = load_dataset("SWE-bench/SWE-bench_Lite", split="test")
   pilot_ids = [ds[i]["instance_id"] for i in range(20)]  # pin these, don't re-sample per run
   ```

   Each instance's row already carries everything a checkout needs: `repo`, `base_commit`,
   `problem_statement` (the issue text — this is the prompt you hand to all three agents),
   `test_patch` + `FAIL_TO_PASS`/`PASS_TO_PASS` (kept hidden from the agent, used only by the
   grader).

3. **The contract every adapter must produce is one predictions file per agent per run**, in the
   grader's required JSONL schema:

   ```json
   {"instance_id": "sympy__sympy-20590", "model_name_or_path": "tmh-pilot", "model_patch": "diff --git a/sympy/core/sympify.py ..."}
   ```

   `model_patch` is a literal unified diff of the agent's changes against `base_commit` — i.e. after
   each agent finishes working in its checkout, the adapter runs `git diff` in that checkout and
   drops the output straight into this field. This is the one artifact `tmh-adapter.ts`,
   `claude-code-adapter.ts`, and `codex-adapter.ts` all converge on, regardless of how differently
   each agent got there.

4. **Grade each agent's predictions file as a separate run** (separate `run_id` so results don't
   overwrite each other), scoped to the pinned pilot slice:

   ```bash
   python -m swebench.harness.run_evaluation \
     --dataset_name SWE-bench/SWE-bench_Lite \
     --predictions_path preds_tmh.jsonl \
     --instance_ids sympy__sympy-20590 ... \
     --max_workers 8 \
     --run_id tmh-pilot
   ```

   Repeat with `preds_claude_code.jsonl --run_id claude-code-pilot` and
   `preds_codex.jsonl --run_id codex-pilot`. Output lands as a per-instance resolved/unresolved log
   plus a summary JSON with the resolve rate — that JSON's per-instance `resolved` bool is exactly
   the `resolved` field `report.ts` needs; nothing about pass/fail is computed in this repo.

5. **Sanity-check the setup before spending real agent runs on it**: run the grader against the
   dataset's own gold patch first, which should resolve close to 100%:

   ```bash
   python -m swebench.harness.run_evaluation \
     --predictions_path gold --instance_ids sympy__sympy-20590 --run_id validate-gold
   ```

   If that fails, the problem is the Docker/grading setup, not any agent — fix it before running
   the pilot for real. Confirmed working on this machine: `astropy__astropy-12907` resolved 1/1
   on the gold patch (`swebench` 5.0.0rc0, Darwin/arm64, ~3.5 min including the one-time image
   build) — see the report at `gold.validate-gold.json`.

## Fairness constraints

These matter more than the metrics — a benchmark that isn't controlled just produces three
disagreeing numbers with no explanation:

1. **Same repo state.** Each instance checks out at its specified base commit for every agent, in
   an isolated clone — no shared mutable working tree across runs.
2. **Same success criterion.** Only the instance's hidden test patch decides pass/fail. Never let
   an agent self-report success — this harness's own judge-sampling reward tier is explicitly
   scoped to "not a correctness oracle" for exactly this reason (see
   [architecture.md](architecture.md#reward-signal)); the same caution applies to Claude Code's or
   Codex's own "I'm done" self-assessment.
3. **Same attempt budget.** Report pass@1 (single attempt, no retries across the *whole run*) as
   the headline number. This harness's internal tier-escalation-on-failure is allowed and expected
   to run — that's the mechanism being evaluated — but the outer harness shouldn't get a second
   independent attempt that Claude Code/Codex don't.
4. **No network/tool asymmetry.** All three get read/write access to the same repo and nothing
   else (no internet, no unrelated MCP tools) so a difference in tool surface isn't what's being
   measured.
5. **Wall-clock and cost both recorded, not just one.** A cheaper-but-slower result and a
   faster-but-pricier result are different products; report both rather than collapsing to one
   axis.

## Metrics

Per instance: `resolved` (bool, from the official grader), `wall_clock_seconds`, `input_tokens`,
`output_tokens`, `cost_usd`, and for this harness specifically: number of subtasks, number of
tier-escalations, and which models actually got used (the router's decisions are themselves
interesting output, not just plumbing).

Aggregated per agent: resolve rate, mean/median cost per instance, **cost per resolved instance**
(total spend ÷ count resolved — this is the metric that actually penalizes an agent for burning
budget on failures, unlike mean cost per instance), and mean wall-clock.

## Shape of the implementation

What's actually built, under `src/bench/` (verified end-to-end on `astropy__astropy-12907`, the
first pinned pilot instance — see the "First real data point" section below):

```
src/bench/
  types.ts                       # SweBenchInstance, InstanceRunLog
  swebench-loader.ts              # fetches the pinned pilot slice via HF's datasets-server API
                                   # (plain fetch, no Python dep) -- offset=0&length=N reproduces
                                   # the exact same dataset-order slice the pilot was pinned from
  git-checkout.ts                  # shared clone/checkout helper: one bare-repo cache per repo
                                   # (django alone repeats several times across the pilot), fresh
                                   # local checkout at base_commit per instance off that cache
  run-instance.ts                  # one-shot, non-interactive tmh runner for a single
                                   # workspace+request (auto-approve writes, fetch-wrapper totals
                                   # real token usage across all 5 Anthropic-backed clients)
  run-tmh-pilot.ts                 # loops run-instance.ts over every pinned instance -> preds_tmh.jsonl + log.jsonl
  prepare-claude-pilot.ts           # checkout + problem.txt per instance for the Claude Code side
                                   # (pure git/fs, no `claude` invocation -- safe to run as the agent)
  assemble-claude-predictions.ts    # after scripts/run-claude-pilot.sh has run: diff + result.json -> preds_claude.jsonl + log.jsonl
  report.ts                        # reads both agents' SWE-bench grader reports + log.jsonl -> comparison table

scripts/
  run-claude-pilot.sh               # loops `claude -p --permission-mode bypassPermissions` over
                                   # every prepared instance -- MUST run in the user's own
                                   # terminal; a nested invocation from within a Claude Code
                                   # session gets blocked by the permission classifier (correctly:
                                   # spinning up a second autonomous agent with every safety check
                                   # off is a real blast-radius action, not something to route around)
  grade.sh                         # one run_evaluation call per agent, scoped to the pinned
                                   # instance_ids -- not one grading call per instance
```

`run-tmh-pilot.ts` and `prepare-claude-pilot.ts` both checkout/run/diff inside a disposable clone
per instance, so one instance's write can't leak into another's baseline, and both go through the
same `git-checkout.ts` cache so repeated repos across the pilot don't each trigger a fresh network
clone.

tmh's per-instance cost isn't directly billed the way Claude Code's `result.json` is — the
fetch-wrapper in `run-instance.ts` totals tokens across all five Anthropic-backed clients
(orchestrator, classifier, executor, judge, escalation) without splitting by which model priced
each call, since none of those clients currently expose per-call usage through their return types.
`report.ts` falls back to a blended-rate estimate (Haiku 4.5 pricing, since the executor's tool-loop
tokens dominate call volume) for tmh's cost column, labeled `(estimated)`.

### First real data point

Ran end-to-end on `astropy__astropy-12907` (nested-CompoundModel separability bug in
`astropy/modeling/separable.py`) before building the loop infrastructure, to validate the
mechanics with one real, graded result rather than trusting an estimate:

| | tmh harness | Claude Code |
|---|---|---|
| Resolved (SWE-bench grader) | No (empty patch) | Yes (1/1) |
| Tokens | 235,586 (231,483 in / 4,103 out) | ~1.78M raw (mostly cached reads) |
| Cost | ~$0.25–$0.35 (estimated) | $1.0655 (billed) |
| Wall-clock | 62.4s | 233.0s |

tmh's orchestrator (Sonnet 5) correctly diagnosed the bug location during planning, but the single
subtask handed to the executor — which runs on Haiku 4.5 regardless of what the router "decided,"
per the open design question below — produced a standalone repro script and never touched the
actual fix, even after the failure-triggered escalation retry (which is subject to the same
limitation: it's still Haiku, since there's no real per-decision model dispatch yet). Claude Code
found and fixed the actual one-line bug (`cright[...] = 1` should be `cright[...] = right`) and
verified it against the existing test suite itself.

One instance is nowhere near enough to generalize from, but it's a concrete illustration of the
"provider abstraction" gap below being load-bearing, not theoretical.

## Open design questions

- **Grading environment**: the official SWE-bench harness runs grading in Docker per instance
  (matching each repo's actual test environment). This needs to exist regardless of which agent
  is being scored, so it's a one-time setup cost, not a per-agent one.
- **This harness's multi-provider registry vs. single-model competitors**: Claude Code and Codex
  CLI each run on one underlying model per invocation; this harness may route a single instance's
  subtasks across several models. That's the entire point of the comparison (cost from *routing*
  vs. cost from a fixed model), but it means "which Claude Code model" and "which Codex model" are
  real choices that change the comparison's meaning — likely worth running against more than one
  reference model tier on each competitor rather than picking just their default.
- **The router's decision doesn't reach execution yet** — confirmed, not hypothetical, by the
  first real pilot instance above: `SubtaskRunner.attempt()` always builds its `Executor` from the
  single `ModelClient` injected at construction time; `decision.modelId` from the router is used
  only to report the outcome back to the bandit for learning ([subtask-runner.ts:87-93](../src/runner/subtask-runner.ts)),
  never to pick which model actually executes. Every subtask call — and every escalation retry,
  which is supposed to hand a failed attempt to a stronger model — currently runs on whatever
  single model the caller happened to construct (Haiku 4.5 in `run-instance.ts`/`demo-real.ts`).
  This is the same gap architecture.md's "provider abstraction" open question already names, but
  worth calling out here specifically: until it's fixed, a pilot run measures "can the fixed
  executor model alone solve these issues," not "does this harness's routing help" — which is the
  actual question the benchmark exists to answer.
- **Instance selection bias**: SWE-bench Lite instances are graded on Python repos almost
  exclusively; this harness's category/router split is language-agnostic in principle but has
  only been exercised in this repo's own TypeScript context so far. A pilot result here says
  something about routing efficiency on Python issues specifically, not about the harness in
  general — worth flagging in whatever report comes out of this, not just in this doc.
- **Cold-start bandit state**: the router's bandit arms start with an optimistic flat prior and
  converge with traffic (see [architecture.md](architecture.md#bandit-core)). A ~15-20 instance
  pilot is likely too small for the bandit to have learned anything meaningful — the first
  head-to-head run is really measuring cold-start behavior, not converged routing. Worth running
  the pilot slice twice (fresh state vs. warmed-up state from a prior pass) to separate the two.
- **Not yet decided**: the loop infrastructure (`run-tmh-pilot.ts`, `prepare-claude-pilot.ts`,
  `scripts/run-claude-pilot.sh`, `scripts/grade.sh`, `report.ts`) is built and verified, but running
  it for real across all 20 pinned instances spends real API budget on both agents and is still
  gated on whether to fix the router-to-executor wiring above first — otherwise the 20-instance
  result is confounded by the same known gap the single validated instance already exposed.
