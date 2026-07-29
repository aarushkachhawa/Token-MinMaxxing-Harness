import type { Subtask } from "../orchestrator/types.js";
import type { SubtaskOutput } from "./types.js";

export interface ContextCompilerOptions {
  /** Hard cap on each dependency's included output; longer output is truncated, not dropped. */
  maxCharsPerDependency?: number;
}

const DEFAULT_MAX_CHARS_PER_DEPENDENCY = 4000;

/**
 * Slices in only what a subtask actually needs from prior work: the outputs of its *direct*
 * dependencies (per the orchestrator's DAG), not the full history of everything that ran
 * before it. Context volume is often a bigger cost lever than model choice, so the point is to
 * be deliberately narrow here rather than forwarding everything "just in case".
 */
export class ContextCompiler {
  private maxCharsPerDependency: number;

  constructor(options: ContextCompilerOptions = {}) {
    this.maxCharsPerDependency = options.maxCharsPerDependency ?? DEFAULT_MAX_CHARS_PER_DEPENDENCY;
  }

  /** Builds the full user-facing prompt for a subtask: its dependencies' outputs, then its own task. */
  compilePrompt(subtask: Subtask, priorOutputs: ReadonlyMap<string, SubtaskOutput>): string {
    if (subtask.dependsOn.length === 0) {
      return subtask.description;
    }

    const sections = subtask.dependsOn.map((depId) => {
      const output = priorOutputs.get(depId);
      if (!output) {
        throw new Error(
          `ContextCompiler: subtask "${subtask.id}" depends on "${depId}", but no output is ` +
            "recorded for it yet -- only call this once every dependency has actually completed."
        );
      }
      return this.formatDependency(output);
    });

    return (
      `Prior work this task depends on:\n\n${sections.join("\n\n")}\n\n---\n\n` +
      `Your task: ${subtask.description}`
    );
  }

  private formatDependency(output: SubtaskOutput): string {
    const truncated = output.finalText.length > this.maxCharsPerDependency;
    const text = truncated
      ? `${output.finalText.slice(0, this.maxCharsPerDependency)}\n[truncated]`
      : output.finalText;
    return `[${output.subtaskId}] ${output.description}\n> ${text}`;
  }
}
