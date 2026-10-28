/**
 * Footer status model and wrap letter: the telemetry the host mirrors
 * into the status line, the compact token/context formatters the
 * report commands share, the permission chip table, the segment
 * builders, and the wrap that lays one row of segments out as
 * terminal lines. Display-only mode mappings live here: mode ids and
 * their rotation order are canonical facts that stay outside the
 * TUI; these tables only format an id that already exists.
 * ⏸ = asks before acting (manual, plan); ⏵⏵ = passes automatically
 * (accept-edits, full-access).
 */
import { clipText, graphemes, textWidth } from "./measure.js"
import type { TextRun, TextToken } from "./theme.js"

/**
 * Structurally identical to the sessionprojection PendingRun; declared
 * locally because the text kernel is a fail-closed leaf that imports
 * no other TUI module.
 */
export interface FooterPendingRun {
  readonly runId: string
  readonly goal: string
}

/**
 * Host-mirrored footer telemetry; every field optional — an absent
 * field drops its segment, and a null mirror keeps the minimal pending
 * line.
 */
export interface FooterTelemetry {
  readonly providerName?: string
  readonly providerMatched?: boolean
  readonly modelName?: string
  readonly modelMatched?: boolean
  readonly contextTokens?: number
  readonly contextEstimated?: boolean
  readonly contextWindow?: number
  readonly sessionStatus?: string
  readonly permissionMode?: string
  readonly effort?: string
  /** Rightmost segment: transient hints and errors outrank the run line. */
  readonly details?: string
}

/** Compact token counts: digits under a thousand, then k/m with a decimal. */
export function formatFooterTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

/** Context usage as current/limit with a capped percentage; "~" marks estimates. */
export function formatFooterContext(current: number | undefined, limit: number | undefined, estimated = false): string {
  const currentText = current === undefined ? "--" : `${estimated ? "~" : ""}${formatFooterTokens(current)}`
  const limitText = limit === undefined ? "?" : formatFooterTokens(limit)
  const percentage =
    current !== undefined && limit !== undefined && limit > 0 ? ` (${Math.min(999, (current / limit) * 100).toFixed(1)}%)` : ""
  return `${currentText}/${limitText}${percentage}`
}

/** Normalize durable session states to the compact footer labels. */
export function formatSessionStatus(status: string): string {
  switch (status) {
    case "created":
    case "plan_ready":
      return "ready"
    case "planning":
    case "running":
      return "running"
    default:
      return status
  }
}

/** Status color ladder: faults outrank progress, progress outranks completion. */
export function footerStatusToken(status: string): TextToken {
  const normalized = status.toLowerCase()
  if (normalized.includes("error") || normalized.includes("fail") || normalized.includes("cancel")) return "error"
  if (normalized.includes("run") || normalized.includes("wait") || normalized.includes("progress")) return "accent"
  if (normalized.includes("complete") || normalized.includes("ready")) return "success"
  return "muted"
}

const FOOTER_PERMISSION_TOKENS: Readonly<Record<string, TextToken>> = {
  manual: "warning",
  plan: "warning",
  "accept-edits": "success",
  "full-access": "success",
  auto: "success",
}

const PERMISSION_MODE_CHIPS: Readonly<Record<string, string>> = {
  manual: "⏸ manual",
  "accept-edits": "⏵⏵ accept edits",
  plan: "⏸ plan",
  "full-access": "⏵⏵ full-access",
  auto: "⏵ auto",
}

const PERMISSION_MODE_PANELS: Readonly<Record<string, string>> = {
  manual: "manual — prompts on writes",
  "accept-edits": "accept edits — auto-applies edits",
  plan: "plan — read-only",
  "full-access": "full-access — approves everything without prompts",
  auto: "auto — a guardian reviews every ask",
}

/** Blast-radius token for a permission mode; unknown ids stay muted. */
export function footerPermissionToken(mode: string): TextToken {
  return FOOTER_PERMISSION_TOKENS[mode] ?? "muted"
}

/** Footer chip text (glyph + short label); empty drops the segment. */
export function permissionModeChip(mode: string): string {
  return PERMISSION_MODE_CHIPS[mode] ?? ""
}

/** Blast-radius long label for the permissions card; unknown ids show as-is. */
export function permissionModePanelLabel(mode: string): string {
  return PERMISSION_MODE_PANELS[mode] ?? mode
}

/** The pending-derived rightmost segment when the host reports no detail. */
export function footerPendingDetails(pending: readonly FooterPendingRun[]): string {
  const oldest = pending[0]
  return oldest === undefined ? "idle" : `${pending.length} in flight · ${oldest.goal}`
}

/** Inputs the segment builder merges: host telemetry plus view-owned facts. */
export interface FooterSegmentInput {
  readonly telemetry: FooterTelemetry
  readonly pending: readonly FooterPendingRun[]
}

/**
 * The minimal pending line the store mirrors while no telemetry holds.
 */
export function footerMinimalSegments(pending: readonly FooterPendingRun[]): readonly TextRun[] {
  return [{ text: footerPendingDetails(pending), token: "muted" }]
}

/** Build the footer segments in display order; empty texts drop. */
export function footerSegments({ telemetry, pending }: FooterSegmentInput): readonly TextRun[] {
  const chip = permissionModeChip(telemetry.permissionMode ?? "")
  const effortParts: string[] = []
  if (telemetry.effort !== undefined) effortParts.push(`effort ${telemetry.effort}`)
  const segments: TextRun[] = [
    ...(telemetry.providerName
      ? [{ text: telemetry.providerName, token: telemetry.providerMatched === true ? ("success" as const) : ("accent" as const) }]
      : []),
    {
      text: telemetry.modelName ?? "model unknown",
      token: telemetry.modelMatched === true ? "success" : "accent",
      overlays: ["focus" as const],
    },
    {
      text: `context ${formatFooterContext(telemetry.contextTokens, telemetry.contextWindow, telemetry.contextEstimated === true)}`,
      token: "text" as const,
    },
    ...(telemetry.sessionStatus === undefined
      ? []
      : [
          {
            // Durable session states normalize before both the label and
            // its color: "created" reads ready/success, not muted.
            text: formatSessionStatus(telemetry.sessionStatus),
            token: footerStatusToken(formatSessionStatus(telemetry.sessionStatus)),
          },
        ]),
    ...(chip !== "" ? [{ text: chip, token: footerPermissionToken(telemetry.permissionMode ?? "") }] : []),
    ...(effortParts.length > 0 ? [{ text: effortParts.join(" · "), token: "muted" as const }] : []),
    { text: telemetry.details ?? footerPendingDetails(pending), token: "muted" as const },
  ]
  return segments.filter((segment) => segment.text.trim().length > 0)
}

/**
 * Append the tool-details affordance to whichever segment row the
 * footer built — the minimal line or the telemetry segments. The flag
 * arrives per frame from a stateless probe of the current content, so
 * the segment disappears with the tool activity that earned it.
 */
export function appendToolDetailsHint(segments: readonly TextRun[], visible: boolean): readonly TextRun[] {
  return visible ? [...segments, { text: "ctrl+o tool details", token: "muted" }] : segments
}

const separator = (): TextRun => ({ text: " · ", token: "text" })

/** Keep actionable chrome and live state ahead of optional metadata on narrow terminals. */
export function prioritizeFooterSegments(segments: readonly TextRun[], width: number): readonly TextRun[] {
  const rowWidth = (parts: readonly TextRun[]): number =>
    parts.reduce((total, part) => total + textWidth(part.text), 0) + Math.max(0, parts.length - 1) * 3
  const priority = (run: TextRun): number => {
    if (run.text.includes("ctrl+o")) return 100
    if (["error", "warning", "success"].includes(run.token)) return 90
    if (run.text === "idle" || run.text.includes("in flight") || run.text.startsWith("pending")) return 80
    if (run.text.includes("manual") || run.text.includes("accept edits") || run.text.includes("full-access") || run.text.includes("plan"))
      return 75
    if (run.text === "model unknown" || run.text.startsWith("context ")) return 0
    if (run.token === "muted") return 20
    return 50
  }
  const compact = [...segments]
  while (compact.length > 1 && rowWidth(compact) > width) {
    let drop = 0
    for (let index = 1; index < compact.length; index += 1) {
      if (priority(compact[index]!) < priority(compact[drop]!)) drop = index
    }
    compact.splice(drop, 1)
  }
  return compact
}

/**
 * Lay one row of status segments out as terminal lines. Segments join
 * with " · " and never split across lines; an over-wide segment clips
 * to the width, and a lone segment always renders.
 */
export function wrapFooterSegments(segments: readonly TextRun[], width: number): readonly (readonly TextRun[])[] {
  if (width <= 0) return []
  const lines: TextRun[][] = []
  let current: TextRun[] = []
  let currentWidth = 0
  for (const segment of segments) {
    const text = segment.text.trim()
    if (text.length === 0) continue
    const clipped = clipText(text, width).text
    // An empty clip means one grapheme alone exceeds the width (a wide
    // glyph at width 1): keep the glyph so a lone segment still renders,
    // exactly like the wrapper's over-budget fallback.
    const run: TextRun = { ...segment, text: clipped.length === 0 ? graphemes(text)[0]! : clipped }
    const runWidth = textWidth(run.text)
    const candidateWidth = currentWidth === 0 ? runWidth : currentWidth + 3 + runWidth
    if (currentWidth > 0 && candidateWidth > width) {
      lines.push(current)
      current = [run]
      currentWidth = runWidth
    } else {
      if (currentWidth > 0) {
        current.push(separator())
        currentWidth += 3
      }
      current.push(run)
      currentWidth += runWidth
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}
