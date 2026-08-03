export {
  AnthropicJudgeClient,
  dampen,
  formatJudgePrompt,
  type AnthropicJudgeClientOptions,
  type JudgeVerdict,
} from "./anthropic-judge-client.js";
export { fakeCheck, ScriptedJudgeClient } from "./fakes.js";
export { JUDGE_RUBRIC } from "./judge-rubric.js";
export { DEFAULT_PROXY_SIGNALS, finishedCleanly, noToolErrors, producedOutput } from "./proxy-signals.js";
export { DEFAULT_WEIGHTS, RewardCollector, type RewardCollectorOptions, type RewardWeights } from "./reward-collector.js";
export type {
  DeterministicCheck,
  JudgeClient,
  JudgeRequest,
  ProxySignal,
  RewardBreakdown,
  TierScores,
} from "./types.js";
