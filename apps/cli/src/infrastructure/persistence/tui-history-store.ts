/**
 * Prompt history for the TUI composer. The JSONL file is local,
 * best-effort state; failure to read or write it never blocks a session.
 */
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { OrderedLane } from "@ag2cli/runtime/concurrency/ordered-lane.js"

export interface TuiHistoryEntry {
  readonly id: string
  readonly text: string
  readonly submittedAt: string
}

export interface TuiHistoryStore {
  /** Load persisted entries newest-first. */
  load(): Promise<readonly TuiHistoryEntry[]>
  /** Current in-process entries, newest-first. */
  snapshot(): readonly TuiHistoryEntry[]
  /** Add an accepted prompt immediately to the snapshot and persist it best-effort. */
  add(value: string): Promise<void>
}

export function resolveTuiHistoryPath(applicationHome: string | undefined, home = process.env.HOME, cwd = process.cwd()): string {
  return join(applicationHome ?? join(home ?? cwd, ".ag2cli"), "history.jsonl")
}

function parseHistory(text: string): TuiHistoryEntry[] {
  const entries: TuiHistoryEntry[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value !== "object" || value === null) continue
      const candidate = value as Record<string, unknown>
      if (
        typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        typeof candidate.text === "string" &&
        typeof candidate.submittedAt === "string"
      ) {
        entries.push({ id: candidate.id, text: candidate.text, submittedAt: candidate.submittedAt })
      }
    } catch {
      // Invalid JSONL records are ignored; there is no older-format reader.
    }
  }
  return entries
}

export function createTuiHistoryStore(path: string, maxEntries = 200): TuiHistoryStore {
  const limit = Math.max(1, Math.floor(maxEntries))
  let entries: TuiHistoryEntry[] = []
  // Serialize reads and writes so a concurrent startup load cannot race an
  // accepted prompt, and trimming cannot reorder rapid submissions.
  const historyLane = new OrderedLane<string>()

  return {
    load() {
      return historyLane.run("history", async () => {
        try {
          const text = await readFile(path, "utf8")
          const persisted = parseHistory(text).slice(-limit).reverse()
          const persistedIds = new Set(persisted.map((entry) => entry.id))
          const notYetPersisted = entries.filter((entry) => !persistedIds.has(entry.id))
          entries = [...notYetPersisted, ...persisted].slice(0, limit)
        } catch {
          // Keep accepted prompts already admitted in this process.
        }
        return [...entries]
      })
    },
    snapshot() {
      return [...entries]
    },
    add(value) {
      if (value.trim().length === 0) return Promise.resolve()
      const entry: TuiHistoryEntry = { id: randomUUID(), text: value, submittedAt: new Date().toISOString() }
      entries = [entry, ...entries].slice(0, limit)
      return historyLane.run("history", async () => {
        try {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8")
          const persisted = parseHistory(await readFile(path, "utf8"))
          if (persisted.length > limit) {
            const kept = persisted.slice(-limit)
            await writeFile(path, `${kept.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8")
          }
        } catch {
          // Prompt history is best-effort and never blocks the interactive session.
        }
      })
    },
  }
}
