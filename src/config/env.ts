export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill in a real key, " +
        "then run with `node --env-file=.env ...` (or `npm run <script> -- --env-file=.env`)."
    );
  }
  return key;
}
