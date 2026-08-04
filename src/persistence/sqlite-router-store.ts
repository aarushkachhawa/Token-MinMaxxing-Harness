import { DatabaseSync } from "node:sqlite";
import type { ArmState } from "../router/bandit.js";
import type { RouterStore } from "./types.js";

/**
 * Persists router arm state to a SQLite file via node:sqlite (built into Node, no dependency
 * needed -- currently an experimental Node API, but functions correctly as of Node 23). Pass
 * ":memory:" for an ephemeral in-process database, useful in tests.
 */
export class SqliteRouterStore implements RouterStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS arms (
        category TEXT NOT NULL,
        model_id TEXT NOT NULL,
        cost REAL NOT NULL,
        prior_alpha REAL NOT NULL,
        prior_beta REAL NOT NULL,
        alpha REAL NOT NULL,
        beta REAL NOT NULL,
        decay REAL NOT NULL,
        PRIMARY KEY (category, model_id)
      )
    `);
  }

  save(arms: ArmState[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO arms (category, model_id, cost, prior_alpha, prior_beta, alpha, beta, decay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(category, model_id) DO UPDATE SET
        cost = excluded.cost,
        prior_alpha = excluded.prior_alpha,
        prior_beta = excluded.prior_beta,
        alpha = excluded.alpha,
        beta = excluded.beta,
        decay = excluded.decay
    `);
    for (const arm of arms) {
      upsert.run(
        arm.category,
        arm.modelId,
        arm.cost,
        arm.priorAlpha,
        arm.priorBeta,
        arm.alpha,
        arm.beta,
        arm.decay
      );
    }
  }

  load(): ArmState[] {
    const rows = this.db.prepare("SELECT * FROM arms").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      category: row.category as string,
      modelId: row.model_id as string,
      cost: row.cost as number,
      priorAlpha: row.prior_alpha as number,
      priorBeta: row.prior_beta as number,
      alpha: row.alpha as number,
      beta: row.beta as number,
      decay: row.decay as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}
