import type { TuiThemePreferenceStore } from "../config/config-file.js"
import { THEME_IDS, type ThemeId } from "../ui/tui/text/index.js"

/** Result of one theme persistence attempt against the config store. */
export type ThemeCommitResult =
  | { readonly kind: "confirmed" }
  | { readonly kind: "failed-before-replace"; readonly error: unknown }
  | { readonly kind: "uncertain-after-replace"; readonly error: unknown }

export type ThemeOperationResult = ThemeCommitResult | { readonly kind: "stale" }

/** The theme transaction the theme card drives through the host. */
export interface TuiThemePort {
  preview(themeId: string): void
  commit(themeId: string): Promise<ThemeOperationResult>
  cancel(): void
  pending(): boolean
}

export interface TuiThemeCoordinatorOptions {
  readonly initialTheme: ThemeId
  readonly configPath: string | undefined
  readonly store: TuiThemePreferenceStore | undefined
  /** Composition root swaps the live frame's theme at this seam. */
  readonly onThemeChange: (theme: ThemeId) => void
}

export interface TuiThemeCoordinator {
  readonly port: TuiThemePort
  openScope(): void
  activeTheme(): ThemeId
  committedTheme(): ThemeId
  pending(): boolean
}

/**
 * Owns the TUI-local theme transaction. The theme card only sees the
 * narrow port; config persistence and the live frame swap meet here in
 * the composition layer, so neither side leaks into the interaction
 * modules.
 */
export function createTuiThemeCoordinator(options: TuiThemeCoordinatorOptions): TuiThemeCoordinator {
  let active = options.initialTheme
  let committed = options.initialTheme
  let operationGeneration = 0
  let scopeGeneration = 0
  let scopeOpen = false
  let pending = false

  const isThemeId = (value: string): value is ThemeId => (THEME_IDS as readonly string[]).includes(value)
  const applyTheme = (theme: ThemeId): void => {
    if (active === theme) return
    active = theme
    options.onThemeChange(theme)
  }

  const port: TuiThemePort = {
    preview(themeId) {
      if (pending || !isThemeId(themeId)) return
      applyTheme(themeId)
    },
    async commit(themeId): Promise<ThemeOperationResult> {
      if (pending) return { kind: "stale" }
      if (!isThemeId(themeId)) {
        return { kind: "failed-before-replace", error: new Error(`Unsupported TUI theme: ${themeId}`) }
      }
      const generation = ++operationGeneration
      const scope = scopeOpen ? scopeGeneration : null
      pending = true
      let result: Awaited<ReturnType<TuiThemePreferenceStore["commit"]>>
      if (options.store === undefined || options.configPath === undefined) {
        result = { kind: "failed-before-replace", error: new Error("No writable JSONC config path is available") }
      } else {
        try {
          result = await options.store.commit(options.configPath, themeId)
        } catch (error) {
          result = { kind: "failed-before-replace", error }
        }
      }
      if (generation !== operationGeneration || (scope !== null && (!scopeOpen || scope !== scopeGeneration))) return { kind: "stale" }
      pending = false
      if (result.kind === "confirmed") {
        committed = themeId
        applyTheme(themeId)
        if (scope !== null) scopeOpen = false
        return result
      }
      return result
    },
    cancel() {
      operationGeneration += 1
      scopeGeneration += 1
      scopeOpen = false
      pending = false
      applyTheme(committed)
    },
    pending: () => pending,
  }

  return {
    port,
    openScope() {
      operationGeneration += 1
      scopeGeneration += 1
      scopeOpen = true
      pending = false
      applyTheme(committed)
    },
    activeTheme: () => active,
    committedTheme: () => committed,
    pending: () => pending,
  }
}
