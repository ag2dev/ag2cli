import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { SessionId } from "@ag2cli/core/ids.js"
import { parseNotesFile } from "@ag2cli/runtime/application/context/session-notes.js"
import type { SessionNotesStore, StoredSessionNotes } from "@ag2cli/runtime/ports/session-notes-store.js"
import { replaceFileAtomically, withFileLock } from "./file-coordination.js"

const NOTES_LOCK_OPTIONS = {
  timeoutError: (path: string, cause: unknown) => new Error(`Timed out waiting for the session notes lock: ${path}`, { cause }),
} as const

/**
 * Encoded names stay well under filesystem name limits with room for the
 * lock and temp suffixes the write path adds beside the file.
 */
const MAX_ENCODED_NAME_BYTES = 180

export function sessionNotesPath(eventsRoot: string, id: SessionId): string {
  return join(eventsRoot, "notes", `${encodeURIComponent(id)}.md`)
}

/**
 * Pure containment arithmetic: percent-encoding never emits a path
 * separator, so a storable name is one bounded-length single segment and
 * the resolved target always stays inside the notes directory.
 */
function nameStorable(id: SessionId): boolean {
  const encoded = encodeURIComponent(id)
  return encoded.length > 0 && encoded.length <= MAX_ENCODED_NAME_BYTES && !encoded.includes("/")
}

/** Markdown side-car persistence for session notes under the event root. */
export class FileSessionNotesStore implements SessionNotesStore {
  constructor(private readonly eventsRoot: string) {}

  isAvailable(id: SessionId): boolean {
    return nameStorable(id)
  }

  async read(id: SessionId): Promise<StoredSessionNotes | undefined> {
    if (!nameStorable(id)) return undefined
    let content: string
    try {
      content = await readFile(sessionNotesPath(this.eventsRoot, id), "utf8")
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    // Raw bytes survive: the refresh module owns frontmatter parsing and
    // body validation, including the corrupt-file recovery paths.
    return { content, coveredUpTo: parseNotesFile(content)?.coveredUpTo ?? "" }
  }

  async replace(id: SessionId, content: string, expected: { readonly coveredUpTo: string }): Promise<boolean> {
    if (!nameStorable(id)) return false
    await mkdir(join(this.eventsRoot, "notes"), { recursive: true, mode: 0o700 })
    const target = sessionNotesPath(this.eventsRoot, id)
    return withFileLock(
      `${target}.lock`,
      async () => {
        const onDisk = await this.read(id)
        // A missing or unparseable frontmatter cursor compares equal to the
        // empty string, so the creation write also heals a corrupt file.
        if ((onDisk?.coveredUpTo ?? "") !== expected.coveredUpTo) return false
        await replaceFileAtomically(target, content)
        return true
      },
      NOTES_LOCK_OPTIONS,
    )
  }

  async delete(id: SessionId): Promise<void> {
    if (!nameStorable(id)) return
    await rm(sessionNotesPath(this.eventsRoot, id), { force: true })
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
