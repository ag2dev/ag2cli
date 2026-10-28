/**
 * Memory retrieval ranks candidate memories against the current query. The
 * scoring implementation is isolated so it can be replaced independently.
 */

import type { Memory } from "./types.js"

export interface MemorySelectorInput {
  readonly query: string
  readonly memories: readonly Memory[]
  readonly limit: number
  readonly signal?: AbortSignal
}

/** Optional semantic selector boundary; the default remains deterministic and local. */
export type MemorySelector = (input: MemorySelectorInput) => Promise<readonly Memory[]> | readonly Memory[]

/** Small bilingual stop-word list. */
const STOP_WORDS = new Set([
  "\u7684",
  "\u662f",
  "\u5728",
  "\u4e86",
  "\u548c",
  "\u4e0e",
  "a",
  "an",
  "the",
  "is",
  "are",
  "to",
  "of",
  "and",
  "in",
  "on",
  "for",
])

/** Tokenize English words and individual CJK characters. Shared by memory retrieval and session history search. */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  // English words.
  const enWords = lower.match(/[a-z][a-z0-9_-]{1,}/g) ?? []
  // Split each CJK run into individual characters.
  const cjkSegments = lower.match(/[\u4e00-\u9fa5]+/g) ?? []
  const cjkCharacters = cjkSegments.flatMap((segment) => [...segment])
  return [...enWords, ...cjkCharacters]
    .filter((token) => token.length > 1 || /[\u4e00-\u9fa5]/.test(token))
    .filter((token) => !STOP_WORDS.has(token))
}

/** Score one memory against the query tokens. */
function scoreMemory(mem: Memory, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0
  const desc = mem.description.toLowerCase()
  const name = mem.name.toLowerCase()
  let score = 0
  for (const token of queryTokens) {
    // Persisted memories are selected from their manifest, matching
    // OpenClaude's bounded header scan; their body is loaded only after
    // selection. In-memory records without a path retain body matching for
    // callers that provide already-loaded records directly.
    if (desc.includes(token)) score += 3
    if (name.includes(token)) score += 2
    if (mem.path === undefined && mem.body.toLowerCase().includes(token)) score += 1
  }
  return score
}

/** Return matching memories in descending relevance order. */
export function findRelevantMemories(query: string, memories: ReadonlyArray<Memory>, limit = 5): Memory[] {
  const tokens = tokenize(query)
  return memories
    .map((m) => ({ m, score: scoreMemory(m, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m)
}

/**
 * Select the prompt memory set. `alwaysLoad` entries are included even when
 * the current goal has no lexical hit; bounded relevance entries are then
 * appended without duplicates. The selector is intentionally deterministic
 * so a future embedding/model selector can replace this function at the
 * adapter boundary without changing Memory storage or prompt contracts.
 */
export function selectMemories(query: string, memories: ReadonlyArray<Memory>, limit = 5): Memory[] {
  const always = memories.filter((memory) => memory.alwaysLoad === true)
  const selected = new Map(always.map((memory) => [memory.name.toLowerCase(), memory]))
  for (const memory of findRelevantMemories(query, memories, limit)) {
    if (!selected.has(memory.name.toLowerCase())) selected.set(memory.name.toLowerCase(), memory)
  }
  return [...selected.values()]
}
