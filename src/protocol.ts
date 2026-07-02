/**
 * Types shared between the extension host and the webview. Pure types + plain
 * data only — no `vscode` or Node imports — so the webview can import it too.
 */

/**
 * A change classification, IntelliJ-style:
 * - `conflict`: both sides changed the same base region differently.
 * - `left`:  only "ours" changed this base region (non-conflicting).
 * - `right`: only "theirs" changed this base region (non-conflicting).
 * - `both`:  both sides made the *same* change (non-conflicting).
 */
export type ChangeType = "conflict" | "left" | "right" | "both";

/**
 * One block of the merge. `stable` blocks are identical across all three
 * versions and are emitted into the result verbatim. Every other block is a
 * "change" the user can apply from one side (or resolve, if a conflict).
 */
export interface MergeBlock {
  type: "stable" | ChangeType;
  ours: string[];
  base: string[];
  theirs: string[];
  /** 0-based start line of this block in the full "ours" document. */
  oursStart: number;
  /** 0-based start line of this block in the full "theirs" document. */
  theirsStart: number;
}

export interface MergeModel {
  blocks: MergeBlock[];
  /** Number of non-stable blocks (IntelliJ's "N changes"). */
  changeCount: number;
  /** Number of conflict blocks (IntelliJ's "M conflicts"). */
  conflictCount: number;
}

/** Host → webview messages. */
export type HostMessage = {
  type: "init";
  relativePath: string;
  ours: string;
  base: string;
  theirs: string;
  /** Branch labels for the pane headers, e.g. "main" / "feature". */
  oursLabel: string;
  theirsLabel: string;
  model: MergeModel;
  /** URI (as string) the webview loads the Monaco editor worker from. */
  workerUri: string;
};

/** Webview → host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "save"; content: string }
  | { type: "info"; text: string };
