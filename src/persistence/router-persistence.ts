import { Router } from "../router/bandit.js";
import type { Rng } from "../router/rng.js";
import type { RouterStore } from "./types.js";

export function saveRouterState(router: Router, store: RouterStore): void {
  store.save(router.getAllArms());
}

export function loadRouterState(store: RouterStore, rng?: Rng): Router {
  const router = new Router(rng);
  for (const state of store.load()) {
    router.restoreArm(state);
  }
  return router;
}
