/**
 * Fuzzy candidate matching for the completion pickers, calibrated against
 * fzf's scoring constants (higher score is the better match; results sort
 * by descending rank, ties keep input order). Greedy forward matching over
 * extended graphemes with boundary, camel, and consecutive bonuses; the
 * grapheme segmentation itself is the text kernel's.
 */
import { graphemes } from "../text/index.js"

/** Weighted match field; weights are frozen per profile. */
export type CompletionField = "basename" | "path" | "directory" | "description" | "command" | "alias"

export type CompletionItemKind = "command" | "file" | "agent" | "memory" | "session" | "theme" | "history"

/** Candidate item supplied by a host-injected completion source. */
export interface CompletionItem {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly kind: CompletionItemKind
  readonly fields?: Readonly<Partial<Record<CompletionField, string>>>
}

/** One field's match; ranges are grapheme indices within that field's text. */
export interface FieldMatch {
  readonly field: CompletionField
  readonly matchedRanges: readonly { readonly start: number; readonly end: number }[]
}

/** Matcher output; higher rank wins, ties keep stable input order. */
export interface MatchResult {
  readonly item: CompletionItem
  readonly rank: number
  readonly fieldMatches: readonly FieldMatch[]
}

/** Field weighting for one picker family. */
export interface CompletionProfile {
  readonly name: "file" | "command"
  readonly fields: readonly { readonly field: CompletionField; readonly weight: number }[]
}

/** File pickers favor the basename; command pickers favor the command itself. */
export const FILE_PROFILE: CompletionProfile = {
  name: "file",
  fields: [
    { field: "basename", weight: 1 },
    { field: "path", weight: 0.7 },
    { field: "directory", weight: 0.4 },
    { field: "description", weight: 0.2 },
  ],
}

export const COMMAND_PROFILE: CompletionProfile = {
  name: "command",
  fields: [
    { field: "command", weight: 1 },
    { field: "alias", weight: 0.8 },
    { field: "description", weight: 0.3 },
  ],
}

const SCORE_MATCH = 16
const SCORE_GAP_START = -3
const SCORE_GAP_EXTENSION = -1
const BONUS_BOUNDARY = SCORE_MATCH / 2
const BONUS_CAMEL = SCORE_MATCH / 2 + SCORE_GAP_EXTENSION
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION)
const BONUS_FIRST_CHAR_MULTIPLIER = 2

const WORD_GRAPHEME = /\p{L}|\p{N}/u

interface FieldScore {
  readonly score: number
  readonly matchedRanges: readonly { readonly start: number; readonly end: number }[]
}

interface PreparedField {
  readonly clusters: readonly string[]
  readonly folded: readonly string[]
}

/** One cached preparation: the content it was minted against, plus the folded clusters per field. */
interface PreparedItem {
  readonly fingerprint: string
  readonly fields: Map<string, PreparedField>
}

/** Every field a profile can ask for, in one fixed fingerprint order. */
const FIELD_ORDER: readonly CompletionField[] = ["basename", "path", "directory", "description", "command", "alias"]

/**
 * Folded clusters per item id, cached against the content the item
 * carried: sources re-mint their corpus per query, so object identity
 * is no key — the id is the stable handle, and a fingerprint (label
 * plus every declared field) validates the hit so reused ids never
 * serve stale clusters. The cache is bounded: past the entry cap it
 * clears wholesale and the next query re-prepares.
 */
const PREPARED_CAP = 4096
const preparedItems = new Map<string, PreparedItem>()

/**
 * Canonical content encoding — every component length-framed, so no
 * label or field value can masquerade as another's (a label of
 * "xcommand y" and a label of "x" with command "y" encode differently;
 * field names are a fixed space-free enum).
 */
function itemFingerprint(item: CompletionItem): string {
  const parts: string[] = [`${item.label.length} ${item.label}`]
  const fields = item.fields
  if (fields !== undefined) {
    for (const field of FIELD_ORDER) {
      const value = fields[field]
      if (value !== undefined) parts.push(`${field} ${value.length} ${value}`)
    }
  }
  return parts.join(" ")
}

function preparedItem(item: CompletionItem): PreparedItem {
  const fingerprint = itemFingerprint(item)
  const cached = preparedItems.get(item.id)
  if (cached !== undefined && cached.fingerprint === fingerprint) return cached
  if (preparedItems.size >= PREPARED_CAP) preparedItems.clear()
  const entry: PreparedItem = { fingerprint, fields: new Map() }
  preparedItems.set(item.id, entry)
  return entry
}

function preparedField(entry: PreparedItem, field: string, value: string): PreparedField {
  const cached = entry.fields.get(field)
  if (cached !== undefined) return cached
  const clusters = graphemes(value)
  const folded = clusters.map((cluster) => cluster.toLowerCase())
  const prepared = { clusters, folded }
  entry.fields.set(field, prepared)
  return prepared
}

function isWord(cluster: string): boolean {
  return WORD_GRAPHEME.test(cluster)
}

function isCamelTransition(previous: string, current: string): boolean {
  const previousCode = previous.codePointAt(0) ?? 0
  const currentCode = current.codePointAt(0) ?? 0
  const previousLower = previousCode >= 0x61 && previousCode <= 0x7a
  const previousDigit = previousCode >= 0x30 && previousCode <= 0x39
  const currentUpper = currentCode >= 0x41 && currentCode <= 0x5a
  return (previousLower || previousDigit) && currentUpper
}

function bonusAt(clusters: readonly string[], index: number): number {
  if (index === 0) return BONUS_BOUNDARY
  const previous = clusters[index - 1]!
  const current = clusters[index]!
  if (!isWord(previous)) return BONUS_BOUNDARY
  if (isCamelTransition(previous, current)) return BONUS_CAMEL
  return 0
}

/** Greedy forward fuzzy match in grapheme coordinates; null when no match. */
function matchField(foldedQuery: readonly string[], field: PreparedField): FieldScore | null {
  const fieldClusters = field.clusters
  const foldedField = field.folded
  if (foldedQuery.length === 0) return { score: 0, matchedRanges: [] }
  if (foldedQuery.length > fieldClusters.length) return null
  let score = 0
  let queryIndex = 0
  let lastMatchIndex = -2
  const hits: number[] = []
  for (let index = 0; index < foldedField.length && queryIndex < foldedQuery.length; index += 1) {
    if (foldedField[index] !== foldedQuery[queryIndex]) continue
    let bonus = bonusAt(fieldClusters, index)
    if (index === lastMatchIndex + 1) bonus = Math.max(bonus, BONUS_CONSECUTIVE)
    if (queryIndex === 0) bonus *= BONUS_FIRST_CHAR_MULTIPLIER
    score += SCORE_MATCH + bonus
    if (lastMatchIndex >= 0 && index > lastMatchIndex + 1) {
      score += SCORE_GAP_START + (index - lastMatchIndex - 2) * SCORE_GAP_EXTENSION
    }
    hits.push(index)
    lastMatchIndex = index
    queryIndex += 1
  }
  if (queryIndex < foldedQuery.length) return null
  const matchedRanges: { start: number; end: number }[] = []
  for (const hit of hits) {
    const last = matchedRanges[matchedRanges.length - 1]
    if (last !== undefined && hit === last.end) last.end = hit + 1
    else matchedRanges.push({ start: hit, end: hit + 1 })
  }
  return { score, matchedRanges }
}

function fieldValue(item: CompletionItem, field: string): string | undefined {
  const fields = item.fields as Readonly<Record<string, string | undefined>> | undefined
  const explicit = fields?.[field]
  if (explicit !== undefined) return explicit
  if (field === "basename" || field === "command") return item.label
  return undefined
}

/**
 * Rank items against the query under a weighted field profile. Rank is the
 * best weighted field score (higher wins); ties keep input order. A limit
 * selects the top page without sorting the full result set.
 */
export function matchCompletions(
  query: string,
  items: readonly CompletionItem[],
  profile: CompletionProfile,
  options?: { readonly limit?: number },
): readonly MatchResult[] {
  const foldedQuery = graphemes(query).map((cluster) => cluster.toLowerCase())
  const results: MatchResult[] = []
  for (const item of items) {
    let bestRank = foldedQuery.length === 0 ? 0 : Number.NEGATIVE_INFINITY
    const fieldMatches: FieldMatch[] = []
    const prepared = preparedItem(item)
    for (const { field, weight } of profile.fields) {
      const value = fieldValue(item, field)
      if (value === undefined) continue
      const fieldScore = matchField(foldedQuery, preparedField(prepared, field, value))
      if (fieldScore === null) continue
      fieldMatches.push({ field, matchedRanges: fieldScore.matchedRanges })
      const weighted = fieldScore.score * weight
      if (weighted > bestRank) bestRank = weighted
    }
    if (fieldMatches.length === 0 && foldedQuery.length > 0) continue
    if (fieldMatches.length === 0 && foldedQuery.length === 0) {
      results.push({ item, rank: 0, fieldMatches: [] })
      continue
    }
    results.push({ item, rank: bestRank, fieldMatches })
  }
  const limit = options?.limit
  if (limit !== undefined && results.length > limit) return topStable(results, limit)
  return results.sort((left, right) => right.rank - left.rank)
}

/** Top-N by descending rank; equal ranks keep input order (single pass). */
function topStable(results: readonly MatchResult[], limit: number): readonly MatchResult[] {
  if (limit <= 0) return []
  const top: MatchResult[] = []
  let sorted = false
  for (const result of results) {
    if (top.length < limit) {
      top.push(result)
      if (top.length === limit) {
        top.sort((left, right) => right.rank - left.rank)
        sorted = true
      }
      continue
    }
    const weakest = top[top.length - 1]!
    if (result.rank <= weakest.rank) continue
    let low = 0
    let high = top.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (top[middle]!.rank >= result.rank) low = middle + 1
      else high = middle
    }
    top.splice(low, 0, result)
    top.pop()
  }
  return sorted || top.length === 0 ? top : top.sort((left, right) => right.rank - left.rank)
}
