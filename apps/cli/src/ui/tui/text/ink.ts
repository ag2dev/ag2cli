/**
 * Token→Ink style bridge: the single point where theme attributes become
 * Ink <Text> props. The view never assembles ANSI or picks colors itself —
 * it spreads the props this bridge mints, and run text is sanitized here so
 * raw escape sequences from content can never ride an Ink frame to the
 * terminal. Truecolor attributes become rgb() strings; ansi palette
 * indices become the chalk color names Ink accepts (gray = bright black).
 */
import { sanitizeText } from "./sanitize.js"
import { resolveStyle, type TextOverlay, type TextRun, type TextToken, type ThemeId } from "./theme.js"

/** Props spread onto an Ink <Text>; keys are absent unless set. */
export interface InkTextStyle {
  readonly color?: string
  readonly backgroundColor?: string
  readonly bold?: boolean
  readonly dimColor?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly inverse?: boolean
}

/** One sanitized run plus its Ink style props. */
export interface InkRun {
  readonly text: string
  readonly style: InkTextStyle
}

/** Chalk/Ink color names for the 16-color palette indices 0-15. */
const ANSI_COLOR_NAMES: readonly string[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
]

function rgb(red: number, green: number, blue: number): string {
  return `rgb(${red}, ${green}, ${blue})`
}

/** Resolve a token (with overlays) to Ink style props under one theme. */
export function inkStyle(token: TextToken, overlays: readonly TextOverlay[] = [], theme: ThemeId): InkTextStyle {
  const style = resolveStyle(token, overlays, theme)
  const props: {
    color?: string
    backgroundColor?: string
    bold?: boolean
    dimColor?: boolean
    italic?: boolean
    underline?: boolean
    inverse?: boolean
  } = {}
  if (style.foreground !== undefined) props.color = rgb(...style.foreground)
  if (style.ansiForeground !== undefined) props.color = ANSI_COLOR_NAMES[style.ansiForeground]
  if (style.background !== undefined) props.backgroundColor = rgb(...style.background)
  if (style.ansiBackground !== undefined) props.backgroundColor = ANSI_COLOR_NAMES[style.ansiBackground]
  if (style.bold === true) props.bold = true
  if (style.dim === true) props.dimColor = true
  if (style.italic === true) props.italic = true
  if (style.underline === true) props.underline = true
  if (style.reverse === true) props.inverse = true
  return props
}

/** Sanitized run text plus its Ink style props; empty runs drop out. */
export function inkRun(run: TextRun, theme: ThemeId): InkRun | null {
  const text = sanitizeText(run.text)
  if (text.length === 0) return null
  return { text, style: inkStyle(run.token, run.overlays ?? [], theme) }
}
