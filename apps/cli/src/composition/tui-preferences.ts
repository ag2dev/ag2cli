import type { TuiPreferenceStore } from "../config/config-file.js"
import { THEME_IDS, type ThemeId } from "../ui/tui/text/index.js"

/** Result of one preference persistence attempt against the config store. */
export type ThemeCommitResult =
  | { readonly kind: "confirmed" }
  | { readonly kind: "failed-before-replace"; readonly error: unknown }
  | { readonly kind: "uncertain-after-replace"; readonly error: unknown }

/** A superseded attempt tagged with its write truth: nothing reached disk, or the write may sit on disk. */
export type ThemeOperationResult = ThemeCommitResult | { readonly kind: "stale"; readonly written: boolean }

/** The theme transaction the theme card drives through the host. */
export interface TuiThemePort {
  preview(themeId: string): void
  commit(themeId: string): Promise<ThemeOperationResult>
  cancel(): void
  pending(): boolean
}

export interface TuiPreferencesCoordinatorOptions {
  readonly initialTheme: ThemeId
  readonly configPath: string | undefined
  readonly store: TuiPreferenceStore | undefined
  /** Composition root swaps the live frame's theme at this seam. */
  readonly onThemeChange: (theme: ThemeId) => void
}

export interface TuiPreferencesCoordinator {
  readonly port: TuiThemePort
  openScope(): void
  activeTheme(): ThemeId
  committedTheme(): ThemeId
  pending(): boolean
}

/**
 * Owns the TUI-local theme preference transaction. The theme card only
 * sees its narrow port; config persistence and the live frame
 * swap meet here in the composition layer, so neither side leaks into the
 * interaction modules.
 */
export function createTuiPreferencesCoordinator(options: TuiPreferencesCoordinatorOptions): TuiPreferencesCoordinator {
  let active = options.initialTheme
  let committed = options.initialTheme
  let themeGeneration = 0
  let scopeGeneration = 0
  let scopeOpen = false
  let pending = false

  const isThemeId = (value: string): value is ThemeId => (THEME_IDS as readonly string[]).includes(value)
  const applyTheme = (theme: ThemeId): void => {
    if (active === theme) return
    active = theme
    options.onThemeChange(theme)
  }

  /** The scope captured at commit time; null when no scope is open. */
  const scopeOf = (): number | null => (scopeOpen ? scopeGeneration : null)
  const superseded = (scope: number | null): boolean => scope !== null && (!scopeOpen || scope !== scopeGeneration)

  const runStore = async (edits: Parameters<TuiPreferenceStore["commit"]>[1]): Promise<ThemeCommitResult> => {
    if (options.store === undefined || options.configPath === undefined) {
      return { kind: "failed-before-replace", error: new Error("No writable JSONC config path is available") }
    }
    try {
      return await options.store.commit(options.configPath, edits)
    } catch (error) {
      return { kind: "failed-before-replace", error }
    }
  }

  const port: TuiThemePort = {
    preview(themeId) {
      if (pending || !isThemeId(themeId)) return
      applyTheme(themeId)
    },
    async commit(themeId): Promise<ThemeOperationResult> {
      if (pending) return { kind: "stale", written: false }
      if (!isThemeId(themeId)) {
        return { kind: "failed-before-replace", error: new Error(`Unsupported TUI theme: ${themeId}`) }
      }
      const generation = ++themeGeneration
      const scope = scopeOf()
      pending = true
      const result = await runStore({ theme: themeId })
      if (generation !== themeGeneration || superseded(scope)) return { kind: "stale", written: true }
      pending = false
      if (result.kind === "confirmed") {
        committed = themeId
        applyTheme(themeId)
        if (scope !== null) scopeOpen = false
      }
      return result
    },
    cancel() {
      themeGeneration += 1
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
      themeGeneration += 1
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
