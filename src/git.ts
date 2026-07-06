import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execFileAsync = promisify(execFile);

/** Stage numbers git assigns to the three versions of a conflicted file. */
export const STAGE_BASE = 1; // common ancestor
export const STAGE_OURS = 2; // current branch (HEAD)
export const STAGE_THEIRS = 3; // branch being merged in

export interface ConflictFile {
  /** Path relative to the repo root, using forward slashes (git's form). */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

/** Resolve the repository root that contains the given path. */
export async function getRepoRoot(cwd: string): Promise<string> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return out.trim();
}

/** List files currently in an unmerged (conflicted) state. */
export async function listConflicts(repoRoot: string): Promise<ConflictFile[]> {
  const out = await git(repoRoot, [
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
  ]);
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(repoRoot, relativePath),
    }));
}

/**
 * Read one stage of a conflicted file. Returns null when that stage does not
 * exist (e.g. an add/add conflict has no common ancestor / base stage).
 */
export async function readStage(
  repoRoot: string,
  relativePath: string,
  stage: number
): Promise<string | null> {
  try {
    return await git(repoRoot, ["show", `:${stage}:${relativePath}`]);
  } catch {
    return null;
  }
}

export interface ThreeWayContent {
  base: string;
  ours: string;
  theirs: string;
}

/** Read the base / ours / theirs versions of a conflicted file. */
export async function readThreeWay(
  repoRoot: string,
  relativePath: string
): Promise<ThreeWayContent> {
  const [base, ours, theirs] = await Promise.all([
    readStage(repoRoot, relativePath, STAGE_BASE),
    readStage(repoRoot, relativePath, STAGE_OURS),
    readStage(repoRoot, relativePath, STAGE_THEIRS),
  ]);
  return {
    base: base ?? "",
    ours: ours ?? "",
    theirs: theirs ?? "",
  };
}

/** Mark a file as resolved by staging it. */
export async function stageResolved(
  repoRoot: string,
  relativePath: string
): Promise<void> {
  await git(repoRoot, ["add", "--", relativePath]);
}

export interface MergeBranches {
  ours: string;
  theirs: string;
}

/**
 * Best-effort branch labels for the pane headers: "ours" is the current branch,
 * "theirs" is whatever is being merged in (MERGE_HEAD). Falls back to generic
 * labels for detached HEAD, rebases, or when the names can't be resolved.
 */
export async function getMergeBranches(
  repoRoot: string
): Promise<MergeBranches> {
  let ours = "Current";
  let theirs = "Incoming";

  try {
    const head = (
      await git(repoRoot, ["symbolic-ref", "--short", "HEAD"])
    ).trim();
    if (head) {
      ours = head;
    }
  } catch {
    // detached HEAD — keep the fallback
  }

  // The incoming ref differs by operation: merge, rebase, or cherry-pick.
  for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    try {
      const name = (
        await git(repoRoot, ["name-rev", "--name-only", "--exclude=tags/*", ref])
      ).trim();
      if (name && name !== "undefined") {
        theirs = name.replace(/[~^].*$/, "");
        break;
      }
    } catch {
      // ref doesn't exist for the current operation — try the next one
    }
  }

  return { ours, theirs };
}
