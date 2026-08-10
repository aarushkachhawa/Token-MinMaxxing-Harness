/**
 * Validates the real write_file tool against a real model, scoped to a disposable scratch
 * directory -- not this repository -- so there's zero risk to anything real. Also exercises the
 * onBeforeWrite hook (just logging here, not blocking) and prints the actual file contents on
 * disk afterward as proof the write really happened, not just what the model claims it did.
 *
 * Spends real tokens on the key in .env every time it runs.
 * Usage: npm run write-check -- "your task description"
 *   (a seed file notes.txt with placeholder content is always created first, but the task
 *   doesn't have to be about it -- e.g. try "create a new file called hello.txt with ...")
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAnthropicApiKey } from "./config/env.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { Executor } from "./executor/executor.js";
import { createListDirectoryTool, createReadFileTool, createWriteFileTool } from "./tools/index.js";

const DEFAULT_TASK = "Read notes.txt, then replace its contents with a short three-line poem about software testing.";

async function main() {
  const task = process.argv.slice(2).join(" ") || DEFAULT_TASK;

  const scratchDir = await mkdtemp(join(tmpdir(), "write-file-check-"));
  console.log(`Scratch directory: ${scratchDir}`);
  console.log(`Task: "${task}"\n`);

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
    task
  );

  console.log(`\nExecutor finished ("${result.stopReason}"): "${result.finalText}"`);

  console.log("\nActual files on disk after the run:");
  for (const name of await readdir(scratchDir)) {
    console.log(`--- ${name} ---`);
    console.log(await readFile(join(scratchDir, name), "utf-8"));
  }

  await rm(scratchDir, { recursive: true, force: true });
  console.log("(scratch directory cleaned up)\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
