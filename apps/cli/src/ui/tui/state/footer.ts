/**
 * Footer status model: the telemetry the host mirrors into the status
 * line, the compact token/context formatters the report commands share,
 * the permission chip table, and the segment builders — what the footer
 * says, as text-kernel runs the view lays out through the wrap letter
 * the text kernel owns. Display-only mode mappings live here: mode ids
 * and their rotation order are canonical facts that stay outside the
 * TUI; these tables only format an id that already exists.
 * ⏸ = asks before acting (manual, plan); ⏵⏵ = passes automatically
 * (accept-edits, full-access).
 */
import type { PendingRun } from "../sessionprojection/index.js"
import type { TextRun, TextToken } from "../text/index.js"

/**
 * Host-mirrored footer telemetry; every field optional — an absent
 * field drops its segment, and a null mirror keeps the minimal pending
 * line.
 */
export interface FooterTelemetry {
  readonly providerName?: string
  readonly modelName?: string
  readonly contextTokens?: number
  readonly contextEstimated?: boolean
  readonly contextWindow?: number
  readonly sessionStatus?: string
  readonly permissionMode?: string
  readonly effort?: string
  /** Whether the vim mode marker joins the effort segment. */
  readonly vimMode?: boolean
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
export function footerPendingDetails(pending: readonly PendingRun[]): string {
  const oldest = pending[0]
  return oldest === undefined ? "idle" : `${pending.length} in flight · ${oldest.goal}`
}

/** Inputs the segment builder merges: host telemetry plus view-owned facts. */
export interface FooterSegmentInput {
  readonly telemetry: FooterTelemetry
  readonly editorMode: "insert" | "normal"
  readonly pending: readonly PendingRun[]
}

/**
 * The minimal pending line the store mirrors while no telemetry holds:
 * the run detail plus the vim marker, which the " · " join renders as
 * the legacy letter.
 */
export function footerMinimalSegments(pending: readonly PendingRun[], editorMode: "insert" | "normal"): readonly TextRun[] {
  return [
    { text: footerPendingDetails(pending), token: "muted" },
    { text: `vim -- ${editorMode === "normal" ? "NORMAL" : "INSERT"} --`, token: "disabled" },
  ]
}

/** Build the footer segments in display order; empty texts drop. */
export function footerSegments({ telemetry, editorMode, pending }: FooterSegmentInput): readonly TextRun[] {
  const chip = permissionModeChip(telemetry.permissionMode ?? "")
  const effortParts: string[] = []
  if (telemetry.effort !== undefined) effortParts.push(`effort ${telemetry.effort}`)
  if (telemetry.vimMode === true) effortParts.push(`vim -- ${editorMode === "normal" ? "NORMAL" : "INSERT"} --`)
  const segments: TextRun[] = [
    ...(telemetry.providerName ? [{ text: telemetry.providerName, token: "muted" as const }] : []),
    { text: telemetry.modelName ?? "model unknown", token: "accent" as const, overlays: ["focus" as const] },
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
