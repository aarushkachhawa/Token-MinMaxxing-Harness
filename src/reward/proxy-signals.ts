import type { ProxySignal } from "./types.js";

export const finishedCleanly: ProxySignal = {
  name: "finishedCleanly",
  compute(result) {
    return result.stopReason === "final_answer" ? 1 : 0;
  },
};

export const noToolErrors: ProxySignal = {
  name: "noToolErrors",
  compute(result) {
    const toolCalls = result.trace.filter((entry) => entry.type === "tool_call").length;
    if (toolCalls === 0) return 1;
    const errors = result.trace.filter((entry) => entry.type === "tool_error").length;
    return Math.max(0, 1 - errors / toolCalls);
  },
};

export const producedOutput: ProxySignal = {
  name: "producedOutput",
  compute(result) {
    return result.finalText.trim().length > 0 ? 1 : 0;
  },
};

export const DEFAULT_PROXY_SIGNALS: ProxySignal[] = [finishedCleanly, noToolErrors, producedOutput];
