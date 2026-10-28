/**
 * Theme system for the Ink text kernel: six static color palettes and flat
 * role bindings resolve once into renderer-neutral style attributes. Theme
 * ids match the product configuration vocabulary (including the two
 * daltonized and two 16-color ansi variants). Match, focus, and selected carry a non-color cue
 * in every theme so state survives color-vision deficiency and monochrome
 * terminals. Quoted is deliberately color-only: it is decorative grouping,
 * and the entry marker remains the identity cue. Attributes stay
 * renderer-neutral; ink.ts is the only place that turns them into Ink
 * style props.
 */

/** Terminal theme identity; matches config SUPPORTED_THEMES. */
export type ThemeId = "dark" | "light" | "dark-daltonized" | "light-daltonized" | "dark-ansi" | "light-ansi"

type RGB = readonly [number, number, number]
type ANSI16Index = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15

type RGBPaletteColor = { readonly kind: "rgb"; readonly value: RGB }
type ANSI16PaletteColor = { readonly kind: "ansi16"; readonly value: ANSI16Index }
type PaletteColor = RGBPaletteColor | ANSI16PaletteColor

/** Style attributes the renderers can express after resolving one theme. */
export interface StyleAttributes {
  readonly foreground?: RGB
  readonly background?: RGB
  readonly ansiForeground?: ANSI16Index
  readonly ansiBackground?: ANSI16Index
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly reverse?: boolean
}

/**
 * Closed text token vocabulary (20 tokens, six themes); match, focus,
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
  | "diffRemoved"
  | "diffAdded"
  | "border"
  | "cursor"
  | "brand"
  | "title"
  | "suggestion"
  | "bashMode"
  | "inputSurface"

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
type PaletteSlot =
  | "text"
  | "inactive"
  | "accent"
  | "match"
  | "userMessageBackground"
  | "inputSurface"
  | "brand"
  | "permission"
  | "suggestion"
  | "bashBorder"
  | "error"
  | "warning"
  | "success"
  | "diffRemoved"
  | "diffAdded"
  | "border"

type Palette = Readonly<Record<PaletteSlot, RGBPaletteColor>> | Readonly<Record<PaletteSlot, ANSI16PaletteColor>>

interface RoleBinding {
  readonly foreground?: PaletteSlot
  readonly background?: PaletteSlot
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly reverse?: boolean
}

type RoleBindings = Readonly<Record<TextToken, RoleBinding>>

interface ThemeDefinition {
  readonly palette: Palette
  readonly roles: RoleBindings
}

const rgb = (red: number, green: number, blue: number): RGBPaletteColor => ({ kind: "rgb", value: [red, green, blue] })
const ansi16 = (value: ANSI16Index): ANSI16PaletteColor => ({ kind: "ansi16", value })

const rgbRoleBindings: RoleBindings = {
  text: { foreground: "text" },
  muted: { foreground: "inactive" },
  accent: { foreground: "accent" },
  match: { background: "match", underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { background: "userMessageBackground" },
  disabled: { foreground: "inactive", dim: true },
  error: { foreground: "error" },
  warning: { foreground: "warning" },
  success: { foreground: "success" },
  diffRemoved: { foreground: "text", background: "diffRemoved" },
  diffAdded: { foreground: "text", background: "diffAdded" },
  border: { foreground: "border" },
  cursor: { reverse: true },
  brand: { foreground: "brand" },
  title: { foreground: "permission" },
  suggestion: { foreground: "suggestion" },
  bashMode: { foreground: "bashBorder" },
  inputSurface: { background: "inputSurface" },
}

const daltonizedRgbRoleBindings: RoleBindings = {
  text: { foreground: "text" },
  muted: { foreground: "inactive" },
  accent: { foreground: "accent" },
  match: { background: "match", underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { background: "userMessageBackground" },
  disabled: { foreground: "inactive", dim: true },
  error: { foreground: "error", underline: true },
  warning: { foreground: "warning" },
  success: { foreground: "success", bold: true },
  diffRemoved: { foreground: "text", background: "diffRemoved" },
  diffAdded: { foreground: "text", background: "diffAdded" },
  border: { foreground: "border" },
  cursor: { reverse: true },
  brand: { foreground: "brand" },
  title: { foreground: "permission" },
  suggestion: { foreground: "suggestion" },
  bashMode: { foreground: "bashBorder" },
  inputSurface: { background: "inputSurface" },
}

const ansiRoleBindings: RoleBindings = {
  text: { foreground: "text" },
  muted: { foreground: "inactive" },
  accent: { foreground: "accent" },
  match: { background: "match", underline: true },
  focus: { bold: true },
  selected: { reverse: true },
  quoted: { background: "userMessageBackground" },
  disabled: { foreground: "inactive", dim: true },
  error: { foreground: "error" },
  warning: { foreground: "warning" },
  success: { foreground: "success" },
  diffRemoved: { foreground: "diffRemoved" },
  diffAdded: { foreground: "diffAdded" },
  border: { foreground: "border" },
  cursor: { reverse: true },
  brand: { foreground: "brand" },
  title: { foreground: "permission" },
  suggestion: { foreground: "suggestion" },
  bashMode: { foreground: "bashBorder" },
  inputSurface: { background: "inputSurface" },
}

const themeDefinitions: Readonly<Record<ThemeId, ThemeDefinition>> = {
  dark: {
    palette: {
      text: rgb(255, 255, 255),
      inactive: rgb(153, 153, 153),
      accent: rgb(88, 156, 214),
      match: rgb(66, 66, 100),
      userMessageBackground: rgb(55, 55, 55),
      inputSurface: rgb(55, 55, 55),
      brand: rgb(255, 122, 26),
      permission: rgb(177, 185, 249),
      suggestion: rgb(177, 185, 249),
      bashBorder: rgb(253, 93, 177),
      error: rgb(255, 107, 128),
      warning: rgb(255, 193, 7),
      success: rgb(78, 186, 101),
      diffRemoved: rgb(122, 41, 54),
      diffAdded: rgb(34, 92, 43),
      border: rgb(86, 86, 86),
    },
    roles: rgbRoleBindings,
  },
  light: {
    palette: {
      text: rgb(0, 0, 0),
      inactive: rgb(102, 102, 102),
      accent: rgb(12, 92, 182),
      match: rgb(255, 236, 130),
      userMessageBackground: rgb(240, 240, 240),
      inputSurface: rgb(240, 240, 240),
      brand: rgb(209, 87, 0),
      permission: rgb(87, 105, 247),
      suggestion: rgb(87, 105, 247),
      bashBorder: rgb(255, 0, 135),
      error: rgb(171, 43, 63),
      warning: rgb(150, 108, 30),
      success: rgb(44, 122, 57),
      diffRemoved: rgb(255, 168, 180),
      diffAdded: rgb(105, 219, 124),
      border: rgb(170, 170, 170),
    },
    roles: rgbRoleBindings,
  },
  "dark-daltonized": {
    palette: {
      text: rgb(255, 255, 255),
      inactive: rgb(153, 153, 153),
      accent: rgb(0, 138, 196),
      match: rgb(70, 96, 140),
      userMessageBackground: rgb(55, 55, 55),
      inputSurface: rgb(55, 55, 55),
      brand: rgb(255, 150, 40),
      permission: rgb(153, 204, 255),
      suggestion: rgb(153, 204, 255),
      bashBorder: rgb(51, 153, 255),
      error: rgb(255, 102, 102),
      warning: rgb(255, 204, 0),
      success: rgb(51, 153, 255),
      diffRemoved: rgb(102, 0, 0),
      diffAdded: rgb(0, 68, 102),
      border: rgb(86, 86, 86),
    },
    roles: daltonizedRgbRoleBindings,
  },
  "light-daltonized": {
    palette: {
      text: rgb(0, 0, 0),
      inactive: rgb(102, 102, 102),
      accent: rgb(12, 106, 178),
      match: rgb(200, 226, 255),
      userMessageBackground: rgb(220, 220, 220),
      inputSurface: rgb(220, 220, 220),
      brand: rgb(200, 100, 0),
      permission: rgb(51, 102, 255),
      suggestion: rgb(51, 102, 255),
      bashBorder: rgb(0, 102, 204),
      error: rgb(204, 0, 0),
      warning: rgb(255, 153, 0),
      success: rgb(0, 102, 153),
      diffRemoved: rgb(255, 204, 204),
      diffAdded: rgb(153, 204, 255),
      border: rgb(170, 170, 170),
    },
    roles: daltonizedRgbRoleBindings,
  },
  "dark-ansi": {
    palette: {
      text: ansi16(15),
      inactive: ansi16(7),
      accent: ansi16(12),
      match: ansi16(4),
      userMessageBackground: ansi16(8),
      inputSurface: ansi16(8),
      brand: ansi16(9),
      permission: ansi16(12),
      suggestion: ansi16(12),
      bashBorder: ansi16(13),
      error: ansi16(9),
      warning: ansi16(11),
      success: ansi16(10),
      diffRemoved: ansi16(1),
      diffAdded: ansi16(2),
      border: ansi16(7),
    },
    roles: ansiRoleBindings,
  },
  "light-ansi": {
    palette: {
      text: ansi16(0),
      inactive: ansi16(8),
      accent: ansi16(12),
      match: ansi16(3),
      userMessageBackground: ansi16(7),
      inputSurface: ansi16(7),
      brand: ansi16(9),
      permission: ansi16(4),
      suggestion: ansi16(4),
      bashBorder: ansi16(5),
      error: ansi16(1),
      warning: ansi16(3),
      success: ansi16(2),
      diffRemoved: ansi16(1),
      diffAdded: ansi16(2),
      border: ansi16(8),
    },
    roles: ansiRoleBindings,
  },
}

function resolveColor(palette: Palette, slot: PaletteSlot, property: "foreground" | "background"): StyleAttributes {
  const color: PaletteColor = palette[slot]
  if (color.kind === "rgb") return property === "foreground" ? { foreground: color.value } : { background: color.value }
  return property === "foreground" ? { ansiForeground: color.value } : { ansiBackground: color.value }
}

function resolveTheme(definition: ThemeDefinition): TokenTable {
  const table: Partial<Record<TextToken, StyleAttributes>> = {}
  for (const [token, binding] of Object.entries(definition.roles) as [TextToken, RoleBinding][]) {
    table[token] = {
      ...(binding.foreground === undefined ? {} : resolveColor(definition.palette, binding.foreground, "foreground")),
      ...(binding.background === undefined ? {} : resolveColor(definition.palette, binding.background, "background")),
      ...(binding.bold === true ? { bold: true } : {}),
      ...(binding.dim === true ? { dim: true } : {}),
      ...(binding.italic === true ? { italic: true } : {}),
      ...(binding.underline === true ? { underline: true } : {}),
      ...(binding.reverse === true ? { reverse: true } : {}),
    }
  }
  return table as TokenTable
}

export const THEMES: Readonly<Record<ThemeId, TokenTable>> = {
  dark: resolveTheme(themeDefinitions.dark),
  light: resolveTheme(themeDefinitions.light),
  "dark-daltonized": resolveTheme(themeDefinitions["dark-daltonized"]),
  "light-daltonized": resolveTheme(themeDefinitions["light-daltonized"]),
  "dark-ansi": resolveTheme(themeDefinitions["dark-ansi"]),
  "light-ansi": resolveTheme(themeDefinitions["light-ansi"]),
}

/**
 * Attributes an overlay contributes when merged: everything except its own
 * foreground, so the base token's color survives the overlay (error red
 * stays red while focused).
 */
function overlayAttributes(style: StyleAttributes): StyleAttributes {
  const applied: {
    background?: RGB
    ansiBackground?: ANSI16Index
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
