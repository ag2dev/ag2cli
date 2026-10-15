/**
 * Memory storage layer.
 *
 * Each memory uses one Markdown file, allowing it to persist and be scanned across sessions.
 * Each file has YAML frontmatter followed by a body.
 *
 *   ---
 *   name: short-slug
 *   description: one-line summary
 *   type: user | feedback | project | reference
 *   ---
 *   <body: the fact itself>
 *
 * Four memory types:
 *  - user: who the user is (role, expertise, preferences)
 *  - feedback: user guidance on how work should be done (corrections and confirmations)
 *  - project: ongoing work, goals, and constraints that cannot be inferred from code
 *  - reference: pointers to external resources (URL/dashboard/ticket)
 *
 * This module handles storage, scanning, and parsing; retrieval and system-prompt injection are composed by the layer above.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  byteLength,
  MAX_LOADED_MEMORIES,
  MAX_MEMORY_BODY_CHARS,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_HEADER_BYTES,
} from "../security/resource-limits.js"
import type { Memory, MemoryRoot, MemoryScope, MemoryType } from "@ag2cli/runtime/application/memory/types.js"

export type { Memory, MemoryRoot, MemoryScope, MemoryType } from "@ag2cli/runtime/application/memory/types.js"

/** Memory type. */
/** Memory source tier; the tier is not a semantic memory type. */

export const MEMORY_TYPES: ReadonlyArray<MemoryType> = ["user", "feedback", "project", "reference"]

const MAX_MEMORY_SCAN_DEPTH = 3

/** Error for invalid frontmatter or a frontmatter parsing failure. */
export class MemoryParseError extends Error {
  constructor(
    public readonly fileName: string,
    message: string,
  ) {
    super(`${fileName}: ${message}`)
    this.name = "MemoryParseError"
  }
}

/**
 * Parse one memory file's text into a Memory.
 * The file name without `.md` becomes the name. Throws MemoryParseError for invalid formats.
 */
export function parseMemoryFile(fileName: string, content: string): Memory {
  const name = fileName.replace(/\.md$/i, "")
  // Must start with ---.
  if (!content.startsWith("---")) {
    if (name.toLowerCase() === "memory") {
      const body = content.trim()
      if (body.length > MAX_MEMORY_BODY_CHARS) {
        throw new MemoryParseError(fileName, `Body exceeds the ${MAX_MEMORY_BODY_CHARS}-character limit`)
      }
      return {
        name: "MEMORY",
        description: "Long-term project context for the root directory",
        type: "project",
        body,
        alwaysLoad: true,
      }
    }
    throw new MemoryParseError(fileName, "Missing opening frontmatter delimiter ---")
  }
  // Find the second --- (the end of the frontmatter).
  const endIdx = content.indexOf("---", 3)
  if (endIdx === -1) {
    throw new MemoryParseError(fileName, "Missing closing frontmatter delimiter ---")
  }
  const header = content.slice(3, endIdx)
  const body = content.slice(endIdx + 3).trim()
  if (body.length > MAX_MEMORY_BODY_CHARS) {
    throw new MemoryParseError(fileName, `Body exceeds the ${MAX_MEMORY_BODY_CHARS}-character limit`)
  }

  // Minimal YAML: one key: value pair per line; values are not unquoted.
  const fields: Record<string, string> = {}
  for (const line of header.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!m) continue
    fields[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "")
  }

  if (!fields.description) throw new MemoryParseError(fileName, "Missing description field")
  const type = fields.type as MemoryType
  if (!MEMORY_TYPES.includes(type)) {
    throw new MemoryParseError(fileName, `Invalid type: ${fields.type ?? "(missing)"}`)
  }
  const scope = fields.scope === undefined ? undefined : parseMemoryScope(fields.scope, fileName)
  const alwaysLoad = fields.alwaysLoad === undefined ? name.toLowerCase() === "memory" : parseBoolean(fields.alwaysLoad, fileName)
  return {
    name,
    description: fields.description,
    type,
    body,
    ...(scope === undefined ? {} : { scope }),
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  }
}

/** Serialize a Memory as file text (frontmatter + body). */
export function serializeMemory(mem: Memory): string {
  return [
    `---`,
    `name: ${mem.name}`,
    `description: ${mem.description}`,
    `type: ${mem.type}`,
    ...(mem.scope === undefined ? [] : [`scope: ${mem.scope}`]),
    ...(mem.alwaysLoad ? [`alwaysLoad: true`] : []),
    `---`,
    ``,
    mem.body,
  ].join("\n")
}

/** Write a memory to a directory (file name = name.md). Create the directory if it does not exist. */
export function writeMemory(dir: string, mem: Memory): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, `${mem.name}.md`)
  writeFileSync(path, serializeMemory(mem), "utf-8")
  return path
}

/**
 * Scan and parse all .md memories in a directory.
 * If parsing one file fails, skip it and continue when skipBad=true (the default); otherwise throw.
 * Return an empty array when the directory does not exist or contains no .md files.
 */
export function scanMemories(dir: string, opts: { skipBad?: boolean; scope?: MemoryScope } = {}): Memory[] {
  const skipBad = opts.skipBad ?? true
  if (!existsSync(dir)) return []
  const files = collectMemoryFiles(dir)
  const primary = files.find((file) => file.toLowerCase() === "memory.md")
  const selected = [...(primary ? [primary] : []), ...files.filter((file) => file !== primary)].slice(0, MAX_LOADED_MEMORIES)
  const out: Memory[] = []
  for (const fileName of selected) {
    try {
      const path = join(dir, fileName)
      if (statSync(path).size > MAX_MEMORY_FILE_BYTES)
        throw new MemoryParseError(fileName, `File exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
      const content = fileName.toLowerCase() === "memory.md" ? readMemoryFile(path, fileName) : readMemoryHeader(path, fileName)
      const memory =
        fileName.toLowerCase() === "memory.md" ? parseMemoryFile(fileName, content) : createLazyMemory(fileName, path, opts.scope, content)
      if (fileName.toLowerCase() === "memory.md") {
        out.push({
          ...memory,
          path,
          ...(opts.scope === undefined ? {} : { scope: opts.scope }),
        })
      } else {
        out.push(memory)
      }
    } catch (err) {
      if (!skipBad) throw err
      // One malformed file should not prevent other memories from loading.
    }
  }
  return out
}

function collectMemoryFiles(dir: string): string[] {
  const files: string[] = []
  const pending = [{ absolutePath: dir, relativePath: "", depth: 0 }]
  while (pending.length > 0) {
    const current = pending.pop()!
    let entries
    try {
      entries = readdirSync(current.absolutePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = current.relativePath ? join(current.relativePath, entry.name) : entry.name
      const absolutePath = join(dir, relativePath)
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith(".md") && !(current.relativePath && entry.name.toLowerCase() === "memory.md")) files.push(relativePath)
        continue
      }
      if (entry.isDirectory()) {
        if (current.depth < MAX_MEMORY_SCAN_DEPTH) pending.push({ absolutePath, relativePath, depth: current.depth + 1 })
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".md") && !(current.relativePath && entry.name.toLowerCase() === "memory.md")) {
        files.push(relativePath)
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function readMemoryFile(path: string, fileName: string): string {
  const content = readFileSync(path, "utf-8")
  if (byteLength(content) > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryParseError(fileName, `File exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
  }
  return content
}

function readMemoryHeader(path: string, fileName: string): string {
  const descriptor = statSync(path)
  if (descriptor.size > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryParseError(fileName, `File exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
  }
  const size = Math.min(descriptor.size, MAX_MEMORY_HEADER_BYTES)
  const buffer = Buffer.alloc(size)
  const fd = openSync(path, "r")
  try {
    const bytes = readSync(fd, buffer, 0, size, 0)
    const content = buffer.subarray(0, bytes).toString("utf-8")
    const end = content.indexOf("---", 3)
    return end === -1 ? content : `${content.slice(0, end + 3)}\n`
  } finally {
    closeSync(fd)
  }
}

function createLazyMemory(fileName: string, path: string, scope: MemoryScope | undefined, header: string): Memory {
  const metadata = parseMemoryFile(fileName, header)
  let loaded: Memory | undefined
  return {
    name: metadata.name,
    description: metadata.description,
    type: metadata.type,
    ...(scope === undefined ? (metadata.scope === undefined ? {} : { scope: metadata.scope }) : { scope }),
    ...(metadata.alwaysLoad ? { alwaysLoad: true } : {}),
    path,
    get body(): string {
      if (loaded === undefined) loaded = parseMemoryFile(fileName, readMemoryFile(path, fileName))
      return loaded.body
    },
  }
}

/**
 * Load layered memory roots. Later roots have higher precedence for a
 * duplicate name; callers should pass them from low to high precedence.
 */
export function scanMemoryRoots(roots: readonly MemoryRoot[], opts: { skipBad?: boolean } = {}): Memory[] {
  const loaded: Memory[] = []
  for (const root of roots) {
    loaded.push(...scanMemories(root.root, { ...opts, scope: root.scope }))
  }
  return consolidateMemories(loaded)
}

/** Consolidate layered records by name; the last/higher-precedence record wins. */
export function consolidateMemories(memories: readonly Memory[]): Memory[] {
  const merged = new Map<string, Memory>()
  for (const memory of memories) {
    const key = memory.name.toLowerCase()
    const current = merged.get(key)
    if (current === undefined || scopeRank(memory.scope) >= scopeRank(current.scope)) {
      merged.set(key, memory)
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function parseMemoryScope(value: string, fileName: string): MemoryScope {
  if (value === "user" || value === "team" || value === "project") return value
  throw new MemoryParseError(fileName, `Invalid scope: ${value}`)
}

function parseBoolean(value: string, fileName: string): boolean {
  if (value === "true") return true
  if (value === "false") return false
  throw new MemoryParseError(fileName, `Invalid alwaysLoad: ${value}`)
}

function scopeRank(scope: MemoryScope | undefined): number {
  if (scope === "project") return 3
  if (scope === "team") return 2
  if (scope === "user") return 1
  return 0
}
