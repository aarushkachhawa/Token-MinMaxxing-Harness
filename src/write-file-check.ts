/**
 * Validates the real write_file tool against a real model, scoped to a disposable scratch
 * directory -- not this repository -- so there's zero risk to anything real. Also exercises the
 * onBeforeWrite hook (just logging here, not blocking) and prints the actual file contents on
 * disk afterward as proof the write really happened, not just what the model claims it did.
 *
 * Spends real tokens on the key in .env every time it runs.
 * Usage: npm run write-check
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAnthropicApiKey } from "./config/env.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { Executor } from "./executor/executor.js";
import { createListDirectoryTool, createReadFileTool, createWriteFileTool } from "./tools/index.js";

async function main() {
  const scratchDir = await mkdtemp(join(tmpdir(), "write-file-check-"));
  console.log(`Scratch directory: ${scratchDir}`);

  await writeFile(join(scratchDir, "notes.txt"), "TODO: write something here\n");

  const modelClient = new AnthropicModelClient({ apiKey: getAnthropicApiKey() });
  const tools = [
    createReadFileTool(scratchDir),
    createListDirectoryTool(scratchDir),
    createWriteFileTool(scratchDir, {
      onBeforeWrite: (info) => {
        console.log(`\n--- write_file: ${info.path} ---`);
        console.log(
          `before: ${info.previousContents === null ? "(new file)" : JSON.stringify(info.previousContents)}`
        );
        console.log(`after:  ${JSON.stringify(info.newContents)}`);
        return true; // scratch dir, nothing to gate -- just observing what it does
      },
    }),
  ];
  const executor = new Executor(modelClient, tools);

  const result = await executor.run(
    "You are a careful coding assistant working in a scratch directory. Use list_directory and " +
      "read_file to see what's there, then use write_file to make the requested change.",
    "Read notes.txt, then replace its contents with a short three-line poem about software testing."
  );

  console.log(`\nExecutor finished ("${result.stopReason}"): "${result.finalText}"`);
  console.log(`\nActual file contents on disk:\n${await readFile(join(scratchDir, "notes.txt"), "utf-8")}`);

  await rm(scratchDir, { recursive: true, force: true });
  console.log("(scratch directory cleaned up)\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
