# Token-Maxxing-Harness

[![CI](https://github.com/aarushkachhawa/Token-MinMaxxing-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/aarushkachhawa/Token-MinMaxxing-Harness/actions/workflows/ci.yml)

Agentic coding harness that min-maxes token spend with a custom model router. See
[docs/architecture.md](docs/architecture.md) for how the routing/caching/cost pipeline is designed.

## Setup

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
```

For the interactive CLI, `/models` (see below) is what actually decides which models the router is
allowed to use -- it's an allowlist, not a suggestion: a model you haven't enabled there is never
selectable, no matter how it performs. Optionally, route some subtasks to a local model instead of
Anthropic: install [Ollama](https://ollama.com), then enable one from `/models` (it offers to
`ollama pull` it for you if needed). `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) only
needs setting if Ollama runs somewhere other than localhost.

The non-interactive scripts (`demo:real-pipeline`, `stress`) don't have a `/models` command --
they always register both Anthropic tiers, and additionally route to a local model if you set
`OLLAMA_MODEL=<model you've pulled>` in `.env`.

## Usage

### Interactive CLI (recommended)

```bash
npm run cli
```

Opens a REPL (`> `) backed by the real pipeline (real router, real models, real tools) that keeps
router state, bandit learning, and conversation history alive across every request you type until
you exit -- a follow-up like "now do the same for the other file" resolves correctly against what
you asked before.

- Type a request and press enter.
- `/models` -- toggle which models (Anthropic, OpenAI, Google, or local Ollama) are allowed for
  this project; **a new project starts with none enabled, and the router genuinely cannot route
  anywhere until you enable at least one** -- you'll get a clear error on your first request
  otherwise. Turning a model on prompts for its API key if it needs one, or offers to `ollama pull`
  it if it's a local model you haven't downloaded yet. Selection is saved to
  `model-selection.json`, which the CLI re-reads on every single request -- toggling a model on or
  off takes effect on the very next request, no restart needed, and disabling one genuinely removes
  it as an option rather than just deprioritizing it. (Only Anthropic and Ollama entries have
  execution wiring right now; enabling an OpenAI/Google model currently has no effect, since no
  client exists for those providers yet.)
- `/reset` -- clears the session's conversation history without losing learned router state.
- `/exit` or `/quit` -- ends the session (also persists router state to disk).

Every write, edit, or shell command the harness wants to run against your repo requires explicit
`y`/`N` approval in the terminal before it takes effect.

### Other entry points

- `npm run demo:real-pipeline -- "<request>"` -- runs one request through the same real pipeline
  non-interactively (single-shot instead of a REPL), and additionally prints each subtask's token
  usage (including cache read/write breakdown).
- `npm run stress -- "<task>"` -- throws an ad-hoc task directly at the real pipeline's executor,
  skipping the orchestrator's decomposition -- useful for testing the tool sandbox directly.
- `npm run demo -- "<request>"` -- same pipeline shape, but every LLM-backed decision is a scripted
  fake instead of a real model call. No API key needed; good for a quick structural sanity check.

### Development

```bash
npm test         # run the automated test suite
npm run typecheck
npm run build
```

See [docs/benchmarking.md](docs/benchmarking.md) for running the SWE-bench Lite pilot harness.
