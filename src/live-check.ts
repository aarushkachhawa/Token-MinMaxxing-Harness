/**
 * Manual, one-off check that the real Anthropic wiring actually works. Not part of the
 * automated test suite: a live model call isn't deterministic and spends real tokens on
 * whatever key is in .env every time it runs.
 *
 * Usage: node --env-file=.env --experimental-strip-types src/live-check.ts
 *     or: npm run demo:real
 */
import { getAnthropicApiKey } from "./config/env.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { Executor } from "./executor/executor.js";

async function main() {
  const client = new AnthropicModelClient({ apiKey: getAnthropicApiKey() });
  // No tools yet -- this call is only proving the message/response translation works
  // against a real model, not exercising real tool-calling.
  const executor = new Executor(client, []);

  const result = await executor.run(
    "You are a terse assistant. Answer in one short sentence.",
    "What is 2 + 2?"
  );

  console.log(`\nfinalText: "${result.finalText}"`);
  console.log(`stopReason: ${result.stopReason}`);
  console.log(`usage: ${JSON.stringify(result.usage)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
