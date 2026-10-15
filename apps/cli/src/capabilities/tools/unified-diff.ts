/**
 * Whole-file unified diff generator (for display only).
 *
 * buildUnifiedDiff takes the complete old and new file contents and produces a structured patch:
 *  - Trim common prefixes and suffixes, then run a line-based Myers diff. If the edit distance exceeds the limit,
 *    fall back to one removed/added block while preserving absolute line numbers and deterministic output.
 *  - Group changes into hunks (3 context lines by default, following Git convention).
 *  - Count change clusters (sites, corresponding to the number of replacements by replace_all).
 * Preserve original line terminators (do not normalize CRLF); identical inputs always produce identical output.
 * renderUnifiedDiffText renders the structured patch as result text for the model.
 */
import type { PatchHunk, PatchLine, StructuredPatch } from "@ag2cli/core/tool-facts.js"

export interface BuildUnifiedDiffOptions {
  /** Number of context lines per hunk (defaults to 3). */
  readonly context?: number
}

/** Fallback threshold: use one removed/added block when the combined line count after trimming (an upper bound on D) exceeds this value; this bounds O(D²) trace space. */
const MAX_EDIT_DISTANCE = 2000

/** Split into lines while preserving line terminators; treat unterminated trailing content as the last line and empty text as an empty array. */
function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split(/(?<=\n)/u)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

type OpKind = "equal" | "removed" | "added"

interface DiffOp {
  readonly kind: OpKind
  readonly aIndex: number
  readonly bIndex: number
}

/** Greedy Myers diff with trace backtracking; call directly when a and b have no common prefix or suffix to trim. */
function myersOps(a: readonly string[], b: readonly string[]): readonly DiffOp[] {
  const n = a.length
  const m = b.length
  const offset = n + m
  const v = new Int32Array(2 * (n + m) + 1)
  // Store only the [-d, d] slice on each iteration to bound trace space to O(D²).
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= n + m; d++) {
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!
      else x = v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const w = trace[d]!
    // w is the slice of v over [-d, d]; diagonal k has local slice index d + k.
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && w[d + k - 1]! < w[d + k + 1]!)) prevK = k + 1
    else prevK = k - 1
    const prevX = w[d + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      ops.push({ kind: "equal", aIndex: x, bIndex: y })
    }
    if (x === prevX) {
      y -= 1
      ops.push({ kind: "added", aIndex: x, bIndex: y })
    } else {
      x -= 1
      ops.push({ kind: "removed", aIndex: x, bIndex: y })
    }
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    ops.push({ kind: "equal", aIndex: x, bIndex: y })
  }
  return ops.reverse()
}

/** One maximal contiguous change block (half-open interval); count sites and merge hunks by block. */
interface ChangeBlock {
  readonly aStart: number
  readonly aEnd: number
  readonly bStart: number
  readonly bEnd: number
}

/** Diff ops for complete files: trim common prefixes/suffixes and fall back to a single removed/added block above the limit. */
function diffOps(a: readonly string[], b: readonly string[]): readonly DiffOp[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd -= 1
    bEnd -= 1
  }
  const midA = a.slice(prefix, aEnd)
  const midB = b.slice(prefix, bEnd)
  const ops: DiffOp[] = []
  for (let index = 0; index < prefix; index++) ops.push({ kind: "equal", aIndex: index, bIndex: index })
  if (midA.length + midB.length > MAX_EDIT_DISTANCE) {
    // Fallback: use the same anchor convention as Myers (removed anchors to the first line on the b side; added to the last line on the a side).
    for (let index = 0; index < midA.length; index++) ops.push({ kind: "removed", aIndex: prefix + index, bIndex: prefix })
    for (let index = 0; index < midB.length; index++) ops.push({ kind: "added", aIndex: aEnd, bIndex: prefix + index })
  } else {
    ops.push(
      ...myersOps(midA, midB).map((op) => ({
        kind: op.kind,
        aIndex: op.aIndex + prefix,
        bIndex: op.bIndex + prefix,
      })),
    )
  }
  for (let index = aEnd; index < a.length; index++) ops.push({ kind: "equal", aIndex: index, bIndex: bEnd + (index - aEnd) })
  return ops
}

/** Extract maximal contiguous change blocks from ops; calculate block boundaries from op extrema so the result is robust to op order within a block. */
function changeBlocks(ops: readonly DiffOp[]): readonly ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  let current: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null
  for (const op of ops) {
    if (op.kind === "equal") {
      current = null
      continue
    }
    if (current === null) {
      current = { aStart: op.aIndex, aEnd: op.aIndex, bStart: op.bIndex, bEnd: op.bIndex }
      blocks.push(current)
    }
    current.aStart = Math.min(current.aStart, op.aIndex)
    current.aEnd = Math.max(current.aEnd, op.kind === "removed" ? op.aIndex + 1 : op.aIndex)
    current.bStart = Math.min(current.bStart, op.bIndex)
    current.bEnd = Math.max(current.bEnd, op.kind === "added" ? op.bIndex + 1 : op.bIndex)
  }
  return blocks
}

/** Maximum display patch size; truncate by hunk/line and set truncated when exceeded. */
export const MAX_PATCH_HUNKS = 20
export const MAX_PATCH_LINES = 400

/** Truncate a patch by hunk count and total line count; truncation occurs only at hunk boundaries or within the final hunk. */
export function capStructuredPatch(patch: StructuredPatch): StructuredPatch {
  const hunks: PatchHunk[] = []
  let budget = MAX_PATCH_LINES
  let truncated = patch.truncated === true
  for (const hunk of patch.hunks) {
    if (hunks.length >= MAX_PATCH_HUNKS || budget <= 0) {
      truncated = true
      break
    }
    if (hunk.lines.length <= budget) {
      hunks.push(hunk)
      budget -= hunk.lines.length
      continue
    }
    // If the line budget is insufficient, truncate the final hunk and recalculate counts from the remaining lines.
    const sliced = hunk.lines.slice(0, budget)
    hunks.push({
      ...hunk,
      lines: sliced,
      oldLines: sliced.filter((line) => line.kind !== "added").length,
      newLines: sliced.filter((line) => line.kind !== "removed").length,
    })
    truncated = true
    break
  }
  if (!truncated) return patch
  return { ...patch, hunks, truncated: true }
}

export function buildUnifiedDiff(oldText: string, newText: string, options: BuildUnifiedDiffOptions = {}): StructuredPatch {
  const context = Math.max(0, Math.trunc(options.context ?? 3))
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = diffOps(a, b)
  const blocks = changeBlocks(ops)
  let addedLines = 0
  let removedLines = 0
  for (const op of ops) {
    if (op.kind === "added") addedLines += 1
    else if (op.kind === "removed") removedLines += 1
  }
  if (blocks.length === 0) return { hunks: [], addedLines: 0, removedLines: 0, sites: 0 }

  // Merge adjacent blocks into one hunk when the gap is <= 2*context, matching Git/GNU diffutils:
  // split only when gap > 2*context.
  const groups: { first: ChangeBlock; last: ChangeBlock }[] = []
  for (const block of blocks) {
    const tail = groups.at(-1)
    if (tail !== undefined && block.aStart - tail.last.aEnd <= 2 * context) tail.last = block
    else groups.push({ first: block, last: block })
  }

  const opAt = new Set<number>()
  const addedAt = new Set<number>()
  for (const op of ops) {
    if (op.kind === "removed") opAt.add(op.aIndex)
    else if (op.kind === "added") addedAt.add(op.bIndex)
  }

  const hunks: PatchHunk[] = groups.map(({ first, last }) => {
    const aLo = Math.max(0, first.aStart - context)
    const aHi = Math.min(a.length, last.aEnd + context)
    const bLo = Math.max(0, first.bStart - (first.aStart - aLo))
    const bHi = Math.min(b.length, last.bEnd + (aHi - last.aEnd))
    const lines: PatchLine[] = []
    let aIndex = aLo
    let bIndex = bLo
    while (aIndex < aHi || bIndex < bHi) {
      const removed = opAt.has(aIndex)
      const added = addedAt.has(bIndex)
      if (removed) {
        lines.push({ kind: "removed", text: a[aIndex]! })
        aIndex += 1
        continue
      }
      if (added) {
        lines.push({ kind: "added", text: b[bIndex]! })
        bIndex += 1
        continue
      }
      lines.push({ kind: "context", text: a[aIndex]! })
      aIndex += 1
      bIndex += 1
    }
    const oldLines = lines.filter((line) => line.kind !== "added").length
    const newLines = lines.filter((line) => line.kind !== "removed").length
    return {
      oldStart: oldLines === 0 ? aLo : aLo + 1,
      newStart: newLines === 0 ? bLo : bLo + 1,
      oldLines,
      newLines,
      lines,
    }
  })

  return { hunks, addedLines, removedLines, sites: blocks.length }
}

/** Render line prefixes: context/removed/added map to " "/"-"/"+". */
const LINE_PREFIX: Record<PatchLine["kind"], string> = {
  context: " ",
  removed: "-",
  added: "+",
}

/**
 * Render a structured patch as unified diff text (the model-facing result for file_edit).
 *
 * Hunk headers always include counts (favor determinism over Git's convention of omitting a count of 1). Preserve
 * original line terminators and append \n to unterminated lines (preserve CRLF as \r\n) so rendered lines stay aligned
 * and do not run together. When truncated, append a truncation marker after all hunks. Return "" when there are no hunks. Pure and deterministic.
 */
export function renderUnifiedDiffText(patch: StructuredPatch): string {
  let out = ""
  for (const hunk of patch.hunks) {
    out += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`
    for (const line of hunk.lines) {
      out += `${LINE_PREFIX[line.kind]}${line.text}`
      if (!line.text.endsWith("\n")) out += "\n"
    }
  }
  if (patch.truncated === true) out += "…(diff truncated)\n"
  return out
}
