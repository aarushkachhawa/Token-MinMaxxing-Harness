import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface StoredSelection {
  enabledModelIds: string[];
}

/**
 * Persists which catalog models the user has toggled on via /models, so the choice survives
 * across CLI sessions. A brand-new user has no file yet -- load() then returns an empty
 * selection, matching "no models allowed until you opt in" rather than defaulting to any model.
 */
export class ModelSelectionStore {
  private path: string;
  private enabledModelIds: Set<string>;

  private constructor(path: string, enabledModelIds: Set<string>) {
    this.path = path;
    this.enabledModelIds = enabledModelIds;
  }

  static load(path: string): ModelSelectionStore {
    if (!existsSync(path)) {
      return new ModelSelectionStore(path, new Set());
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as StoredSelection;
    return new ModelSelectionStore(path, new Set(parsed.enabledModelIds ?? []));
  }

  isEnabled(modelId: string): boolean {
    return this.enabledModelIds.has(modelId);
  }

  list(): string[] {
    return [...this.enabledModelIds];
  }

  /** Flips the model's on/off state and persists immediately, returning the new state. */
  toggle(modelId: string): boolean {
    const nowEnabled = !this.enabledModelIds.has(modelId);
    if (nowEnabled) {
      this.enabledModelIds.add(modelId);
    } else {
      this.enabledModelIds.delete(modelId);
    }
    this.save();
    return nowEnabled;
  }

  private save(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const payload: StoredSelection = { enabledModelIds: [...this.enabledModelIds].sort() };
    writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
