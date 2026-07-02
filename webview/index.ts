import * as monaco from "monaco-editor";
import type { HostMessage, MergeModel, ChangeType } from "../src/protocol";
import "./style.css";

// ---------------------------------------------------------------------------
// VS Code webview bridge
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

let workerUri = "";
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
  {
    getWorker() {
      const proxy = `self.MonacoEnvironment={baseUrl:''};importScripts('${workerUri}');`;
      const blob = new Blob([proxy], { type: "application/javascript" });
      return new Worker(URL.createObjectURL(blob));
    },
  };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Side = "ours" | "theirs";

interface Block {
  type: "stable" | ChangeType;
  isChange: boolean;
  ours: string[];
  base: string[];
  theirs: string[];
  /** Static 1-based line positions in the (read-only) side editors. */
  oursStart: number;
  oursLen: number;
  theirsStart: number;
  theirsLen: number;
  /** Live-tracked decoration id for this block's region in the result model. */
  resultId: string;
  /**
   * Sides accepted into the result, in click order (IntelliJ-style: accepting
   * one side of a conflict does not discard the other — they accumulate).
   */
  applied: Side[];
  ignoredOurs: boolean;
  ignoredTheirs: boolean;
}

let oursEditor: monaco.editor.IStandaloneCodeEditor;
let theirsEditor: monaco.editor.IStandaloneCodeEditor;
let resultEditor: monaco.editor.IStandaloneCodeEditor;
let oursModel: monaco.editor.ITextModel;
let theirsModel: monaco.editor.ITextModel;
let resultModel: monaco.editor.ITextModel;

const blocks: Block[] = [];
let current = -1;

let oursDecoIds: string[] = [];
let theirsDecoIds: string[] = [];
let resultArrowIds: string[] = [];
let oursZoneIds: string[] = [];
let resultZoneIds: string[] = [];
let theirsZoneIds: string[] = [];

const GUTTER_W = 34;

function fileUri(path: string): monaco.Uri {
  return monaco.Uri.file(path);
}

// Which sides a change offers to apply. "both" (identical edit on both sides)
// collapses to a single "ours" action.
const hasLeft = (t: Block["type"]) => t === "left" || t === "both" || t === "conflict";
const hasRight = (t: Block["type"]) => t === "right" || t === "conflict";

function sidesOf(b: Block): Side[] {
  const s: Side[] = [];
  if (hasLeft(b.type)) s.push("ours");
  if (hasRight(b.type)) s.push("theirs");
  return s;
}
function handled(b: Block, side: Side): boolean {
  return b.applied.includes(side) || (side === "ours" ? b.ignoredOurs : b.ignoredTheirs);
}
function isResolved(b: Block): boolean {
  return sidesOf(b).every((s) => handled(b, s));
}
/** Result content for a block: base until a side is accepted, then the accepted sides in order. */
function regionContent(b: Block): string[] {
  if (b.applied.length === 0) {
    return b.base;
  }
  const out: string[] = [];
  for (const s of b.applied) {
    out.push(...(s === "ours" ? b.ours : b.theirs));
  }
  return out;
}

function oursRangeOf(b: Block): monaco.IRange | null {
  return b.oursLen > 0
    ? { startLineNumber: b.oursStart, startColumn: 1, endLineNumber: b.oursStart + b.oursLen - 1, endColumn: 1 }
    : null;
}
function theirsRangeOf(b: Block): monaco.IRange | null {
  return b.theirsLen > 0
    ? { startLineNumber: b.theirsStart, startColumn: 1, endLineNumber: b.theirsStart + b.theirsLen - 1, endColumn: 1 }
    : null;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup(init: HostMessage): void {
  workerUri = init.workerUri;
  document.getElementById("result-title")!.textContent = `Result — ${init.relativePath}`;
  setHeader("ours-title", "Changes from", init.oursLabel);
  setHeader("theirs-title", "Changes from", init.theirsLabel);

  const theme = matchMedia("(prefers-color-scheme: light)").matches ? "vs" : "vs-dark";
  monaco.editor.setTheme(theme);

  oursModel = monaco.editor.createModel(init.ours, undefined, fileUri("ours/" + init.relativePath));
  theirsModel = monaco.editor.createModel(init.theirs, undefined, fileUri("theirs/" + init.relativePath));

  const { text, spans } = buildInitial(init.model);
  resultModel = monaco.editor.createModel(text, oursModel.getLanguageId(), fileUri("result/" + init.relativePath));

  const common: monaco.editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    glyphMargin: true,
    lineDecorationsWidth: 22,
    overviewRulerLanes: 0,
  };

  oursEditor = monaco.editor.create(document.getElementById("ours")!, { ...common, model: oursModel, readOnly: true });
  theirsEditor = monaco.editor.create(document.getElementById("theirs")!, { ...common, model: theirsModel, readOnly: true });
  resultEditor = monaco.editor.create(document.getElementById("result")!, { ...common, model: resultModel, readOnly: false });

  // One tracked decoration per block so its result range follows edits.
  const ids = resultModel.deltaDecorations(
    [],
    spans.map((s) => ({
      range: new monaco.Range(s.start, 1, s.end, 1),
      options: {
        isWholeLine: true,
        stickiness: monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
      },
    }))
  );
  blocks.forEach((b, i) => (b.resultId = ids[i]));

  wireGutterClicks(resultEditor, "result");
  wireGutterClicks(theirsEditor, "theirs");
  wireSideNavClick(oursEditor);
  wireToolbar();
  wireScrollSync();
  wireRedrawTriggers();

  render();
  scheduleRedraw();
  const first = blocks.findIndex((b) => b.isChange);
  if (first >= 0) {
    goTo(first);
  }

  // Ribbons/alignment depend on measured line tops, which aren't final until
  // layout + fonts settle. Force a few redraws so they appear without needing
  // the user to scroll or resize first.
  setTimeout(scheduleRedraw, 150);
  setTimeout(scheduleRedraw, 600);
  const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    fonts.ready.then(scheduleRedraw).catch(() => {});
  }
}

function setHeader(id: string, prefix: string, label: string): void {
  document.getElementById(id)!.innerHTML = `${prefix} <b>${escapeHtml(label)}</b>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------------------------------------------------------------------------
// Build the initial result (= base) and populate the block list
// ---------------------------------------------------------------------------

function buildInitial(model: MergeModel): { text: string; spans: { start: number; end: number }[] } {
  const lines: string[] = [];
  const spans: { start: number; end: number }[] = [];
  let oc = 1;
  let tc = 1;

  for (const mb of model.blocks) {
    const isChange = mb.type !== "stable";
    const seed = mb.base.length ? mb.base : isChange ? [""] : mb.base;
    const start = lines.length + 1;
    lines.push(...seed);
    const end = lines.length;
    spans.push({ start, end });

    blocks.push({
      type: mb.type,
      isChange,
      ours: mb.ours,
      base: mb.base,
      theirs: mb.theirs,
      oursStart: oc,
      oursLen: mb.ours.length,
      theirsStart: tc,
      theirsLen: mb.theirs.length,
      resultId: "",
      applied: [],
      ignoredOurs: false,
      ignoredTheirs: false,
    });
    oc += mb.ours.length;
    tc += mb.theirs.length;
  }

  return { text: lines.join("\n"), spans };
}

// ---------------------------------------------------------------------------
// Applying / ignoring changes
// ---------------------------------------------------------------------------

function replaceResult(b: Block, newLines: string[]): void {
  const dr = resultModel.getDecorationRange(b.resultId);
  if (!dr) {
    return;
  }
  const start = dr.startLineNumber;
  const end = dr.endLineNumber;
  const range = new monaco.Range(start, 1, end, resultModel.getLineMaxColumn(end));
  resultEditor.executeEdits("merge-resolver", [{ range, text: newLines.join("\n"), forceMoveMarkers: true }]);

  // Re-anchor the region decoration to its exact new extent. Monaco's marker
  // tracking is unreliable when a replace changes the line count, so we set the
  // range deterministically from the known start + inserted line count —
  // otherwise the next accept reads a too-short range and duplicates content.
  const newLen = Math.max(1, newLines.length);
  const [id] = resultModel.deltaDecorations(
    [b.resultId],
    [
      {
        range: new monaco.Range(start, 1, start + newLen - 1, 1),
        options: {
          isWholeLine: true,
          stickiness: monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
        },
      },
    ]
  );
  b.resultId = id;
}

/** Recompute the block's result region from base + accepted sides. */
function recomputeRegion(b: Block): void {
  const content = regionContent(b);
  replaceResult(b, content.length ? content : [""]);
}

function applySide(i: number, side: Side): void {
  const b = blocks[i];
  if (!b.applied.includes(side)) {
    b.applied.push(side);
  }
  current = i;
  recomputeRegion(b);
  render();
  scheduleRedraw();
}
function ignoreSide(i: number, side: Side): void {
  const b = blocks[i];
  if (side === "ours") {
    b.ignoredOurs = true;
  } else {
    b.ignoredTheirs = true;
  }
  current = i;
  render();
  scheduleRedraw();
}
function applyNonConflicting(which: "left" | "right" | "all"): void {
  blocks.forEach((b) => {
    if (!b.isChange || b.type === "conflict" || isResolved(b)) {
      return;
    }
    const takeOurs = which !== "right" && (b.type === "left" || b.type === "both");
    const takeTheirs = which !== "left" && b.type === "right";
    if (takeOurs && !b.applied.includes("ours")) {
      b.applied.push("ours");
      recomputeRegion(b);
    } else if (takeTheirs && !b.applied.includes("theirs")) {
      b.applied.push("theirs");
      recomputeRegion(b);
    }
  });
  render();
  scheduleRedraw();
}

// ---------------------------------------------------------------------------
// Rendering (decorations + word-level highlight)
// ---------------------------------------------------------------------------

function resultClass(b: Block, active: boolean): string {
  const base = isResolved(b) ? "chg-resolved" : b.type === "conflict" ? "chg-conflict" : "chg-nonconflict";
  return active ? `${base} chg-current` : base;
}

function render(): void {
  const live = blocks.map((b) => resultModel.getDecorationRange(b.resultId));
  const resultDecos: monaco.editor.IModelDeltaDecoration[] = blocks.map((b, i) => {
    const options: monaco.editor.IModelDecorationOptions = {
      isWholeLine: true,
      stickiness: monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
    };
    if (b.isChange) {
      options.className = resultClass(b, i === current);
    }
    return { range: live[i] ?? new monaco.Range(1, 1, 1, 1), options };
  });
  const newIds = resultModel.deltaDecorations(blocks.map((b) => b.resultId), resultDecos);
  newIds.forEach((id, i) => (blocks[i].resultId = id));

  // Arrows + insertion line live in a separate (untracked) collection so their
  // anchor line can differ from the tracked region decoration.
  resultArrowIds = resultModel.deltaDecorations(resultArrowIds, resultArrowDecos());

  oursDecoIds = oursModel.deltaDecorations(oursDecoIds, sideDecos("ours"));
  theirsDecoIds = theirsModel.deltaDecorations(theirsDecoIds, sideDecos("theirs"));

  updateStatus();
}

/**
 * The ours »/✕ actions in the Result gutter, plus the insertion line. Once a
 * side has already been accepted, a still-pending side no longer *replaces* —
 * it *inserts* after the accepted content, so the arrow rotates diagonally and
 * moves to the region's end, above a thin insertion line marking where it lands.
 */
function resultArrowDecos(): monaco.editor.IModelDeltaDecoration[] {
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  for (const b of blocks) {
    if (!b.isChange) {
      continue;
    }
    const r = resultModel.getDecorationRange(b.resultId);
    if (!r) {
      continue;
    }
    const inserting = b.applied.length > 0 && !isResolved(b);
    const oursPending = hasLeft(b.type) && !handled(b, "ours");

    if (oursPending) {
      const line = inserting ? r.endLineNumber : r.startLineNumber;
      // Mirror the right pane: the apply arrow (») sits next to the Result text
      // (line-decorations column) and ✕ is pushed to the far-left glyph margin.
      const options: monaco.editor.IModelDecorationOptions = {
        glyphMarginClassName: "act-ignore",
        glyphMarginHoverMessage: { value: "Ignore left" },
        linesDecorationsClassName: inserting ? "act-apply-ours-insert" : "act-apply-ours",
      };
      if (inserting) {
        options.isWholeLine = true;
        options.className = "mr-insert-line";
      }
      decos.push({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options,
      });
    } else if (inserting) {
      // Ours already handled but theirs still pending — still show where it lands.
      decos.push({
        range: { startLineNumber: r.endLineNumber, startColumn: 1, endLineNumber: r.endLineNumber, endColumn: 1 },
        options: { isWholeLine: true, className: "mr-insert-line" },
      });
    }
  }
  return decos;
}

function sideDecos(side: Side): monaco.editor.IModelDeltaDecoration[] {
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  blocks.forEach((b, i) => {
    if (!b.isChange) {
      return;
    }
    const relevant = side === "ours" ? hasLeft(b.type) : hasRight(b.type);
    if (!relevant) {
      return;
    }
    const range = side === "ours" ? oursRangeOf(b) : theirsRangeOf(b);
    if (!range) {
      return;
    }
    const active = i === current;
    const cls =
      (isResolved(b) ? "side-resolved" : b.type === "conflict" ? "side-conflict" : "side-nonconflict") +
      (active ? " side-current" : "");
    decos.push({ range, options: { isWholeLine: true, className: cls } });

    if (side === "theirs" && hasRight(b.type) && !handled(b, "theirs")) {
      const inserting = b.applied.length > 0;
      decos.push({
        range: { startLineNumber: range.startLineNumber, startColumn: 1, endLineNumber: range.startLineNumber, endColumn: 1 },
        options: {
          glyphMarginClassName: inserting ? "act-apply-theirs-insert" : "act-apply-theirs",
          glyphMarginHoverMessage: { value: inserting ? "Insert right below" : "Accept right" },
          linesDecorationsClassName: "act-ignore",
        },
      });
    }

    // Word-level highlight (only when line counts line up 1:1 with base).
    try {
      addWordDiff(decos, b, side);
    } catch (e) {
      console.error("word-diff failed", e);
    }
  });
  return decos;
}

// ---------------------------------------------------------------------------
// Word-level diff
// ---------------------------------------------------------------------------

function addWordDiff(out: monaco.editor.IModelDeltaDecoration[], b: Block, side: Side): void {
  const sideLines = side === "ours" ? b.ours : b.theirs;
  const startLine = side === "ours" ? b.oursStart : b.theirsStart;
  if (sideLines.length !== b.base.length || sideLines.length === 0) {
    return; // fall back to whole-line highlight
  }
  for (let k = 0; k < sideLines.length; k++) {
    if (sideLines[k] === b.base[k]) {
      continue;
    }
    for (const [s, e] of changedRanges(b.base[k], sideLines[k])) {
      out.push({
        range: { startLineNumber: startLine + k, startColumn: s + 1, endLineNumber: startLine + k, endColumn: e + 1 },
        options: { className: "word-diff", inlineClassName: "word-diff" },
      });
    }
  }
}

function tokenize(line: string): { text: string; start: number }[] {
  const tokens: { text: string; start: number }[] = [];
  const re = /(\s+|\w+|[^\s\w]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push({ text: m[0], start: m.index });
  }
  return tokens;
}

/** Column ranges (0-based) in `sideLine` that differ from `baseLine`. */
function changedRanges(baseLine: string, sideLine: string): [number, number][] {
  const A = tokenize(baseLine).map((t) => t.text);
  const B = tokenize(sideLine);
  const bt = B.map((t) => t.text);
  const n = A.length;
  const m = bt.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === bt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === bt[j]) {
      matched.add(j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  const raw: [number, number][] = [];
  B.forEach((t, idx) => {
    if (!matched.has(idx) && t.text.trim().length > 0) {
      raw.push([t.start, t.start + t.text.length]);
    }
  });
  // Merge adjacent/touching ranges.
  const merged: [number, number][] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Alignment view zones
// ---------------------------------------------------------------------------

interface Layout {
  oursStart: number;
  oursLen: number;
  resStart: number;
  resLen: number;
  theirsStart: number;
  theirsLen: number;
}

function computeLayout(): Layout[] {
  return blocks.map((b) => {
    const r = resultModel.getDecorationRange(b.resultId);
    const resStart = r ? r.startLineNumber : 1;
    const resLen = r ? r.endLineNumber - r.startLineNumber + 1 : 0;
    return {
      oursStart: b.oursStart,
      oursLen: b.oursLen,
      resStart,
      resLen,
      theirsStart: b.theirsStart,
      theirsLen: b.theirsLen,
    };
  });
}

function relayout(): void {
  const layout = computeLayout();
  const ours: { after: number; lines: number }[] = [];
  const res: { after: number; lines: number }[] = [];
  const theirs: { after: number; lines: number }[] = [];

  layout.forEach((l) => {
    const max = Math.max(l.oursLen, l.resLen, l.theirsLen);
    pad(ours, l.oursStart, l.oursLen, max);
    pad(res, l.resStart, l.resLen, max);
    pad(theirs, l.theirsStart, l.theirsLen, max);
  });

  oursZoneIds = applyZones(oursEditor, oursZoneIds, ours);
  resultZoneIds = applyZones(resultEditor, resultZoneIds, res);
  theirsZoneIds = applyZones(theirsEditor, theirsZoneIds, theirs);
}

function pad(list: { after: number; lines: number }[], start: number, len: number, max: number): void {
  const extra = max - len;
  if (extra > 0) {
    // Zone goes after the block's last content line (or the line before, for empty blocks).
    list.push({ after: len > 0 ? start + len - 1 : start - 1, lines: extra });
  }
}

function applyZones(
  editor: monaco.editor.IStandaloneCodeEditor,
  old: string[],
  zones: { after: number; lines: number }[]
): string[] {
  const ids: string[] = [];
  editor.changeViewZones((accessor) => {
    for (const id of old) {
      accessor.removeZone(id);
    }
    for (const z of zones) {
      const dom = document.createElement("div");
      dom.className = "align-zone";
      ids.push(accessor.addZone({ afterLineNumber: Math.max(0, z.after), heightInLines: z.lines, domNode: dom }));
    }
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Connecting ribbons (SVG)
// ---------------------------------------------------------------------------

/**
 * Viewport Y (top/bottom) of a line region in an editor. `scroll` is a single
 * shared scroll reference (the three editors are scroll-synced, so using one
 * value avoids skew from transient per-editor differences). The bottom is the
 * top of the line *after* the region — Monaco's exact position including any
 * view zones — rather than top + configured lineHeight, which can drift.
 */
function regionY(
  editor: monaco.editor.IStandaloneCodeEditor,
  start: number,
  len: number,
  scroll: number
): { top: number; bottom: number } {
  const top = editor.getTopForLineNumber(start) - scroll;
  const bottom = len > 0 ? editor.getTopForLineNumber(start + len) - scroll : top;
  return { top, bottom };
}

function fillFor(type: Block["type"], resolved: boolean): string {
  if (resolved) {
    return "rgba(120,120,120,0.12)";
  }
  return type === "conflict" ? "rgba(196,90,74,0.22)" : "rgba(87,171,90,0.2)";
}

function drawBands(): void {
  const svgL = document.getElementById("svg-l") as unknown as SVGSVGElement | null;
  const svgR = document.getElementById("svg-r") as unknown as SVGSVGElement | null;
  if (!svgL || !svgR) {
    return;
  }
  const h = svgL.clientHeight;
  const w = GUTTER_W;
  svgL.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svgR.setAttribute("viewBox", `0 0 ${w} ${h}`);
  while (svgL.firstChild) svgL.removeChild(svgL.firstChild);
  while (svgR.firstChild) svgR.removeChild(svgR.firstChild);

  // The editors are scroll-synced; use one shared reference for all three.
  const scroll = resultEditor.getScrollTop();

  blocks.forEach((b) => {
    if (!b.isChange) {
      return;
    }
    const r = resultModel.getDecorationRange(b.resultId);
    if (!r) {
      return;
    }
    const resY = regionY(resultEditor, r.startLineNumber, r.endLineNumber - r.startLineNumber + 1, scroll);
    const fill = fillFor(b.type, isResolved(b));

    if (b.oursLen > 0) {
      const oY = regionY(oursEditor, b.oursStart, b.oursLen, scroll);
      svgL.appendChild(ribbon(oY.top, oY.bottom, resY.top, resY.bottom, w, fill));
    }
    if (b.theirsLen > 0) {
      const tY = regionY(theirsEditor, b.theirsStart, b.theirsLen, scroll);
      svgR.appendChild(ribbon(resY.top, resY.bottom, tY.top, tY.bottom, w, fill));
    }
  });
}

/** A trapezoid from the left edge (l0..l1) to the right edge (r0..r1). */
function ribbon(l0: number, l1: number, r0: number, r1: number, w: number, fill: string): SVGPolygonElement {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  const pts = `0,${l0.toFixed(1)} 0,${Math.max(l1, l0 + 1).toFixed(1)} ${w},${Math.max(r1, r0 + 1).toFixed(1)} ${w},${r0.toFixed(1)}`;
  p.setAttribute("points", pts);
  p.setAttribute("fill", fill);
  return p;
}

// ---------------------------------------------------------------------------
// Gutter clicks + navigation
// ---------------------------------------------------------------------------

function wireGutterClicks(editor: monaco.editor.IStandaloneCodeEditor, which: "result" | "theirs"): void {
  editor.onMouseDown((e) => {
    const line = e.target.position?.lineNumber;
    if (line == null) {
      return;
    }
    const glyph = e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
    const lineDeco = e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS;
    if (!glyph && !lineDeco) {
      return;
    }
    const idx = which === "result" ? findByResultLine(line) : findBySideLine(line, "theirs");
    if (idx < 0) {
      return;
    }
    const side: Side = which === "result" ? "ours" : "theirs";
    // Columns are mirrored between the two sides: on the Result gutter the apply
    // arrow lives in line-decorations and ✕ in the glyph margin; on Theirs it's
    // the reverse. So "apply" is line-deco on the left, glyph on the right.
    const isApply = which === "result" ? lineDeco : glyph;
    if (isApply) {
      applySide(idx, side);
    } else {
      ignoreSide(idx, side);
    }
  });
}

function wireSideNavClick(editor: monaco.editor.IStandaloneCodeEditor): void {
  editor.onMouseDown((e) => {
    const line = e.target.position?.lineNumber;
    if (line == null) {
      return;
    }
    const idx = findBySideLine(line, "ours");
    if (idx >= 0) {
      goTo(idx);
    }
  });
}

function findByResultLine(line: number): number {
  return blocks.findIndex((b) => {
    if (!b.isChange) {
      return false;
    }
    const r = resultModel.getDecorationRange(b.resultId);
    return r != null && line >= r.startLineNumber && line <= r.endLineNumber;
  });
}
function findBySideLine(line: number, side: Side): number {
  return blocks.findIndex((b) => {
    if (!b.isChange) {
      return false;
    }
    const r = side === "ours" ? oursRangeOf(b) : theirsRangeOf(b);
    return r != null && line >= r.startLineNumber && line <= r.endLineNumber;
  });
}

function goTo(i: number): void {
  current = i;
  const b = blocks[i];
  const rr = resultModel.getDecorationRange(b.resultId);
  if (rr) {
    resultEditor.revealRangeInCenter(rr);
    resultEditor.setPosition({ lineNumber: rr.startLineNumber, column: 1 });
  }
  const oR = oursRangeOf(b);
  if (oR) {
    oursEditor.revealRangeInCenter(oR);
  }
  const tR = theirsRangeOf(b);
  if (tR) {
    theirsEditor.revealRangeInCenter(tR);
  }
  resultEditor.focus();
  render();
  scheduleRedraw();
}

function step(dir: 1 | -1): void {
  const idxs = blocks.map((b, i) => (b.isChange ? i : -1)).filter((i) => i >= 0);
  if (idxs.length === 0) {
    return;
  }
  const unresolved = idxs.filter((i) => !isResolved(blocks[i]));
  const pool = unresolved.length ? unresolved : idxs;
  const pos = pool.indexOf(current);
  const next = pos < 0 ? pool[0] : pool[(pos + dir + pool.length) % pool.length];
  goTo(next);
}

// ---------------------------------------------------------------------------
// Scroll sync + redraw triggers
// ---------------------------------------------------------------------------

let syncing = false;
function wireScrollSync(): void {
  const editors = [oursEditor, resultEditor, theirsEditor];
  for (const src of editors) {
    src.onDidScrollChange((e) => {
      if (syncing) {
        return;
      }
      syncing = true;
      const top = src.getScrollTop();
      const left = src.getScrollLeft();
      for (const dst of editors) {
        if (dst === src) {
          continue;
        }
        if (dst.getScrollTop() !== top) {
          dst.setScrollTop(top);
        }
        if (dst.getScrollLeft() !== left) {
          dst.setScrollLeft(left);
        }
      }
      syncing = false;
      // Ribbons depend only on vertical position — redraw on vertical scroll
      // only, so horizontal scrolling doesn't make them shift/flicker.
      if (e.scrollTopChanged) {
        drawBandsSafe();
      }
    });
  }
}

function wireRedrawTriggers(): void {
  window.addEventListener("resize", scheduleRedraw);
  resultEditor.onDidLayoutChange(scheduleRedraw);
  resultModel.onDidChangeContent(scheduleRedraw);
}

let raf = 0;
function scheduleRedraw(): void {
  if (raf) {
    return;
  }
  raf = requestAnimationFrame(() => {
    raf = 0;
    try {
      relayout();
    } catch (e) {
      console.error("relayout failed", e);
    }
    // View zones are applied on Monaco's next render, so wait two frames before
    // measuring line tops for the ribbons.
    requestAnimationFrame(() => requestAnimationFrame(drawBandsSafe));
  });
}
function drawBandsSafe(): void {
  try {
    drawBands();
  } catch (e) {
    console.error("drawBands failed", e);
  }
}

// ---------------------------------------------------------------------------
// Toolbar + status + boot
// ---------------------------------------------------------------------------

function save(): void {
  vscode.postMessage({ type: "save", content: resultModel.getValue() });
}

function wireToolbar(): void {
  document.getElementById("prev")!.addEventListener("click", () => step(-1));
  document.getElementById("next")!.addEventListener("click", () => step(1));
  document.getElementById("apply-left")!.addEventListener("click", () => applyNonConflicting("left"));
  document.getElementById("apply-all")!.addEventListener("click", () => applyNonConflicting("all"));
  document.getElementById("apply-right")!.addEventListener("click", () => applyNonConflicting("right"));
  document.getElementById("save")!.addEventListener("click", save);
  document.getElementById("toast-save")?.addEventListener("click", save);
}

function updateStatus(): void {
  const changeBlocks = blocks.filter((b) => b.isChange);
  const remaining = changeBlocks.filter((b) => !isResolved(b));
  const conflicts = remaining.filter((b) => b.type === "conflict").length;
  document.getElementById("status")!.textContent =
    `${remaining.length} change${remaining.length === 1 ? "" : "s"}. ${conflicts} conflict${conflicts === 1 ? "" : "s"}.`;

  // Green "all processed" toast once every change has been handled.
  const toast = document.getElementById("done-toast");
  if (toast) {
    const allDone = changeBlocks.length > 0 && remaining.length === 0;
    toast.classList.toggle("hidden", !allDone);
  }
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.data.type === "init") {
    setup(event.data);
  }
});

vscode.postMessage({ type: "ready" });
