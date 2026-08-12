import { exec } from "node:child_process";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "../executor/types.js";

export interface CommandInfo {
  command: string;
}

export interface RunCommandToolOptions {
  /** Wall-clock cap per invocation; a runaway/hanging process is killed rather than hanging the whole subtask. Default 120s. */
  timeoutMs?: number;
  /** Cap on combined stdout+stderr kept; excess is truncated, not rejected -- unlike write_file, there's no "intended content" to corrupt by truncating output. Default ~50KB. */
  maxOutputBytes?: number;
  /** Command-string patterns that are always rejected outright. A heuristic safety net against
   * obviously destructive invocations, not a security boundary -- a general shell is
   * fundamentally unconstrainable without real sandboxing (containment for this tool comes from
   * the caller only ever pointing it at a disposable workspace, not from anything in here).
   * Replaces the default list entirely rather than adding to it, matching write_file's denylist. */
  denylist?: RegExp[];
  /** Called with the command before it runs. Returning false (or a rejected promise) aborts it.
   * Omit to run autonomously, same as write_file's onBeforeWrite. */
  onBeforeExecute?: (info: CommandInfo) => boolean | Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_DENYLIST: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+(-\w*[rf]\w*[rf]?\w*|--recursive\b.*--force\b|--force\b.*--recursive\b)\s+(\/|~)(\s|$)/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=\/dev\//,
  /:\(\)\s*\{[^}]*:\s*\|\s*:.*\};\s*:/, // classic fork-bomb shape
];

const argsSchema = z.object({
  command: z.string(),
});

/**
 * A general-purpose shell command tool, scoped to `workspaceRoot` as the working directory --
 * the missing piece that let a model declare a task "done" without ever running the code it
 * wrote or the tests meant to check it. Deliberately shaped like a real Bash tool (arbitrary
 * command, not a narrow test-runner allowlist): a fair comparison against an agent that already
 * has one needs the same tool surface, and real verification (a specific failing test, a quick
 * import sanity check, a linter) doesn't fit a fixed allowlist anyway.
 *
 * This is a materially different risk category from read_file/list_directory/write_file: those
 * are contained by realpath-based path checks that make escaping the workspace structurally
 * impossible. A shell command can't be contained that way -- the cwd is pinned to workspaceRoot
 * and a short denylist catches unambiguously destructive patterns, but neither is a real security
 * boundary the way path containment is. Actual isolation (nothing sensitive reachable from the
 * process, a disposable checkout, resource limits) has to come from how the caller runs this, not
 * from anything in here.
 */
export function createRunCommandTool(workspaceRoot: string, options: RunCommandToolOptions = {}): Tool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const denylist = options.denylist ?? DEFAULT_DENYLIST;

  return {
    name: "run_command",
    description:
      "Run a shell command in the project root -- run a test, check that a module imports " +
      "cleanly, run a linter, reproduce the bug you're fixing. Use this to verify your own " +
      "work actually functions before declaring a task done; a fix that was never run is not " +
      `a finished task. Commands time out after ${Math.round(timeoutMs / 1000)}s; combined ` +
      `stdout/stderr is truncated past ${maxOutputBytes} bytes.`,
    parameters: argsSchema,
    async execute(args): Promise<unknown> {
      const { command } = argsSchema.parse(args);

      if (denylist.some((pattern) => pattern.test(command))) {
        throw new Error(`Command is not allowed: "${command}"`);
      }

      const commandInfo: CommandInfo = { command };
      if (options.onBeforeExecute && !(await options.onBeforeExecute(commandInfo))) {
        throw new Error(`Command "${command}" was blocked`);
      }

      const cwd = await realpath(workspaceRoot);

      return new Promise((resolveExec) => {
        exec(
          command,
          {
            cwd,
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            // A generous backstop against truly runaway output, not the real truncation point --
            // Node's own maxBuffer enforcement cuts the string off exactly at the limit with no
            // marker, so setting this to maxOutputBytes directly would make our own truncate()
            // below never actually trigger (the string it sees would already be <= the limit).
            // truncate() is the real source of truth for maxOutputBytes.
            maxBuffer: Math.max(maxOutputBytes * 4, 1_000_000),
          },
          (error, stdout, stderr) => {
            const combined = truncate(`${stdout}${stderr}`, maxOutputBytes);
            const timedOut = Boolean(error && "killed" in error && error.killed && error.signal === "SIGKILL");
            const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0;

            resolveExec({
              command,
              exitCode,
              timedOut,
              output: timedOut ? `${combined}\n[command timed out after ${timeoutMs}ms]` : combined,
            });
          }
        );
      });
    },
  };
}

function truncate(text: string, maxBytes: number): string {
  return Buffer.byteLength(text, "utf-8") > maxBytes
    ? `${Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8")}\n[output truncated]`
    : text;
}
