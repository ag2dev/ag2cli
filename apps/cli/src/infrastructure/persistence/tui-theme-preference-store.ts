import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  parseConfigFileText,
  updateTuiThemeConfigText,
  type ThemeCommitResult,
  type TuiThemePreferenceStore,
} from "../../config/config-file.js"
import { SUPPORTED_THEMES } from "../../config/theme.js"
import { AtomicReplaceUncertainError, replaceFileAtomically, withFileLock } from "./file-coordination.js"

export interface TuiThemePreferenceStoreOptions {
  /** Test seam for deterministic before/after-replace failures. */
  readonly replaceFile?: (path: string, content: string) => Promise<void>
  readonly readFile?: (path: string) => Promise<string>
}

/**
 * Infrastructure owner for the TUI-local JSONC preference transaction.
 * Config parsing/editing remains in the config module; this adapter owns
 * locking, directory creation and durable same-directory replacement.
 */
export function createTuiThemePreferenceStore(options: TuiThemePreferenceStoreOptions = {}): TuiThemePreferenceStore {
  const replace = options.replaceFile ?? ((path: string, content: string) => replaceFileAtomically(path, content, { mode: 0o600 }))
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"))

  return {
    async commit(path, themeId): Promise<ThemeCommitResult> {
      if (!(SUPPORTED_THEMES as readonly string[]).includes(themeId)) {
        return { kind: "failed-before-replace", error: new Error(`Unsupported TUI theme: ${themeId}`) }
      }

      const lockPath = `${path}.lock`
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        return await withFileLock(lockPath, async () => {
          let current: string
          try {
            current = await read(path)
          } catch (error) {
            if (!isMissingFile(error)) return { kind: "failed-before-replace", error }
            current = "{}\n"
          }

          let updated: string
          try {
            // Keep validation and edit calculation inside the lock so a
            // concurrent JSONC editor cannot be overwritten from a stale read.
            updated = updateTuiThemeConfigText(current, themeId, path)
          } catch (error) {
            return { kind: "failed-before-replace", error }
          }

          try {
            await replace(path, updated)
          } catch (error) {
            if (error instanceof AtomicReplaceUncertainError) return { kind: "uncertain-after-replace", error }
            return { kind: "failed-before-replace", error }
          }

          try {
            // Re-parse the replaced bytes before reporting confirmation. This
            // catches an adapter that claims success without writing the
            // requested value and keeps the confirmation contract honest.
            const written = parseConfigFileText(await read(path), path)
            if (written.tui?.theme !== themeId) {
              return {
                kind: "uncertain-after-replace",
                error: new Error(`TUI theme write verification mismatch: expected ${themeId}`),
              }
            }
            return { kind: "confirmed" }
          } catch (error) {
            // The replacement already returned successfully. A verification
            // failure therefore cannot truthfully be reported as a
            // before-replace failure, even if the target is currently
            // unreadable.
            return { kind: "uncertain-after-replace", error }
          }
        })
      } catch (error) {
        return { kind: "failed-before-replace", error }
      }
    },
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
