/**
 * ANSI serializer: the canonical runs-to-escape projection for anything
 * outside Ink that needs the theme table (test corpora, snapshots). Run
 * text passes the sanitize point before emission; styles come
 * exclusively from the theme table. Every run transition resets first
 * so attributes never bleed between runs.
 */
import type { TextRun, ThemeId } from "./index.js"
import { resolveStyle, type StyleAttributes } from "./theme.js"
import { sanitizeText } from "./sanitize.js"

const RESET = "\u001b[0m"

function ansiForegroundCode(index: number): number {
  return index < 8 ? 30 + index : 90 + index - 8
}

function ansiBackgroundCode(index: number): number {
  return index < 8 ? 40 + index : 100 + index - 8
}

function sgrParams(style: StyleAttributes): readonly string[] {
  const params: string[] = []
  if (style.bold === true) params.push("1")
  if (style.dim === true) params.push("2")
  if (style.italic === true) params.push("3")
  if (style.underline === true) params.push("4")
  if (style.reverse === true) params.push("7")
  if (style.foreground !== undefined) params.push(`38;2;${style.foreground[0]};${style.foreground[1]};${style.foreground[2]}`)
  if (style.background !== undefined) params.push(`48;2;${style.background[0]};${style.background[1]};${style.background[2]}`)
  if (style.ansiForeground !== undefined) params.push(`${ansiForegroundCode(style.ansiForeground)}`)
  if (style.ansiBackground !== undefined) params.push(`${ansiBackgroundCode(style.ansiBackground)}`)
  return params
}

/** Serialize styled runs into one ANSI string; runs never inherit styles. */
export function serializeRuns(runs: readonly TextRun[], theme: ThemeId): string {
  let out = ""
  let active = false
  for (const run of runs) {
    const text = sanitizeText(run.text)
    if (text.length === 0) continue
    const params = sgrParams(resolveStyle(run.token, run.overlays ?? [], theme))
    if (params.length === 0) {
      if (active) out += RESET
      active = false
      out += text
      continue
    }
    if (active) out += RESET
    out += `\u001b[${params.join(";")}m${text}`
    active = true
  }
  if (active) out += RESET
  return out
}
