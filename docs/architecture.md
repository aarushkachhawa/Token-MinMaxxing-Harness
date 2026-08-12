# Architecture

Token-Maxxing-Harness is an agentic coding harness with a custom model router: it decomposes a coding
task into subtasks and dispatches each one to whichever worker model is likely to complete it
correctly at the lowest cost, learning that assignment over time instead of hardcoding it.

![Hybrid router architecture](architecture.svg)

## Pipeline

1. **Orchestrator** — decomposes the incoming request into a subtask DAG. Runs on a fixed, capable
   model (not itself routed) since a bad plan is a worse failure mode than a slow worker. Emits a
   lightweight risk/tier hint per subtask alongside the decomposition, piggybacked on the read it was
   already doing — this is the harness's only per-subtask LLM judgment, and it's free in the sense
   that the orchestrator was going to look at the task anyway.

   Decomposition itself is three phases: **triage** (cheap, no tools — decides whether the request
   even needs repo context, so "what is 1+1" never pays for exploration), **explore** (only if triage
   says so — reuses the same tool-use loop and read-only tools as any subtask, so the plan is grounded
   in real files instead of guessing at structure), then **structure** (turns the request, plus any
   exploration summary, into a validated subtask DAG). All DAG validation — cycles, unknown/self
   dependencies, duplicate ids — happens after the client returns a plan, not inside it; an invalid
   plan currently just fails rather than being repaired and retried.

   Once every subtask the orchestrator currently knows about has completed, the driving loop calls
   **replan** before declaring the run done: the orchestrator hands the client the original request,
   the subtasks already planned, and what actually got produced (each completed subtask's id,
   description, and a truncated summary of its final output), and asks whether the request still
   needs more work. "No further work needed" is a first-class, valid answer — an empty result there
   isn't a failure the way an empty result from the initial decomposition is — and is in fact the
   common case; new subtasks only come back when a completed output actually surfaced a gap the
   original plan missed. Any new subtasks are validated against the full existing+new graph (the same
   duplicate-id/unknown-or-self-dependency/cycle checks as the initial plan, just run against the
   merged subtask list) and merged into the tracked plan, which can unlock a further round of ready
   subtasks and another replan once those finish too.

   In a multi-turn session (`src/cli.ts`), decomposition also sees the session's prior turns
   (request + answer, most recent last), so triage/explore/structure can resolve a follow-up's
   vague references ("that file", "now do the same for the other one") into something concrete.
   This is the only place conversation history is used — it's resolved into a self-contained
   subtask description during structure, so a worker executing a subtask never sees the history
   itself, matching the context compiler's "narrow, not everything" philosophy below.

   Two things keep that history from growing into a cost problem of its own. First, triage also
   emits `worthRemembering`: whether this exchange is plausibly part of an ongoing thread versus a
   one-off aside (a quick unrelated lookup, trivial arithmetic) unlikely to be referenced again — the
   request still runs and gets answered regardless, this only controls whether the CLI appends it to
   the session's history afterward, so an unrelated tangent can't later confuse an "it"/"that" it
   has nothing to do with. Second, `formatConversationHistory()` uses two tiers rather than a single
   hard cutoff: the last 5 turns appear in full (request + truncated answer), the next 10 turns
   older than that get condensed, and anything older than both is genuinely dropped. A turn aging
   out of full detail still leaves a trace instead of vanishing outright.

   The condensed tier's mention is a real LLM summary, not just the bare request text: the first
   time a turn crosses from the recent into the condensed window, `src/cli.ts` runs it through
   `AnthropicConversationSummarizerClient` (`src/memory/`) — a cheap model (haiku by default, since
   compressing a turn that's about to leave full detail is exactly the low-stakes, high-volume task
   this harness's whole premise says shouldn't burn a strong one) — and caches the one-sentence
   result on the turn itself (`ConversationTurn.summary`), never recomputing it. This runs *after*
   the turn's own answer is already on screen, so it never delays what the user is waiting for, and
   it fails soft: if the summarization call errors, that turn just keeps using the plain request-text
   fallback for this render and gets retried the next time something ages out.
2. **Task classifier** — labels each subtask against a configurable category taxonomy (e.g.
   `trivial-lookup`, `small-edit`, `multi-file-refactor`, `test-authoring`, `exploration`). Cheap
   heuristics first, LLM fallback only when ambiguous, so classification itself doesn't burn budget.
3. **Context compiler** — slices the minimal context each worker actually needs (relevant files, the
   specific prior subtask outputs it depends on) instead of forwarding full conversation/repo state.
   Context volume is often a bigger cost lever than model choice.
4. **Router** — see below.
5. **Executor** — runs the tool-use loop against the chosen model. Tool permissions are tiered
   alongside model tiers (e.g. a still-unproven cheap model doesn't get unrestricted write/bash
   access on a risky category).
6. **Reward collector** — scores the outcome (see Reward signal below) and updates the stats store;
   failures/low-confidence results escalate to the next tier rather than just failing.

The orchestrator re-enters (via replan, above) after each batch of subtask results rather than
planning once and executing blindly — coding tasks routinely reveal new work mid-flight.

## Router

The router is a **hybrid**: a statistical bandit handles the default case, with LLM judgment
reserved for exactly the situations the bandit is bad at.

### Bandit core

Each `(task category, candidate model)` pair is an **arm**. Per-category granularity is the
starting point — coarse enough that each arm sees enough traffic to converge, fine enough that a
cheap model's 90% success rate on `trivial-lookup` doesn't get averaged against its 20% success
rate on `multi-file-refactor`. Finer granularity (e.g. splitting further by repo language) trades
decision resolution for convergence speed, and should only be added once there's evidence
category-alone routes wrong along that dimension.

Selection uses **Thompson sampling**: each arm maintains a `Beta(α, β)` posterior over its true
success rate (`α`/`β` incremented on success/failure, seeded from an optimistic prior per the
registry's declared capability tier). At decision time, draw one random sample from each candidate
arm's posterior and route to the highest draw. Arms with little data have wide posteriors, so they
occasionally win by chance even with a middling mean — that's exploration happening in proportion
to actual uncertainty, with no hand-tuned exploration rate, and it decays naturally as an arm
accumulates evidence.

Cost is folded in as `θ − λ·normalized_cost` at decision time (θ = the sampled quality belief, λ =
a weight the budget governor turns up as burn-rate rises). `normalized_cost` is each arm's cost
rescaled to `[0, 1]` relative to the cheapest and priciest candidate *within that category* —
without this, λ has no portable meaning: the same λ that meaningfully trades off a $0.001 vs $0.05
difference on a small edit would be almost inert on a category with 10x the token volume, since raw
dollar costs scale with category size. Normalizing keeps "does it work" (learned) cleanly separate
from "how much do we care about cost right now" (a dial that means the same thing everywhere),
rather than tangling both into one posterior.

Reward passed to an arm is a float in `[0, 1]`, not a bare success/fail boolean — this is what lets
the reward signal below (a blend of deterministic checks, proxies, and judge sampling) feed the
bandit directly instead of being collapsed to a boolean first and losing the graded signal.

Registering an arm is idempotent: re-registering an already-known `(category, model)` pair (e.g. on
every config reload) refreshes its cost but leaves learned `alpha`/`beta` untouched. Deliberately
discarding history (e.g. after a known model version swap) goes through a separate `resetArm()`
call, so a routine config reload can never silently erase weeks of learned routing behavior.

Learned state persists across runs (`src/persistence/`) — `getAllArms()`/`restoreArm()` snapshot and
restore full arm state (not just the summary stats `getCandidates()` exposes) to/from SQLite via
Node's built-in `node:sqlite` (no dependency needed, though it's a Node-experimental API as of this
writing). The router itself stays storage-agnostic; persistence is a separate layer built on top,
not baked into `Router`/`Arm`.

### LLM escalation

Invoked only when the bandit's sampled arms are still highly uncertain (new/low-traffic category)
or the orchestrator flagged the subtask as high-risk. Reads the actual task description rather than
a bucketed label, and can be handed the current stats table as context. Kept rare deliberately: an
LLM call in the routing hot path costs tokens and adds latency on every use, which fights the
harness's core goal if it becomes the default path instead of the exception.

### Budget governor

Tracks spend *and* burn-rate (tokens/min, not just a cumulative cap). Rising burn-rate increases λ
above, biasing routing toward cheaper arms without overriding the classifier or bypassing the
bandit's learned quality beliefs.

## Reward signal

The bandit's guarantees only hold if "success" is a trustworthy signal, so reward blends three
tiers by trust:

1. **Deterministic** (highest weight) — tests pass, lint clean, diff applies, no exception thrown.
2. **Cheap proxy** (medium weight) — retry count, tool-call sanity, output schema validity.
3. **Judge sampling** (low frequency, high cost) — periodically send output to a stronger model or
   the user for pass/fail, used to calibrate that (1) and (2) actually track real quality rather than
   optimizing for "passed lint" while quality silently drifts. Deliberately scoped to "did the trace
   show the task getting done," never "is this code correct" — asking an LLM to eyeball code for bugs
   without executing it produces confident, plausible-sounding false positives (that's tier 1's job,
   and it's more reliable at it); see `src/reward/judge-rubric.ts` for the rubric and the incident that
   shaped it. Every judge verdict must cite literal evidence from the trace, and low-confidence
   verdicts are damped toward neutral rather than allowed to swing the reward on a guess.

Each arm discounts its own accumulated evidence back toward its prior on every update (default
decay 0.995, ~140-pull half-life), so a regression or improvement is reflected within a bounded
number of pulls instead of requiring an ever-growing number of contradicting observations to move
the posterior. This decay is per-pull, not wall-clock — an arm that stops being used at all simply
keeps its last belief, which is the correct behavior (nothing contradicted it) but means a model
that quietly gets replaced upstream without ever failing won't be caught by decay alone; that's what
`resetArm()` and judge sampling are for. A manual `resetArm()` is available for when a model version
is known to have changed.

## Multi-provider model registry

Workers are config-driven entries — `{provider, model_id, cost per token, capability tier, context
limit}` — behind a unified call interface, so adding a new model (local, another API provider, or
Anthropic) is a registry entry, not new routing code. `src/registry/` (`ModelRegistry`,
`seedRouterFromRegistry`) provides this metadata layer, but `cli.ts`/`demo-real.ts`/`stress-test.ts`
don't source their bandit arms from it yet -- they register two hardcoded Anthropic model ids
directly. What those three *do* now have is `ModelClientFactory`
(`src/executor/anthropic-model-client-factory.ts`): `SubtaskRunner.attempt()` resolves the router's
`decision.modelId` to a real client through it on every attempt, so the routing decision actually
determines what executes. Before this, `SubtaskRunner` ran every subtask against one client fixed
at construction time regardless of what the bandit or escalation path chose -- `decision.modelId`
only ever reached `reportOutcome()`'s bookkeeping, so every run was really testing "can this one
model solve it," not whether routing helped. Verified live: a trivial request correctly stayed on
the cheap tier (the escalation client itself judged the stronger model unnecessary), and a
genuinely harder one escalated to and executed against the stronger model for real, producing
visibly more sophisticated output than the cheap tier would. `ModelClientFactory` is still
Anthropic-only, so the multi-provider half of this section (a real second `provider` in the
registry, a factory that dispatches across providers, arms actually seeded from `ModelRegistry`)
remains open.

## Open design questions

- **Provider abstraction**: the single-provider version of this is done -- `ModelClientFactory`
  (see Multi-provider model registry above) turns a router decision into the real Anthropic client
  that executes it. What's still open is multi-*provider*: build that call layer directly, or sit
  on top of an existing library (e.g. litellm) and only own the registry/router/bandit logic on top.
- **Hierarchical priors**: a low-traffic category currently starts from a flat optimistic prior;
  sharing a prior derived from global cross-category stats would reduce cold-start pain without
  exploding arm granularity.
- **Contextual features**: if per-category routing proves too coarse along a specific dimension
  (language, file size), promote it to an explicit bandit context feature rather than adding it
  speculatively.
- **Escalation cost isn't modeled yet**: the router's cost term only counts the arm it picked, but a
  cheap arm's true expected cost includes `P(fail) x cost of the escalated retry`. A flaky-but-cheap
  model is currently undercosted, and gets tried first even on categories where a failed attempt is
  expensive (side effects, wasted tokens). Needs revisiting once the executor and escalation loop
  exist and failure probabilities are actually observable.
- **`read_file` offset/limit**: implemented. Optional 1-indexed `offset` and `limit` args select a
  specific line range instead of defaulting to the head of the file; `maxBytes` truncation still
  applies as a safety net on top of whatever range is selected, and an `offset` past the end of
  the file returns empty content rather than an error (a legitimate no-op, not a security
  concern). Omitting both args reproduces the original whole-file-up-to-maxBytes behavior exactly.
- **`write_file` auto-created parent directories**: implemented as an opt-in `createParents`
  constructor option (default `false`, matching the original "reject rather than guess"
  behavior). When enabled and the immediate parent is missing, the tool walks up to the deepest
  ancestor that currently exists, `realpath`s *that* to confirm it's genuinely within the
  workspace root, and only then creates the missing segments with `fs.mkdir(dir, { recursive:
  true })` — so a symlink further up the (partially nonexistent) path still can't be used to
  escape the workspace just because the specific target's parent didn't technically exist yet.
- **`write_file` against the real repo is now gated, not just sandboxed**: `demo-real.ts` and
  `stress-test.ts` both wire it up scoped to `process.cwd()` (the actual project, not a scratch
  dir) with `onBeforeWrite` set to `interactiveWriteApprovalGate`
  (`src/tools/write-approval-gate.ts`) — every pending write prints the path, whether it's a new
  file or an overwrite, and the full before/after content to the terminal, then blocks on stdin
  for an explicit y/yes, defaulting to refuse on anything else. This is a human-in-the-loop gate
  sized for interactive demo/stress runs; an unattended real-repo run would need a different one
  (allowlist rules, diff-size limits) since there's no human to answer the prompt.
- **`delete_file` and any shell/command tool are not built**: `write_file`'s denylist/containment/
  approval-hook pattern is the template if/when a delete tool is added, but deletion and arbitrary
  command execution are their own risk categories, not just "write_file but more so."
