/**
 * Theme system for the Ink text kernel: the closed six-theme table mapping
 * every semantic token to concrete style attributes. Theme ids match the
 * product configuration vocabulary (including the two daltonized and two
 * 16-color ansi variants). Match, focus, and selected carry a non-color cue
 * in every theme so state survives color-vision deficiency and monochrome
 * terminals. Quoted is deliberately color-only: it is decorative grouping,
 * and the entry marker remains the identity cue. Attributes stay
 * renderer-neutral; ink.ts is the only place that turns them into Ink
 * style props.
 */

/** Terminal theme identity; matches config SUPPORTED_THEMES. */
export type ThemeId = "dark" | "light" | "dark-daltonized" | "light-daltonized" | "dark-ansi" | "light-ansi"

/**
 * Style attributes the kernel can express. Truecolor themes use RGB
 * components; ansi themes use 16-color palette indices (0-15). Color is
 * never the only cue for the state overlays; quoted is the decorative
 * exception.
 */
export interface StyleAttributes {
  readonly foreground?: readonly [number, number, number]
  readonly background?: readonly [number, number, number]
  readonly ansiForeground?: number
  readonly ansiBackground?: number
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly reverse?: boolean
}

/**
 * Closed text token vocabulary (13 tokens, six themes); match, focus,
 * selected, and quoted are orthogonal overlays combinable with any base
 * token.
 */
export type TextToken =
  | "text"
  | "muted"
  | "accent"
  | "match"
  | "focus"
  | "selected"
  | "quoted"
  | "disabled"
  | "error"
  | "warning"
  | "success"
  | "border"
  | "cursor"

/** Orthogonal style overlays; mergeable with any base token. */
export type TextOverlay = "match" | "focus" | "selected" | "quoted"

/** Styled text span within a rendered line. */
export interface TextRun {
  readonly text: string
  readonly token: TextToken
  readonly overlays?: readonly TextOverlay[]
}

/**
 * Value equality for one run row: the equality the state layer's
 * reference-reuse gates digest freshly minted rows with, so an
 * unchanged surface keeps its previous array reference.
 */
export function textRunsEqual(a: readonly TextRun[], b: readonly TextRun[]): boolean {
  return (
    a.length === b.length &&
    a.every((run, index) => {
      const other = b[index]!
      if (run.text !== other.text || run.token !== other.token) return false
      const left = run.overlays ?? []
      const right = other.overlays ?? []
      return left.length === right.length && left.every((overlay, position) => overlay === right[position])
    })
  )
}

export const THEME_IDS: readonly ThemeId[] = ["dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"]

type TokenTable = Readonly<Record<TextToken, StyleAttributes>>

const darkTheme: TokenTable = {
  text: { foreground: [214, 214, 214] },
  muted: { foreground: [130, 130, 130] },
  accent: { foreground: [88, 156, 214] },
  match: { background: [66, 66, 100], underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { background: [55, 55, 55] },
  disabled: { foreground: [110, 110, 110], dim: true },
  error: { foreground: [214, 84, 84] },
  warning: { foreground: [198, 158, 64] },
  success: { foreground: [96, 178, 116] },
  border: { foreground: [86, 86, 86] },
  cursor: { reverse: true },
}

const lightTheme: TokenTable = {
  text: { foreground: [44, 44, 44] },
  muted: { foreground: [122, 122, 122] },
  accent: { foreground: [12, 92, 182] },
  match: { background: [255, 236, 130], underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { background: [240, 240, 240] },
  disabled: { foreground: [150, 150, 150], dim: true },
  error: { foreground: [178, 34, 34] },
  warning: { foreground: [148, 106, 16] },
  success: { foreground: [26, 118, 58] },
  border: { foreground: [170, 170, 170] },
  cursor: { reverse: true },
}

const darkDaltonizedTheme: TokenTable = {
  text: { foreground: [214, 214, 214] },
  muted: { foreground: [130, 130, 130] },
  accent: { foreground: [0, 138, 196] },
  match: { background: [70, 96, 140], underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { background: [55, 55, 55] },
  disabled: { foreground: [110, 110, 110], dim: true },
  error: { foreground: [0, 118, 196], underline: true },
  warning: { foreground: [190, 120, 240] },
  success: { foreground: [230, 160, 40], bold: true },
  border: { foreground: [86, 86, 86] },
  cursor: { reverse: true },
}

const lightDaltonizedTheme: TokenTable = {
  text: { foreground: [44, 44, 44] },
  muted: { foreground: [122, 122, 122] },
  accent: { foreground: [12, 106, 178] },
  match: { background: [200, 226, 255], underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { background: [220, 220, 220] },
  disabled: { foreground: [150, 150, 150], dim: true },
  error: { foreground: [10, 98, 178], underline: true },
  warning: { foreground: [130, 74, 190] },
  success: { foreground: [190, 118, 10], bold: true },
  border: { foreground: [170, 170, 170] },
  cursor: { reverse: true },
}

const darkAnsiTheme: TokenTable = {
  text: { ansiForeground: 7 },
  muted: { ansiForeground: 8 },
  accent: { ansiForeground: 12 },
  match: { ansiBackground: 4, underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { ansiBackground: 8 },
  disabled: { ansiForeground: 8, dim: true },
  error: { ansiForeground: 9 },
  warning: { ansiForeground: 3 },
  success: { ansiForeground: 10 },
  border: { ansiForeground: 8 },
  cursor: { reverse: true },
}

const lightAnsiTheme: TokenTable = {
  text: { ansiForeground: 0 },
  muted: { ansiForeground: 8 },
  accent: { ansiForeground: 12 },
  match: { ansiBackground: 3, underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { ansiBackground: 7 },
  disabled: { ansiForeground: 8, dim: true },
  error: { ansiForeground: 1 },
  warning: { ansiForeground: 3 },
  success: { ansiForeground: 2 },
  border: { ansiForeground: 8 },
  cursor: { reverse: true },
}

export const THEMES: Readonly<Record<ThemeId, TokenTable>> = {
  dark: darkTheme,
  light: lightTheme,
  "dark-daltonized": darkDaltonizedTheme,
  "light-daltonized": lightDaltonizedTheme,
  "dark-ansi": darkAnsiTheme,
  "light-ansi": lightAnsiTheme,
}

/**
 * Attributes an overlay contributes when merged: everything except its own
 * foreground, so the base token's color survives the overlay (error red
 * stays red while focused).
 */
function overlayAttributes(style: StyleAttributes): StyleAttributes {
  const applied: {
    background?: readonly [number, number, number]
    ansiBackground?: number
    bold?: boolean
    dim?: boolean
    italic?: boolean
    underline?: boolean
    reverse?: boolean
  } = {}
  if (style.background !== undefined) applied.background = style.background
  if (style.ansiBackground !== undefined) applied.ansiBackground = style.ansiBackground
  if (style.bold !== undefined) applied.bold = style.bold
  if (style.dim !== undefined) applied.dim = style.dim
  if (style.italic !== undefined) applied.italic = style.italic
  if (style.underline !== undefined) applied.underline = style.underline
  if (style.reverse !== undefined) applied.reverse = style.reverse
  return applied
}

/** Merge overlay styles over the base token; later overlays win per field. */
export function resolveStyle(token: TextToken, overlays: readonly TextOverlay[], theme: ThemeId): StyleAttributes {
  const table = THEMES[theme]
  let merged: StyleAttributes = table[token]
  for (const overlay of overlays) {
    merged = { ...merged, ...overlayAttributes(table[overlay]) }
  }
  return merged
}
