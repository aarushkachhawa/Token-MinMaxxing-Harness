import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { AnthropicModelClient } from "../executor/anthropic-model-client.js";
import { Executor } from "../executor/executor.js";
import { createListDirectoryTool, createReadFileTool } from "../tools/index.js";
import type { OrchestratorClient, OrchestratorRequest, SubtaskPlan } from "./types.js";

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
const DEFAULT_EXPLORE_MAX_TURNS = 6;

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
const planSchema = z.object({ subtasks: z.array(subtaskSchema).min(1) });

const TRIAGE_SYSTEM_PROMPT = `You are the triage step of a coding harness's orchestrator. Given a \
request, decide whether answering or planning it requires looking at a specific codebase/repository, \
or whether it's self-contained (general knowledge, a direct question, math, or a request that already \
fully specifies everything needed with no reference to "the codebase", "this repo", "the bug", \
specific files, or project-specific behavior).

Set needsExploration=true only when the request clearly depends on repo-specific facts the requester \
didn't already provide (e.g. "fix the bug in the auth module", "what does this project's reward \
system do", "add a test next to the existing ones"). Set it false for requests that are fully \
self-contained regardless of any codebase (e.g. "what is 1+1", "explain what Thompson sampling is", \
"write a haiku about autumn") -- these should be planned directly with zero repo exploration.`;

const EXPLORE_SYSTEM_PROMPT = `You are the exploration phase of a coding harness's orchestrator, \
working in this project's repository. Use list_directory and read_file (paths relative to the \
project root) only as much as needed to understand what's involved in accomplishing the request \
below. Do not attempt to solve the request itself -- your job is only to gather and report relevant \
context (relevant files, their purpose, anything a planner would need to know). Be concise. Finish \
with a clear summary of what you found.`;

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
describes rather than guessing.`;

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
    const triage = await this.triage(request.requestDescription);
    this.onTriage?.(triage);

    let context: string | undefined;
    if (triage.needsExploration) {
      context = await this.explore(request.requestDescription);
      this.onExploration?.(context);
    }

    return this.structure(request.requestDescription, context);
  }

  private async triage(requestDescription: string): Promise<TriageResult> {
    const { object } = await generateObject({
      model: this.model,
      schema: triageSchema,
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: `Request: ${requestDescription}`,
    });
    return object;
  }

  private async explore(requestDescription: string): Promise<string> {
    const tools = [createReadFileTool(this.workspaceRoot), createListDirectoryTool(this.workspaceRoot)];
    const executor = new Executor(this.modelClient, tools, { maxTurns: this.exploreMaxTurns });
    const result = await executor.run(EXPLORE_SYSTEM_PROMPT, requestDescription);
    return result.finalText;
  }

  private async structure(requestDescription: string, context: string | undefined): Promise<SubtaskPlan> {
    const prompt = context
      ? `Request: ${requestDescription}\n\nContext gathered from exploring the repository:\n${context}`
      : `Request: ${requestDescription}`;
    const { object } = await generateObject({
      model: this.model,
      schema: planSchema,
      system: STRUCTURE_SYSTEM_PROMPT,
      prompt,
    });
    return object;
  }
}
