/**
 * Shared clone/checkout helper for both pilot drivers. A bare local cache per repo means 20
 * pinned instances that repeat the same repo (django/django alone accounts for several of the
 * pilot's 20) only hit the network once each -- every per-instance checkout after that is a
 * local clone off the cache, not a fresh GitHub clone.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function ensureRepoCache(repo: string, cacheDir: string): Promise<string> {
  const bareDir = join(cacheDir, `${repo.replace("/", "__")}.git`);
  if (!existsSync(bareDir)) {
    await mkdir(cacheDir, { recursive: true });
    await run("git", ["clone", "--quiet", "--bare", `https://github.com/${repo}.git`, bareDir]);
  }
  return bareDir;
}

/** Fresh checkout of `baseCommit` into `destDir` (wiped first if it already exists from a prior
 * run), cloned locally off the bare cache -- no network hit beyond the first clone of that repo. */
export async function checkoutInstance(
  repo: string,
  baseCommit: string,
  cacheDir: string,
  destDir: string
): Promise<void> {
  const bareDir = await ensureRepoCache(repo, cacheDir);
  await rm(destDir, { recursive: true, force: true });
  await mkdir(dirname(destDir), { recursive: true });
  await run("git", ["clone", "--quiet", bareDir, destDir]);
  await run("git", ["-C", destDir, "checkout", "--quiet", baseCommit]);
}

/** `git diff` against the checkout's own base commit -- empty string means no tracked-file
 * change, which the SWE-bench grader treats as an unresolved empty-patch instance. */
export async function diffInstance(destDir: string): Promise<string> {
  const { stdout } = await run("git", ["-C", destDir, "diff"], { maxBuffer: 1024 * 1024 * 50 });
  return stdout;
}
