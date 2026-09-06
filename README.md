# Token-Maxxing-Harness

Agentic coding harness that min-maxes token spend with a custom model router. See
[docs/architecture.md](docs/architecture.md) for how the routing/caching/cost pipeline is designed.

## Setup

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
```

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
  this project; a new project starts with none enabled. Turning one on prompts for its API key if
  it needs one, or offers to `ollama pull` it if it's a local model you haven't downloaded yet.
  Selection is saved to `model-selection.json`. Routing requests to only the enabled models is
  separate, in-progress work -- this just manages which ones are available.
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
