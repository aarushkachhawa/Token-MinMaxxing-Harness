import type { ArmState } from "../router/bandit.js";

/** Where router arm state is durably saved/loaded; implementations decide the actual storage. */
export interface RouterStore {
  save(arms: ArmState[]): void;
  load(): ArmState[];
  close(): void;
}
