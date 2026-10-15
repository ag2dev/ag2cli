/**
 * Composer submission history: an append-only newline-escaped file under
 * the application home, capped at the last maxEntries submissions.
 * Persistence is best-effort by contract — a failing store must never
 * break an interactive session.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface TuiHistoryStore {
  load(): Promise<readonly string[]>
  add(value: string): Promise<void>
}

export function resolveTuiHistoryPath(applicationHome: string | undefined, home = process.env.HOME, cwd = process.cwd()): string {
  return join(applicationHome ?? join(home ?? cwd, ".ag2cli"), "history")
}

export function createTuiHistoryStore(path: string, maxEntries = 200): TuiHistoryStore {
  // `onHistory` is intentionally fire-and-forget at the application seam.
  // Serialize each append/read/trim cycle so rapid submissions cannot race
  // and lose or reorder entries.
  let writeTail: Promise<void> = Promise.resolve()
  return {
    async load() {
      try {
        const text = await readFile(path, "utf8")
        return text
          .split("\n")
          .map((line) => line.replaceAll("\\n", "\n").trimEnd())
          .filter((line) => line.length > 0)
          .slice(-maxEntries)
      } catch {
        return []
      }
    },
    add(value) {
      const normalized = value.trim()
      if (normalized.length === 0) return Promise.resolve()
      const task = writeTail.then(async () => {
        try {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(path, `${value.replaceAll("\n", "\\n")}\n`, "utf8")
          const entries = await readFile(path, "utf8")
          const lines = entries.split("\n").filter((line) => line.length > 0)
          if (lines.length <= maxEntries) return
          const kept = lines.slice(-maxEntries).join("\n") + "\n"
          await writeFile(path, kept, "utf8")
        } catch {
          // History is best-effort and must never break an interactive session.
        }
      })
      writeTail = task
      return task
    },
  }
}
