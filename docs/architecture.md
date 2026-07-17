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

The orchestrator re-enters after each batch of subtask results rather than planning once and
executing blindly — coding tasks routinely reveal new work mid-flight.

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
   optimizing for "passed lint" while quality silently drifts.

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
Anthropic) is a registry entry, not new routing code.

## Open design questions

- **Provider abstraction**: build the multi-provider call layer directly, or sit on top of an
  existing library (e.g. litellm) and only own the registry/router/bandit logic on top.
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
