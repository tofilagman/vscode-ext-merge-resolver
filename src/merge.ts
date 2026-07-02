import { diffIndices } from "node-diff3";
import type { MergeBlock, MergeModel, ChangeType } from "./protocol";

/**
 * Split text into lines. A trailing newline yields a trailing empty element,
 * which round-trips back to the same text when joined with "\n" — so the same
 * splitter must be used on all three inputs and when reconstructing.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

interface Hunk {
  side: "a" | "b";
  /** base line range [start, end). */
  oStart: number;
  oEnd: number;
  /** side (ours/theirs) line range [start, end). */
  sStart: number;
  sEnd: number;
}

function hunksAgainstBase(
  base: string[],
  side: string[],
  tag: "a" | "b"
): Hunk[] {
  return diffIndices(base, side).map((d) => ({
    side: tag,
    oStart: d.buffer1[0],
    oEnd: d.buffer1[0] + d.buffer1[1],
    sStart: d.buffer2[0],
    sEnd: d.buffer2[0] + d.buffer2[1],
  }));
}

/**
 * Decompose the three versions into IntelliJ-style blocks. Unlike
 * diff3Merge (which auto-applies non-conflicting changes), this keeps *every*
 * difference from base as an unapplied "change" with its base range, so the
 * Result document starts as base and each change is applied on demand:
 *
 * - `left`  — only "ours" changed this base region (non-conflicting, green).
 * - `right` — only "theirs" changed this base region (non-conflicting, green).
 * - `both`  — both sides made the same change (non-conflicting, green).
 * - `conflict` — both sides changed the region differently (red).
 */
export function buildMergeModel(
  ours: string,
  base: string,
  theirs: string
): MergeModel {
  const O = splitLines(base);
  const A = splitLines(ours);
  const B = splitLines(theirs);

  const hunks: Hunk[] = [
    ...hunksAgainstBase(O, A, "a"),
    ...hunksAgainstBase(O, B, "b"),
  ].sort((x, y) => x.oStart - y.oStart || x.oEnd - y.oEnd);

  const blocks: MergeBlock[] = [];
  let changeCount = 0;
  let conflictCount = 0;
  let cursor = 0; // position in base

  const pushStable = (lines: string[]) => {
    if (lines.length === 0) {
      return;
    }
    blocks.push({
      type: "stable",
      ours: lines,
      base: lines,
      theirs: lines,
      oursStart: 0,
      theirsStart: 0,
    });
  };

  let i = 0;
  while (i < hunks.length) {
    let regionStart = hunks[i].oStart;
    let regionEnd = hunks[i].oEnd;
    const group: Hunk[] = [hunks[i]];
    i++;
    // Merge hunks whose base ranges overlap/touch into one region.
    while (i < hunks.length && hunks[i].oStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[i].oEnd);
      group.push(hunks[i]);
      i++;
    }

    // Emit unchanged base content preceding this region.
    if (regionStart > cursor) {
      pushStable(O.slice(cursor, regionStart));
    }

    const baseContent = O.slice(regionStart, regionEnd);
    const aH = group.filter((h) => h.side === "a");
    const bH = group.filter((h) => h.side === "b");

    let ourContent = baseContent;
    let oursStart = 0;
    if (aH.length) {
      oursStart = Math.min(...aH.map((h) => h.sStart));
      const oursEnd = Math.max(...aH.map((h) => h.sEnd));
      ourContent = A.slice(oursStart, oursEnd);
    }

    let theirContent = baseContent;
    let theirsStart = 0;
    if (bH.length) {
      theirsStart = Math.min(...bH.map((h) => h.sStart));
      const theirsEnd = Math.max(...bH.map((h) => h.sEnd));
      theirContent = B.slice(theirsStart, theirsEnd);
    }

    let type: ChangeType;
    if (aH.length && bH.length) {
      type = arraysEqual(ourContent, theirContent) ? "both" : "conflict";
    } else if (aH.length) {
      type = "left";
    } else {
      type = "right";
    }

    blocks.push({
      type,
      ours: ourContent,
      base: baseContent,
      theirs: theirContent,
      oursStart,
      theirsStart,
    });
    changeCount++;
    if (type === "conflict") {
      conflictCount++;
    }
    cursor = regionEnd;
  }

  // Trailing unchanged base content.
  if (cursor < O.length) {
    pushStable(O.slice(cursor));
  }

  return { blocks, changeCount, conflictCount };
}
