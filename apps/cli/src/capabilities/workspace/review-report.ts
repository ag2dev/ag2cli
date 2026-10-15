import { randomUUID } from "node:crypto"
import { rename, unlink, writeFile } from "node:fs/promises"
import { WorkspacePolicy } from "../security/workspace.js"

/**
 * Atomically publish a completed review report in the workspace root.
 *
 * The report is deliberately outside the model's tool surface: a failed,
 * cancelled or partially written review must never replace an existing one.
 */
export async function writeReviewReport(workspaceRoot: string, content: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  const workspace = new WorkspacePolicy({ workspaceRoot })
  const target = await workspace.resolveWithin("review.md", "write")
  const temporary = await workspace.resolveWithin(`.review.md.${randomUUID()}.tmp`, "write")
  const published = content.endsWith("\n") ? content : `${content}\n`

  try {
    await writeFile(temporary, published, { encoding: "utf8", flag: "wx" })
    throwIfAborted(signal)
    await rename(temporary, target)
    return target
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("review report write cancelled", "AbortError")
}
