import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { AnthropicModelClient } from "../executor/anthropic-model-client.js";
import { Executor } from "../executor/executor.js";
import { createListDirectoryTool, createReadFileTool } from "../tools/index.js";
import type { ConversationTurn, OrchestratorClient, OrchestratorRequest, ReplanContext, SubtaskPlan } from "./types.js";

export interface TriageResult {
  needsExploration: boolean;
  reasoning: string;
}

export interface AnthropicOrchestratorClientOptions {
  apiKey: string;
  modelId?: string;
  /** Root the explore phase's read_file/list_directory tools are sandboxed to. Default process.cwd(). */
  workspaceRoot?: string;
  /** Cap on the explore phase's tool-use turns; exploration should be lighter-weight than full task execution. */
  exploreMaxTurns?: number;
  onTriage?: (result: TriageResult) => void;
  onExploration?: (summary: string) => void;
}

const DEFAULT_MODEL_ID = "claude-sonnet-5";
// Deliberately generous: light exploration (list a couple directories, read 2-3 files) alone
// can use 6-8 turns, and a tighter budget silently discards the whole exploration as an empty
// summary once turns run out with no turn left free to write it.
const DEFAULT_EXPLORE_MAX_TURNS = 10;
/** Cap on how much of a completed subtask's finalText gets fed into the replan prompt. */
const MAX_COMPLETED_OUTPUT_SUMMARY_LENGTH = 500;
/** Cap on how many prior turns of conversation history get fed into triage/explore/structure. */
const MAX_HISTORY_TURNS = 5;
/** Cap on how much of each prior turn's answer gets included -- a full history transcript would grow unboundedly. */
const MAX_HISTORY_ANSWER_LENGTH = 500;

const triageSchema = z.object({
  needsExploration: z.boolean(),
  reasoning: z.string(),
});

const subtaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  dependsOn: z.array(z.string()),
  highRisk: z.boolean(),
});
// decompose() must always produce at least one subtask; replan() must NOT enforce that -- an
// empty result there is the valid "no further work needed" answer -- so the two get distinct
// plan-level schemas even though both reuse the same subtaskSchema.
const planSchema = z.object({ subtasks: z.array(subtaskSchema).min(1) });
const replanSchema = z.object({ subtasks: z.array(subtaskSchema) });

const TRIAGE_SYSTEM_PROMPT = `You are the triage step of a coding harness's orchestrator. Given a \
request, decide whether answering or planning it requires looking at a specific codebase/repository, \
or whether it's self-contained (general knowledge, a direct question, math, or a request that already \
fully specifies everything needed with no reference to "the codebase", "this repo", "the bug", \
specific files, or project-specific behavior).

Set needsExploration=true only when the request clearly depends on repo-specific facts the requester \
didn't already provide (e.g. "fix the bug in the auth module", "what does this project's reward \
system do", "add a test next to the existing ones"). Set it false for requests that are fully \
self-contained regardless of any codebase (e.g. "what is 1+1", "explain what Thompson sampling is", \
"write a haiku about autumn") -- these should be planned directly with zero repo exploration.

If prior conversation turns are provided, use them only to understand what the new request refers \
to (e.g. "that file", "it", "now do the same for the other one") -- they are context for reading the \
new request, not additional requests to act on themselves.`;

const EXPLORE_SYSTEM_PROMPT = `You are the exploration phase of a coding harness's orchestrator, \
working in this project's repository. Use list_directory and read_file (paths relative to the \
project root) only as much as needed to understand what's involved in accomplishing the request \
below. Do not attempt to solve the request itself -- your job is only to gather and report relevant \
context (relevant files, their purpose, anything a planner would need to know). Be concise. Finish \
with a clear summary of what you found.

If prior conversation turns are provided, use them to figure out what a vague reference in the \
request points at (e.g. which file "that" means), not as something to re-explore or re-explain.`;

const STRUCTURE_SYSTEM_PROMPT = `You are the planning step of a coding harness's orchestrator. Break \
the request into a small number of concrete, actionable subtasks that together accomplish it.

Each subtask needs:
- id: a short, unique, kebab-case slug
- description: self-contained enough that a worker given only this description (plus the outputs of \
its listed dependencies) could act on it without other context
- dependsOn: ids of subtasks whose output this one needs before it can run (empty array if none)
- highRisk: true if this subtask touches security, authentication, payments, deletions, or production \
configuration

Keep the plan as small as the request actually calls for -- a simple, self-contained request should \
produce exactly one subtask, not be padded into an artificial multi-step plan. If context from \
exploring the repository is provided below, ground your subtasks in the real files/structure it \
describes rather than guessing.

If prior conversation turns are provided, resolve any vague reference in the request (e.g. "that \
file", "it", "the other one") into something concrete using them, so each subtask description stays \
self-contained on its own -- a worker sees only the subtask description, never the conversation \
history itself.`;

const REPLAN_SYSTEM_PROMPT = `You are the replanning step of a coding harness's orchestrator, invoked \
after a batch of subtasks has finished running. You'll be given the original request, the subtasks \
already known (planned, whether or not they've completed yet), and a summary of what's actually been \
produced so far. Decide whether the original request still needs additional subtasks beyond what's \
already planned.

Only propose new subtasks when the completed work actually reveals a gap: something the original \
decomposition missed, an edge case a completed subtask's output surfaced, or follow-on work implied \
by a result. Do not propose a subtask that duplicates or overlaps with an existing one (completed or \
still pending). If the existing plan already covers everything the request needs, return an empty \
subtasks list -- that is the correct answer far more often than not.

Each new subtask needs the same fields as a normal plan:
- id: a short, unique, kebab-case slug that does not collide with any existing subtask id
- description: self-contained enough that a worker given only this description (plus the outputs of \
its listed dependencies) could act on it without other context
- dependsOn: ids of subtasks (existing or newly proposed) whose output this one needs before it can \
run (empty array if none)
- highRisk: true if this subtask touches security, authentication, payments, deletions, or production \
configuration`;

/**
 * Real OrchestratorClient backed by the Vercel AI SDK. Three phases per call:
 *
 * 1. Triage (generateObject, no tools) -- decides whether this request needs repo context at
 *    all, so a trivial/self-contained request (e.g. "what is 1+1") never pays for exploration.
 * 2. Explore (only if triage says so) -- reuses Executor + the real read_file/list_directory
 *    tools exactly as any other subtask would, so subtasks get grounded in what's actually in
 *    the repo instead of guessing at file names (see docs/architecture.md for why that mattered).
 * 3. Structure (generateObject, no tools) -- turns the request (plus any exploration summary)
 *    into a SubtaskPlan. Orchestrator.plan() still does all DAG validation on the result; this
 *    client doesn't repair an invalid plan, it just produces one.
 *
 * All three phases also see request.conversationHistory (if non-empty), formatted as a prefix by
 * formatConversationHistory(). This is where multi-turn memory actually lives: earlier turns are
 * used to resolve a follow-up's vague references ("that file", "now do the same for the other
 * one") into concrete subtask descriptions during structure -- a worker executing a subtask never
 * sees the conversation history itself, only the already-resolved description.
 *
 * replan() is a separate, single generateObject call used after a batch of subtasks has
 * completed: given the original request, the subtasks already known, and what's actually been
 * produced, it decides whether more subtasks are needed and returns just the new ones (or none).
 * Orchestrator.replan() does all DAG validation against the merged existing+new graph; this
 * client doesn't repair an invalid result any more than decompose() does.
 */
export class AnthropicOrchestratorClient implements OrchestratorClient {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;
  private modelClient: AnthropicModelClient;
  private workspaceRoot: string;
  private exploreMaxTurns: number;
  private onTriage?: (result: TriageResult) => void;
  private onExploration?: (summary: string) => void;

  constructor(options: AnthropicOrchestratorClientOptions) {
    const provider = createAnthropic({ apiKey: options.apiKey });
    // triage/structure use options.modelId (default sonnet-5, a stronger planning model);
    // explore intentionally falls through to AnthropicModelClient's own default (haiku) unless
    // options.modelId is set -- exploration is meant to be the cheap phase, planning the strong one.
    this.model = provider(options.modelId ?? DEFAULT_MODEL_ID);
    this.modelClient = new AnthropicModelClient({ apiKey: options.apiKey, modelId: options.modelId });
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.exploreMaxTurns = options.exploreMaxTurns ?? DEFAULT_EXPLORE_MAX_TURNS;
    this.onTriage = options.onTriage;
    this.onExploration = options.onExploration;
  }

  async decompose(request: OrchestratorRequest): Promise<SubtaskPlan> {
    const historyText = formatConversationHistory(request.conversationHistory ?? []);

    const triage = await this.triage(request.requestDescription, historyText);
    this.onTriage?.(triage);

    let context: string | undefined;
    if (triage.needsExploration) {
      context = await this.explore(request.requestDescription, historyText);
      this.onExploration?.(context);
    }

    return this.structure(request.requestDescription, context, historyText);
  }

  async replan(context: ReplanContext): Promise<SubtaskPlan> {
    const existingSummary =
      context.existingSubtasks
        .map(
          (subtask) =>
            `- ${subtask.id} (dependsOn: [${subtask.dependsOn.join(", ")}]${subtask.highRisk ? ", highRisk" : ""}): ${subtask.description}`
        )
        .join("\n") || "(none)";

    const completedSummary =
      context.completedOutputs
        .map(
          (output) =>
            `- ${output.subtaskId} (${output.description}): ${truncate(output.finalText, MAX_COMPLETED_OUTPUT_SUMMARY_LENGTH)}`
        )
        .join("\n") || "(none completed yet)";

    const prompt = `Original request: ${context.originalRequest}

Existing subtasks (planned so far):
${existingSummary}

Completed so far:
${completedSummary}

Does the original request need any additional subtasks beyond what's already planned? Return only \
the new subtasks needed, or an empty list if none are needed.`;

    const { object } = await generateObject({
      model: this.model,
      schema: replanSchema,
      system: REPLAN_SYSTEM_PROMPT,
      prompt,
    });
    return object;
  }

  private async triage(requestDescription: string, historyText: string): Promise<TriageResult> {
    const { object } = await generateObject({
      model: this.model,
      schema: triageSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: `${historyText}Request: ${requestDescription}`,
    });
    return object;
  }

  private async explore(requestDescription: string, historyText: string): Promise<string> {
    const tools = [createReadFileTool(this.workspaceRoot), createListDirectoryTool(this.workspaceRoot)];
    const executor = new Executor(this.modelClient, tools, { maxTurns: this.exploreMaxTurns });
    const result = await executor.run(EXPLORE_SYSTEM_PROMPT, `${historyText}Request: ${requestDescription}`);
    return result.finalText;
  }

  private async structure(
    requestDescription: string,
    context: string | undefined,
    historyText: string
  ): Promise<SubtaskPlan> {
    const prompt = context
      ? `${historyText}Request: ${requestDescription}\n\nContext gathered from exploring the repository:\n${context}`
      : `${historyText}Request: ${requestDescription}`;
    const { object } = await generateObject({
      model: this.model,
      schema: planSchema,
      system: STRUCTURE_SYSTEM_PROMPT,
      prompt,
    });
    return object;
  }
}

/** Truncates a completed subtask's finalText for the replan prompt, so a long output doesn't dominate it. */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/**
 * Formats the last few conversation turns into a prefix block for triage/explore/structure
 * prompts, or "" if there's no history -- keeping the prefix empty (rather than an empty section
 * header) means a single-shot run's prompt is byte-for-byte what it was before this existed.
 * Exported (pure, no model calls) so this formatting can be unit tested directly, matching the
 * formatWriteApprovalPrompt/formatJudgePrompt split elsewhere in this codebase.
 */
export function formatConversationHistory(history: ConversationTurn[]): string {
  if (history.length === 0) return "";
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const turns = recent
    .map(
      (turn, i) =>
        `Turn ${i + 1} -- User: ${turn.requestDescription}\n` +
        `Answer: ${truncate(turn.finalText, MAX_HISTORY_ANSWER_LENGTH)}`
    )
    .join("\n\n");
  return (
    `Conversation so far in this session (context only -- the new request below is what you're ` +
    `actually deciding on):\n\n${turns}\n\n---\n\n`
  );
}
