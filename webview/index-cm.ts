import CodeMirror from "codemirror";
import type { HostMessage } from "../src/protocol";

import "codemirror/lib/codemirror.css";
import "codemirror/addon/merge/merge.css";
import "codemirror/theme/material-darker.css";
import "./style-cm.css";

// Syntax modes (a pragmatic subset for the prototype).
import "codemirror/mode/javascript/javascript";
import "codemirror/mode/css/css";
import "codemirror/mode/xml/xml";
import "codemirror/mode/htmlmixed/htmlmixed";
import "codemirror/mode/markdown/markdown";
import "codemirror/mode/python/python";
import "codemirror/mode/clike/clike";
import "codemirror/mode/shell/shell";
import "codemirror/mode/yaml/yaml";

// The CM5 merge addon expects diff_match_patch (+ its constants) as globals.
import * as DMP from "diff-match-patch";
Object.assign(globalThis as Record<string, unknown>, {
  diff_match_patch: (DMP as { diff_match_patch: unknown }).diff_match_patch,
  DIFF_DELETE: (DMP as { DIFF_DELETE: unknown }).DIFF_DELETE,
  DIFF_INSERT: (DMP as { DIFF_INSERT: unknown }).DIFF_INSERT,
  DIFF_EQUAL: (DMP as { DIFF_EQUAL: unknown }).DIFF_EQUAL,
});
// Side-effect import: registers CodeMirror.MergeView (needs the globals above at construction time).
import "codemirror/addon/merge/merge.js";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

function modeFor(path: string): unknown {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
      return { name: "javascript", typescript: ext.startsWith("ts") };
    case "json":
      return { name: "javascript", json: true };
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "htmlmixed";
    case "xml":
    case "svg":
      return "xml";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "hpp":
    case "java":
    case "cs":
      return "clike";
    case "sh":
    case "bash":
      return "shell";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return null;
  }
}

let mergeView: { editor(): { getValue(): string } } | null = null;

function setup(init: HostMessage): void {
  document.getElementById("title")!.textContent = init.relativePath;

  const dark = !matchMedia("(prefers-color-scheme: light)").matches;
  const container = document.getElementById("mergeview")!;

  // 3-way: editable center (= base → becomes the result), ours left, theirs right.
  mergeView = (CodeMirror as unknown as {
    MergeView(el: HTMLElement, opts: Record<string, unknown>): { editor(): { getValue(): string } };
  }).MergeView(container, {
    value: init.base,
    origLeft: init.ours,
    origRight: init.theirs,
    lineNumbers: true,
    mode: modeFor(init.relativePath),
    theme: dark ? "material-darker" : "default",
    connect: "align",
    collapseIdentical: false,
    highlightDifferences: true,
    revertButtons: true,
    showDifferences: true,
  });
}

document.getElementById("save")!.addEventListener("click", () => {
  if (mergeView) {
    vscode.postMessage({ type: "save", content: mergeView.editor().getValue() });
  }
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.data.type === "init") {
    setup(event.data);
  }
});

vscode.postMessage({ type: "ready" });
