/**
 * Read-side regular-file enforcement: reads and searches only touch regular
 * files and directories. Named pipes, devices, sockets and final-segment
 * symlinks are rejected with the `outside_workspace` code.
 *
 * readRegularFileText keeps the file-descriptor lifecycle inside this module:
 * callers receive the content plus a stat snapshot that stays valid after the
 * descriptor is closed.
 */

import { open, readFile, stat } from "node:fs/promises"
import { constants } from "node:fs"
import type { Stats } from "node:fs"
import { byteLength, MAX_TEXT_FILE_BYTES } from "./resource-limits.js"

const OPEN_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW

/** Single source of the read-side non-regular-file rejection message. */
export function notRegularFileMessage(path: string): string {
  return `not a regular file (outside_workspace): ${path}`
}

export class NotRegularFileError extends Error {
  constructor(path: string) {
    super(notRegularFileMessage(path))
    this.name = "NotRegularFileError"
  }
}

/**
 * Read a regular file as utf-8 text.
 *
 * `resolvedPath` must already be fully resolved by the caller (workspace
 * resolveWithin result or realpath) — never a raw model-facing path. The open
 * does not follow a final-segment symlink, and non-blocking opens keep FIFOs
 * from hanging, so open failures on non-regular targets are classified before
 * any content is read. The size gate message is the tool's established literal.
 */
export async function readRegularFileText(resolvedPath: string): Promise<{ content: string; stat: Stats }> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // Open failures on non-regular targets — unix sockets (EOPNOTSUPP on
    // macOS, ENXIO on Linux) and final-segment symlinks (ELOOP) — are mapped
    // uniformly; the implementation deliberately does not branch on errno.
    handle = await open(resolvedPath, OPEN_REGULAR_FLAGS)
  } catch {
    throw new NotRegularFileError(resolvedPath)
  }
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new NotRegularFileError(resolvedPath)
    if (fileStat.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit; use a smaller file or split it first`)
    }
    const content = await readFile(handle, "utf8")
    if (byteLength(content) > MAX_TEXT_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit; use a smaller file or split it first`)
    }
    return { content, stat: fileStat }
  } finally {
    await handle.close()
  }
}

/**
 * Search roots (grep/glob) may be regular files or directories; anything else
 * is rejected. stat follows symlinks, so a symlink to a directory passes and
 * a symlink to a FIFO is rejected immediately — identical verdicts to the kind
 * checks this replaces.
 */
export async function assertSearchRootKind(rootPath: string): Promise<Stats> {
  const rootStat = await stat(rootPath)
  if (!rootStat.isFile() && !rootStat.isDirectory()) {
    throw new NotRegularFileError(rootPath)
  }
  return rootStat
}
