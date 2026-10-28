/**
 * Session projection kernel: transcript and streaming-tail projection
 * behind immutable snapshots with a monotonic projection revision. The
 * application is the only writer; the viewModel reads whole revisions.
 *
 * Streaming model: a stream start parks a pending run; the first delta
 * promotes it to a live assistant transcript block that grows per delta;
 * end finalizes it and closes the stream fence. Fencing: per-stream
 * sequence watermarks for transient input, a global revision watermark for
 * durable blocks (tool upserts share it — canonical replay never mutates a
 * block twice). Associated assistant text reconciles by run turn: the
 * durable final payload wins but never erases visible text, and the fence
 * closes so late deltas drop. Tool blocks merge in place per toolUseId;
 * terminal statuses strip partialInput and freeze against deltas; orphan
 * tool deltas park in bounded FIFO buffers drained by the next upsert.
 * Text bodies are bounded at the 1 MiB display limit; final assistant
 * payloads are stored ANSI-sanitized; the transcript is a ring trimmed
 * at maxItems with tool/stream indices repaired. Rebase drops
 * unfinalized live blocks — transient content never survives a rewind
 * as committed history. Every structural transcript mutation mints an
 * ordered change into a bounded log; readers diff revisions through
 * changesSince instead of rescanning the snapshot.
 * Malformed writer input drops; the kernel never throws.
 */
import type {
  LiveTailBlock,
  PendingRun,
  SessionContent,
  SourceChange,
  TextBlockKind,
  TuiSessionProjection,
  ToolBlock,
  ToolDiff,
  ToolDiffHunk,
  ToolDiffLine,
  ToolStatus,
  PublicToolStatus,
  TranscriptBlock,
  TranscriptTextBlock,
} from "./index.js"

/** Minimal transient stream input shape carried by transient envelopes. */
export interface TransientStreamInput {
  readonly streamId: string
  readonly sequence: number
  readonly kind: "start" | "delta" | "end" | "text-delta" | "tool-start" | "tool-input-delta" | "tool-output-delta" | "tool-end"
  readonly text?: string
  readonly goal?: string
  /** Run association recorded on the promoted assistant block (text-delta). */
  readonly runId?: string
  readonly turn?: number
  /** Tool identity for the tool-scoped kinds. */
  readonly toolUseId?: string
  readonly name?: string
  readonly input?: unknown
  readonly startedAt?: string
}

/** Run-level assistant finalize input (fallback text for a completed run). */
export interface RunFinalizeInput {
  readonly runId: string
  readonly turn: number
  readonly text: string
}

/** Committed transcript block input carried by durable envelopes. */
export interface DurableBlockInput {
  readonly revision: number
  readonly kind: TextBlockKind
  readonly body: string
  readonly inputId?: string
  /** Canonical acceptance instant for a user input. */
  readonly acceptedAt?: string
  /**
   * Run association carried onto the block: assistant turns reconcile by
   * it, shell rows claim by it, and user/status/error rows keep it for
   * host-side run-slot reconciliation (input → run → terminal row).
   */
  readonly runId?: string
  readonly turn?: number
  readonly streaming?: boolean
  readonly durationMs?: number
  /** TUI-local shell lifecycle discriminator; canonical payloads may omit it. */
  readonly shellPhase?: "start" | "result"
}

/** Structured tool upsert input carried by durable tool envelopes. */
export interface ToolApplyInput {
  readonly revision: number
  readonly runId: string
  readonly turn: number
  readonly toolUseId: string
  readonly name: string
  readonly input?: unknown
  readonly status: ToolStatus
  readonly toolStatus?: PublicToolStatus
  readonly result?: string
  readonly partialInput?: string
  /** Expand/collapse toggle; canonical upserts omit it so the flag survives. */
  readonly collapsed?: boolean
  readonly startedAt?: string
  readonly durationMs?: number
  readonly questionOutcome?: "answered" | "declined" | "rejected"
  /** Display-channel diff carried by done upserts; validated/bounded at ingress. */
  readonly diff?: ToolDiff
}

/** Snapshot adoption input carried by snapshot envelopes. */
/** Block shape before identity minting; replace() input and appendBlock take drafts. */
export type TranscriptDraft = Omit<TranscriptTextBlock, "sourceId"> | Omit<ToolBlock, "sourceId">

export interface ProjectionReplaceInput {
  readonly revision: number
  readonly transcript: readonly TranscriptDraft[]
  readonly pending: readonly PendingRun[]
  /** Snapshot-carried session error, projected when newer than the watermark. */
  readonly lastError?: { readonly message: string; readonly revision: number }
}

const MAX_CLOSED_SHELL_RUNS = 512

/** Writer half owned by the application; the read facade stays frozen. */
export interface SessionProjectionWriter {
  applyTransient(input: TransientStreamInput): void
  /** Apply one durable block; false means malformed or stale input. */
  applyDurable(input: DurableBlockInput): boolean
  applyTool(input: ToolApplyInput): void
  replace(input: ProjectionReplaceInput): void
  /**
   * Session adoption: empty every projection surface INCLUDING the
   * durable watermark and snapshot-error memory (the legacy reset()
   * letter — distinct from clear(), which keeps them). The caller owns
   * knowing the switch: same-session snapshots replace without this.
   */
  reset(): void
  rebase(baseRevision: number): void
  /** Session-local block (shell output, surfaced error): no revision watermark. */
  appendLocal(kind: TextBlockKind, body: string): void
  /** Optimistic user echo; its durable event claims the row in place. */
  appendPendingUser(text: string): void
  /** Optimistic shell echo (`! command`); its run-start goal claims the row. */
  appendPendingShell(command: string, runId?: string): void
  /**
   * Arm the shell body-claim fence: after a local shell settled without its
   * canonical start, a late `! command` start can belong to that older run,
   * and an identical pending body cannot tell them apart. While armed,
   * canonical starts stop claiming optimistic rows (closed-marker replay
   * and plain append still apply); adoption/reset clears the fence.
   */
  fenceShellBodyClaims(): void
  /** Close a shell row at a terminal boundary; preserves output unless given. */
  settleShellRun(runId: string, output?: string, allowPendingFallback?: boolean): void
  /** Associate a local optimistic shell id with its canonical run id. */
  associateShellRun(localRunId: string, canonicalRunId: string): void
  /** Consume exactly one matching durable user echo (optimistic row stays). */
  suppressUserMessage(text: string): void
  /** Drop a cancelled run's assistant/tool blocks and stream state. */
  removeRun(runId: string): void
  /**
   * Abort settle: drop a cancelled or failed run's non-terminal tool blocks
   * (their terminal upsert never arrives); terminal blocks and other runs'
   * blocks survive. Same unfinalized-state rule as rebase.
   */
  abandonRunTools(runId: string): void
  /**
   * Checkpoint rewind (cancellation): splice the transcript at a captured
   * index. Distinct from rebase, which is revision-based resync. Watermarks
   * and suppressions survive.
   */
  rollbackTo(checkpoint: number, runId?: string): void
  /** Empty all visible state; watermarks and suppressions survive. */
  clear(): void
  /**
   * Cancel seal: commits the stream's live tail once with a marker and
   * closes the fence so late deltas drop (abort-tail semantics).
   */
  sealStream(streamId: string, marker: string): void
  /** Run finalize: lands fallback assistant text for a finished turn. */
  finalizeAssistant(input: RunFinalizeInput): void
}

/** Ring size and display bounds; the transcript is bounded state. */
export interface ProjectionOptions {
  readonly maxItems?: number
}

interface StreamState {
  sequence: number
  liveBlockIndex: number | null
  /** Exact UTF-8 size of the live block body, kept current by the append
   * path so a streaming delta never rescans the accumulated body. */
  bodyBytes: number
  /** True once the display bound truncated the body; later deltas drop. */
  bodyTruncated: boolean
}

const TEXT_BLOCK_KINDS: readonly string[] = ["user", "assistant", "status", "shell", "error"]
const TRANSIENT_KINDS: readonly string[] = [
  "start",
  "delta",
  "end",
  "text-delta",
  "tool-start",
  "tool-input-delta",
  "tool-output-delta",
  "tool-end",
]
const TOOL_STATUSES: readonly string[] = ["streaming", "running", "waiting", "approved", "denied", "done", "error"]
const MAX_TEXT_BYTES = 1_048_576
const TRUNCATION_MARKER = "\n… content truncated (TUI display limit 1 MiB)"
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8")
const DEFAULT_MAX_ITEMS = 2_000
const MAX_PENDING_TOOL_STREAMS = 256
const MAX_PENDING_SHELL_OUTPUTS = 256
const MAX_CHANGE_LOG = 128
const MAX_SUPPRESSED_USER_MESSAGES = 256
const MAX_SNAPSHOT_ERRORS = 256

function isTerminalToolStatus(status: ToolStatus): boolean {
  return status === "done" || status === "error" || status === "denied"
}

const ANSI_SEQUENCES =
  // eslint-disable-next-line no-control-regex -- stripping raw escape sequences from stored text is this helper's purpose
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

/** Removes ANSI escape sequences from text stored in transcript blocks. */
function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCES, "")
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= maxBytes) return value
  // Cut at the nearest character boundary at or before the budget; decoding
  // a split sequence would substitute U+FFFD and overshoot the cap.
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString("utf8")
}

function boundText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES) return value
  return `${utf8Prefix(value, MAX_TEXT_BYTES - TRUNCATION_MARKER_BYTES)}${TRUNCATION_MARKER}`
}

function appendBoundedText(current: string, delta: string): string {
  if (current.endsWith(TRUNCATION_MARKER)) return current
  const currentBytes = Buffer.byteLength(current, "utf8")
  if (currentBytes + Buffer.byteLength(delta, "utf8") <= MAX_TEXT_BYTES) return `${current}${delta}`
  const budget = MAX_TEXT_BYTES - TRUNCATION_MARKER_BYTES
  if (currentBytes >= budget) return `${utf8Prefix(current, budget)}${TRUNCATION_MARKER}`
  return `${current}${utf8Prefix(delta, budget - currentBytes)}${TRUNCATION_MARKER}`
}

function boundInput(input: unknown): unknown {
  try {
    const serialized = JSON.stringify(input)
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") <= MAX_TEXT_BYTES) return input
    return TRUNCATION_MARKER.trimStart()
  } catch {
    return "[unserializable tool input]"
  }
}

/**
 * Display title for a tool block: the resolved input's `description`
 * field when it is a non-empty string, whitespace-normalized to one
 * line. Derived from the stored input at BOTH merge sites so the live
 * and replay paths carry the same title; an input wholesale-replaced
 * by the size bound (a bare marker string) yields none.
 */
function toolTitle(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const description = (input as Record<string, unknown>).description
  if (typeof description !== "string") return undefined
  const title = description.replace(/\s+/gu, " ").trim()
  return title.length > 0 ? title : undefined
}

/** Whitelist-validate the diff view; malformed or oversized input drops to undefined. */
function boundDiff(diff: unknown): ToolDiff | undefined {
  try {
    if (typeof diff !== "object" || diff === null) return undefined
    const candidate = diff as Record<string, unknown>
    if (!Array.isArray(candidate.hunks)) return undefined
    const hunks: ToolDiffHunk[] = candidate.hunks.map((hunk) => {
      if (typeof hunk !== "object" || hunk === null) throw new Error("hunk")
      const h = hunk as Record<string, unknown>
      if (!Array.isArray(h.lines)) throw new Error("lines")
      const lines: ToolDiffLine[] = h.lines.map((line) => {
        if (typeof line !== "object" || line === null) throw new Error("line")
        const l = line as Record<string, unknown>
        if (l.kind !== "context" && l.kind !== "added" && l.kind !== "removed") throw new Error("kind")
        if (typeof l.text !== "string") throw new Error("text")
        return { kind: l.kind, text: l.text }
      })
      const counts = [h.oldStart, h.newStart, h.oldLines, h.newLines]
      if (counts.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 0)) throw new Error("counts")
      return {
        oldStart: h.oldStart as number,
        newStart: h.newStart as number,
        oldLines: h.oldLines as number,
        newLines: h.newLines as number,
        lines,
      }
    })
    const totals = [candidate.addedLines, candidate.removedLines, candidate.sites]
    if (totals.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 0)) throw new Error("totals")
    if (candidate.truncated !== undefined && typeof candidate.truncated !== "boolean") throw new Error("truncated")
    if (candidate.previewAvailable !== undefined && typeof candidate.previewAvailable !== "boolean") throw new Error("previewAvailable")
    const clean: ToolDiff = {
      hunks,
      addedLines: candidate.addedLines as number,
      removedLines: candidate.removedLines as number,
      sites: candidate.sites as number,
      ...(candidate.truncated === undefined ? {} : { truncated: candidate.truncated }),
      ...(candidate.previewAvailable === undefined ? {} : { previewAvailable: candidate.previewAvailable }),
    }
    const serialized = JSON.stringify(clean)
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_TEXT_BYTES) return undefined
    return clean
  } catch {
    return undefined
  }
}

function shellMarker(text: string): string {
  const newline = text.indexOf("\n")
  return newline === -1 ? text : text.slice(0, newline)
}

function shellOutput(text: string): string {
  const newline = text.indexOf("\n")
  return newline === -1 ? "" : text.slice(newline + 1)
}

function normalizeShellResult(result: string): string {
  const normalized = result
    .replace(/^exit_code:\s*\d+\n?/u, "")
    .replace(/^status:\s*[^\n]+\n?/u, "")
    .replace(/^stdout:\n?/u, "")
    .replace(/^stderr:\n?/u, "")
  return normalized.trim().length > 0 ? normalized : "(no output)"
}

function isTransientInput(input: TransientStreamInput): boolean {
  if (
    typeof input.streamId !== "string" ||
    input.streamId.length === 0 ||
    !Number.isFinite(input.sequence) ||
    !TRANSIENT_KINDS.includes(input.kind)
  ) {
    return false
  }
  if (input.kind === "tool-start")
    return typeof input.toolUseId === "string" && input.toolUseId.length > 0 && typeof input.name === "string" && input.name.length > 0
  if (input.kind === "tool-input-delta" || input.kind === "tool-output-delta") {
    return typeof input.toolUseId === "string" && input.toolUseId.length > 0
  }
  return true
}

function isRunFinalizeInput(input: RunFinalizeInput): boolean {
  return typeof input.runId === "string" && input.runId.length > 0 && Number.isFinite(input.turn) && typeof input.text === "string"
}

function isDurableInput(input: DurableBlockInput): boolean {
  return Number.isFinite(input.revision) && typeof input.body === "string" && TEXT_BLOCK_KINDS.includes(input.kind)
}

function isToolApplyInput(input: ToolApplyInput): boolean {
  return (
    Number.isFinite(input.revision) &&
    Number.isFinite(input.turn) &&
    typeof input.runId === "string" &&
    input.runId.length > 0 &&
    typeof input.toolUseId === "string" &&
    input.toolUseId.length > 0 &&
    typeof input.name === "string" &&
    input.name.length > 0 &&
    TOOL_STATUSES.includes(input.status)
  )
}

function isReplaceInput(input: ProjectionReplaceInput): boolean {
  return Number.isFinite(input.revision) && Array.isArray(input.transcript) && Array.isArray(input.pending)
}

/**
 * Merge a tool upsert onto its previous block. Terminal statuses strip
 * partialInput. Buffered orphan payloads adopt where the upsert itself
 * is silent — except the final input: a buffered orphan tool-end input
 * outranks the upsert's own (the live observation is the fresher one;
 * pinned by the orphan-buffer lifecycle tests), while a buffered orphan
 * output yields to an upsert result.
 */
function mergedToolBlock(
  previous: ToolBlock | null,
  input: ToolApplyInput,
  blockRevision: number,
  sourceId: string,
  drained: { finalInput?: unknown; bufferedPartial?: string; bufferedOutput?: string } = {},
): ToolBlock {
  const diff = boundDiff(input.diff)
  const resolvedInput =
    drained.finalInput !== undefined
      ? boundInput(drained.finalInput)
      : input.input !== undefined
        ? boundInput(input.input)
        : previous?.input
  return {
    kind: "tool",
    revision: blockRevision,
    body: `${input.name} ${input.status}`,
    // In-place merge: identity survives the upsert.
    sourceId,
    runId: input.runId,
    turn: input.turn,
    toolUseId: input.toolUseId,
    name: input.name,
    input: resolvedInput,
    title: toolTitle(resolvedInput),
    status: input.status,
    ...(input.toolStatus !== undefined
      ? { toolStatus: input.toolStatus }
      : previous?.toolStatus !== undefined
        ? { toolStatus: previous.toolStatus }
        : {}),
    collapsed: input.collapsed ?? previous?.collapsed ?? true,
    ...(input.startedAt !== undefined
      ? { startedAt: input.startedAt }
      : previous?.startedAt !== undefined
        ? { startedAt: previous.startedAt }
        : {}),
    ...(input.durationMs !== undefined
      ? { durationMs: input.durationMs }
      : previous?.durationMs !== undefined
        ? { durationMs: previous.durationMs }
        : {}),
    ...(input.questionOutcome !== undefined
      ? { questionOutcome: input.questionOutcome }
      : previous?.questionOutcome !== undefined
        ? { questionOutcome: previous.questionOutcome }
        : {}),
    // Display-channel diff: only a carrying upsert mints it; a later
    // silent upsert never erases a minted diff (merge survival).
    ...(diff !== undefined ? { diff } : previous?.diff !== undefined ? { diff: previous.diff } : {}),
    ...(input.result !== undefined
      ? { result: boundText(input.result) }
      : drained.bufferedOutput !== undefined
        ? { result: boundText(drained.bufferedOutput) }
        : previous?.result !== undefined
          ? { result: previous.result }
          : {}),
    ...(isTerminalToolStatus(input.status)
      ? {}
      : input.partialInput !== undefined
        ? { partialInput: boundText(input.partialInput) }
        : drained.finalInput === undefined && drained.bufferedPartial !== undefined
          ? { partialInput: boundText(drained.bufferedPartial) }
          : previous?.partialInput !== undefined
            ? { partialInput: previous.partialInput }
            : {}),
  }
}

export function createSessionProjection(options: ProjectionOptions = {}): TuiSessionProjection & SessionProjectionWriter {
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? DEFAULT_MAX_ITEMS))
  let revision = 0
  let durableWatermark = 0
  // TUI-local source identity: a monotonic serial inside a generation that
  // adoption bumps. Evicted ids are never reused (the serial only grows).
  let sourceGeneration = 1
  let sourceSerial = 0
  const mintSourceId = (): string => `s${sourceGeneration}-${(sourceSerial += 1)}`
  let transcript: readonly TranscriptBlock[] = []
  let pending: readonly PendingRun[] = []
  let snapshot: SessionContent = freeze({ projectionRevision: revision, transcript, pending })
  // Structural change log: ordered append/replace/truncate/reset mints
  // from real mutation points, bounded so a consumer polling past the
  // retained window reads null and treats the gap as a wholesale reset.
  const changeLog: { change: SourceChange; revision: number }[] = []
  let logBaseRevision = 0
  let pendingChanges: SourceChange[] = []
  const streams = new Map<string, StreamState>()
  const toolIndexes = new Map<string, number>()
  // Orphan tool deltas buffered before their tool block exists; the FIFO
  // bounds how many distinct tool streams can park here at once.
  const pendingToolInputs = new Map<string, string>()
  const pendingToolFinalInputs = new Map<string, unknown>()
  const pendingToolOutputs = new Map<string, string>()
  const pendingToolStreamOrder: string[] = []
  // A shell output frame may arrive before its durable RunStarted row. Keep
  // it by stream id until the shell row claims the stream; this is TUI-local
  // ordering state, not a shared protocol buffer.
  const pendingShellOutputs = new Map<string, string>()
  const pendingShellOutputOrder: string[] = []
  const pendingShellOutputTools = new Map<string, Set<string>>()
  const pendingShellOutputStreams = new Map<string, string>()
  // Optimistic row trackers and shell-run associations (indexes into the
  // transcript ring; every trim repairs them alongside the tool indexes).
  const pendingUserIndexes: number[] = []
  const pendingShellIndexes: number[] = []
  const pendingShellRuns = new Map<string, number>()
  const closedShellIndexes = new Set<number>()
  const shellRuns = new Map<string, number>()
  // A session-backed shell starts locally, then its canonical RunStarted may
  // use a different run id. Keep that alias until the row settles.
  const shellRunAliases = new Map<string, string>()
  const closedShellRuns = new Set<string>()
  const closedShellRunOrder: string[] = []
  // Armed by run coordination after an unmatched local shell fallback: the
  // same command text can now arrive for an older aborted run, so canonical
  // starts may no longer claim optimistic rows by body.
  let shellClaimFence = false
  const suppressedUserMessages = new Set<string>()
  const seenSnapshotErrors = new Set<string>()

  const bump = (): void => {
    revision += 1
    snapshot = freeze({ projectionRevision: revision, transcript, pending })
    flushChanges(revision)
  }
  const note = (change: SourceChange): void => {
    pendingChanges.push(change)
  }
  const noteReplaceAt = (index: number | null | undefined): void => {
    const block = index === undefined || index === null ? undefined : transcript[index]
    if (block !== undefined) note({ kind: "replace", sourceIds: [block.sourceId] })
  }
  /**
   * Contiguous cut ranges for every pre-splice index the shifts map
   * dropped, re-based by the blocks earlier ranges already removed so
   * folding them in mint order against the shrinking list cuts the
   * same blocks (each range indexes the list as it stands after the
   * ranges before it).
   */
  const noteCutRanges = (shifts: Map<number, number>, lengthBefore: number): void => {
    let index = 0
    let removed = 0
    while (index < lengthBefore) {
      if (shifts.has(index)) {
        index += 1
        continue
      }
      const from = index
      while (index < lengthBefore && !shifts.has(index)) index += 1
      note({ kind: "truncate", from: from - removed, to: index - removed, throughEnd: index === lengthBefore })
      removed += index - from
    }
  }
  /**
   * Tag every minted change with the revision that publishes it.
   * Consecutive replaces merge into one entry — re-rendering a source
   * the consumer may already have seen is harmless; missing one is not.
   */
  const flushChanges = (atRevision: number): void => {
    for (const change of pendingChanges) {
      const last = changeLog[changeLog.length - 1]
      if (change.kind === "replace" && last !== undefined && last.change.kind === "replace") {
        const merged = new Set([...last.change.sourceIds, ...change.sourceIds])
        last.change = { kind: "replace", sourceIds: [...merged] }
        last.revision = atRevision
        continue
      }
      changeLog.push({ change, revision: atRevision })
    }
    pendingChanges = []
    evictChangeOverflow()
  }
  const evictChangeOverflow = (): void => {
    while (changeLog.length > MAX_CHANGE_LOG) {
      const evicted = changeLog.shift()!
      if (evicted.revision > logBaseRevision) logBaseRevision = evicted.revision
    }
  }
  /** Wholesale-rebuild mint for adoption paths that bypass bump(). */
  const mintReset = (atRevision: number): void => {
    pendingChanges = []
    changeLog.push({ change: { kind: "reset" }, revision: atRevision })
    evictChangeOverflow()
  }
  const trackPendingToolStream = (toolUseId: string): void => {
    if (pendingToolStreamOrder.includes(toolUseId)) return
    pendingToolStreamOrder.push(toolUseId)
    while (pendingToolStreamOrder.length > MAX_PENDING_TOOL_STREAMS) {
      const evicted = pendingToolStreamOrder.shift()!
      pendingToolInputs.delete(evicted)
      pendingToolFinalInputs.delete(evicted)
      pendingToolOutputs.delete(evicted)
      forgetPendingShellOutputTool(evicted)
    }
  }
  const forgetPendingShellOutputTool = (toolUseId: string): void => {
    const streamId = pendingShellOutputStreams.get(toolUseId)
    if (streamId === undefined) return
    pendingShellOutputStreams.delete(toolUseId)
    const tools = pendingShellOutputTools.get(streamId)
    if (tools === undefined) return
    tools.delete(toolUseId)
    if (tools.size === 0) {
      pendingShellOutputTools.delete(streamId)
      pendingShellOutputs.delete(streamId)
      const at = pendingShellOutputOrder.indexOf(streamId)
      if (at >= 0) pendingShellOutputOrder.splice(at, 1)
    }
  }
  const dropPendingToolStream = (toolUseId: string): void => {
    pendingToolInputs.delete(toolUseId)
    pendingToolFinalInputs.delete(toolUseId)
    pendingToolOutputs.delete(toolUseId)
    forgetPendingShellOutputTool(toolUseId)
    const at = pendingToolStreamOrder.indexOf(toolUseId)
    if (at >= 0) pendingToolStreamOrder.splice(at, 1)
  }
  const clearPendingToolStreams = (): void => {
    pendingToolInputs.clear()
    pendingToolFinalInputs.clear()
    pendingToolOutputs.clear()
    pendingToolStreamOrder.length = 0
    pendingShellOutputs.clear()
    pendingShellOutputOrder.length = 0
    pendingShellOutputTools.clear()
    pendingShellOutputStreams.clear()
  }
  const trackPendingShellOutput = (streamId: string): void => {
    if (pendingShellOutputOrder.includes(streamId)) return
    pendingShellOutputOrder.push(streamId)
    while (pendingShellOutputOrder.length > MAX_PENDING_SHELL_OUTPUTS) {
      const evicted = pendingShellOutputOrder.shift()
      if (evicted !== undefined) {
        pendingShellOutputs.delete(evicted)
        const toolIds = pendingShellOutputTools.get(evicted)
        if (toolIds !== undefined) {
          for (const toolUseId of toolIds) pendingShellOutputStreams.delete(toolUseId)
          pendingShellOutputTools.delete(evicted)
        }
      }
    }
  }
  const dropPendingShellOutput = (streamId: string): void => {
    pendingShellOutputs.delete(streamId)
    const at = pendingShellOutputOrder.indexOf(streamId)
    if (at >= 0) pendingShellOutputOrder.splice(at, 1)
    const tools = pendingShellOutputTools.get(streamId)
    if (tools !== undefined) {
      for (const toolUseId of tools) {
        pendingShellOutputStreams.delete(toolUseId)
        pendingToolOutputs.delete(toolUseId)
        if (!pendingToolInputs.has(toolUseId) && !pendingToolFinalInputs.has(toolUseId)) {
          const toolAt = pendingToolStreamOrder.indexOf(toolUseId)
          if (toolAt >= 0) pendingToolStreamOrder.splice(toolAt, 1)
        }
      }
      pendingShellOutputTools.delete(streamId)
    }
  }
  const closeStreamAt = (index: number): void => {
    for (const [key, state] of streams) {
      if (state.liveBlockIndex === index) streams.delete(key)
    }
  }
  /** Claim a pending user row for a durable echo; false means plain append. */
  const claimPendingUser = (input: DurableBlockInput): boolean => {
    if (pendingUserIndexes.length === 0) return false
    const matches = (index: number): boolean => {
      const row = transcript[index]
      return row?.kind === "user" && row.body === input.body
    }
    const at = pendingUserIndexes.findIndex(matches)
    const claimed = at >= 0 ? at : pendingUserIndexes.findIndex((index) => transcript[index]?.kind === "user")
    if (claimed < 0) return false
    const [index] = pendingUserIndexes.splice(claimed, 1)
    const row = index === undefined ? undefined : transcript[index]
    if (row?.kind === "user" && (input.inputId !== undefined || input.acceptedAt !== undefined)) {
      transcript = transcript.map((entry, candidateIndex) =>
        candidateIndex === index
          ? {
              ...row,
              ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
              ...(input.acceptedAt === undefined ? {} : { acceptedAt: input.acceptedAt }),
            }
          : entry,
      )
      noteReplaceAt(index)
      bump()
    }
    return true
  }
  const shellRelatedRunIds = (runId: string): Set<string> => {
    const related = new Set<string>([runId])
    const canonical = shellRunAliases.get(runId)
    if (canonical !== undefined) related.add(canonical)
    for (const [localRunId, canonicalRunId] of shellRunAliases) {
      if (localRunId === runId || canonicalRunId === runId || canonicalRunId === canonical) {
        related.add(localRunId)
        related.add(canonicalRunId)
      }
    }
    return related
  }
  const shellIndexFor = (runId: string): number | undefined => {
    for (const relatedRunId of shellRelatedRunIds(runId)) {
      const index = shellRuns.get(relatedRunId)
      if (index !== undefined) return index
    }
    return undefined
  }
  const takePendingShellOutput = (runId: string): string | undefined => {
    let output = ""
    for (const relatedRunId of shellRelatedRunIds(runId)) {
      const buffered = pendingShellOutputs.get(relatedRunId)
      if (buffered === undefined) continue
      output = appendBoundedText(output, buffered)
      dropPendingShellOutput(relatedRunId)
    }
    return output.length === 0 ? undefined : output
  }
  const mergePendingShellOutput = (runId: string, index: number): boolean => {
    const buffered = takePendingShellOutput(runId)
    if (buffered === undefined) return false
    const row = transcript[index]
    if (row?.kind !== "shell") return false
    const output = appendBoundedText(shellOutput(row.body), buffered)
    transcript = transcript.map((entry, at) =>
      at === index ? { ...entry, revision: revision + 1, body: `${shellMarker(row.body)}\n${output}` } : entry,
    )
    noteReplaceAt(index)
    return true
  }
  /**
   * Shell run transition on a durable shell body: a `! command` goal
   * claims (or starts) the run's row; anything else finalizes it with the
   * normalized result. False means plain append.
   */
  const shellDurable = (runId: string, body: string, phase?: "start" | "result"): boolean => {
    if (closedShellRuns.has(runId)) {
      dropPendingShellOutput(runId)
      return true
    }
    const isStart = phase === "start" || (phase === undefined && body.startsWith("! "))
    if (isStart) {
      // Replayed RunStarted events must not create a second optimistic row or
      // retarget output away from the already-owned shell row.
      const existingIndex = shellIndexFor(runId)
      if (existingIndex !== undefined) {
        const merged = mergePendingShellOutput(runId, existingIndex)
        if (merged) bump()
        return true
      }
      // A duplicate start with a different canonical id is still the same
      // logical shell when its marker matches the open row. Alias it instead
      // of appending a second command row.
      const sameMarker = [...shellRuns.entries()].find(([, index]) => {
        const row = transcript[index]
        return row?.kind === "shell" && shellMarker(row.body) === body
      })
      if (sameMarker !== undefined) {
        shellRunAliases.set(runId, sameMarker[0])
        const merged = mergePendingShellOutput(runId, sameMarker[1])
        if (merged) bump()
        return true
      }
      // The body-claim fence guards the ambiguity a late start creates
      // after an unmatched local shell fallback: the pending row may belong
      // to a NEWER submission of the same command. Skip the claim and let
      // the closed-marker level absorb the stale replay instead.
      const at = shellClaimFence ? -1 : pendingShellIndexes.findIndex((index) => transcript[index]?.body === body)
      if (at >= 0) {
        const index = pendingShellIndexes[at]!
        for (const [localRunId, pendingIndex] of pendingShellRuns) {
          if (pendingIndex === index && localRunId !== runId) shellRunAliases.set(localRunId, runId)
        }
        dropPendingShellIndex(index)
        shellRuns.set(runId, index)
        const merged = mergePendingShellOutput(runId, index)
        if (merged) bump()
        return true
      }
      if (closedShellIndexFor(body) !== undefined) {
        // A local cancel/failure may close the optimistic row before the
        // canonical start arrives. Claim it as closed so late replay cannot
        // append a duplicate shell row or reopen its mutable tail.
        dropPendingShellOutput(runId)
        rememberClosedShellRun(runId)
        return true
      }
      const index = appendBlock({ kind: "shell", revision: durableWatermark, body: boundText(body) })
      shellRuns.set(runId, index)
      mergePendingShellOutput(runId, index)
      bump()
      return true
    }
    const index = shellIndexFor(runId)
    if (index === undefined) return false
    const row = transcript[index]
    if (row?.kind !== "shell") return true
    const relatedRunIds = shellRelatedRunIds(runId)
    const buffered = takePendingShellOutput(runId)
    const result = normalizeShellResult(body)
    let rendered: string
    if (result === "(no output)") {
      // A redacted durable result carries no output fact: the live stream
      // (row tail plus still-pending deltas) is the only output this run
      // will ever project, so an empty body must not replace it.
      rendered = appendBoundedText(shellOutput(row.body), buffered ?? "")
      if (rendered.length === 0) rendered = result
    } else {
      let live = buffered === undefined ? "" : buffered
      if (live.length > 0) live = appendBoundedText(shellOutput(row.body), live)
      rendered = appendBoundedText(live, result)
    }
    transcript = transcript.map((entry, at) =>
      at === index ? { ...entry, revision: durableWatermark, body: `${shellMarker(row.body)}\n${boundText(rendered)}` } : entry,
    )
    noteReplaceAt(index)
    for (const relatedRunId of relatedRunIds) {
      shellRuns.delete(relatedRunId)
      rememberClosedShellRun(relatedRunId)
    }
    closedShellIndexes.add(index)
    dropShellAliases(runId)
    bump()
    return true
  }
  const settleShellRun = (runId: string, output?: string, allowPendingFallback = true): void => {
    if (typeof runId !== "string" || runId.length === 0) return
    const localAlias = [...shellRunAliases].find(([, canonicalRunId]) => canonicalRunId === runId)?.[0]
    let canonicalRunId = shellRunAliases.get(runId) ?? runId
    let index = shellIndexFor(runId)
    let pendingKey = pendingShellRuns.has(runId) ? runId : (localAlias ?? runId)
    if (index === undefined && allowPendingFallback && shellRuns.size === 0 && pendingShellRuns.size === 1 && !closedShellRuns.has(runId)) {
      // Compatibility for a terminal-before-start replay when the projection
      // has exactly one optimistic shell and no active shell identity. The
      // application normally establishes this association in run coordination
      // before reaching this fallback.
      const optimistic = [...pendingShellRuns.entries()][0]
      if (optimistic !== undefined) {
        pendingKey = optimistic[0]
        index = optimistic[1]
        canonicalRunId = runId
        shellRunAliases.set(pendingKey, runId)
      }
    }
    if (index === undefined) return
    const row = transcript[index]
    const buffered = takePendingShellOutput(runId)
    for (const relatedRunId of shellRelatedRunIds(runId)) shellRuns.delete(relatedRunId)
    dropShellAliases(canonicalRunId)
    dropShellAliases(runId)
    rememberClosedShellRun(canonicalRunId)
    rememberClosedShellRun(runId)
    closedShellIndexes.add(index)
    if (pendingShellRuns.has(pendingKey)) dropPendingShellIndex(index)
    if (row?.kind === "shell" && (output !== undefined || buffered !== undefined)) {
      let rendered = shellOutput(row.body)
      if (buffered !== undefined) rendered = appendBoundedText(rendered, buffered)
      if (output !== undefined) rendered = appendBoundedText(rendered, normalizeShellResult(output))
      transcript = transcript.map((entry, at) =>
        at === index ? { ...entry, revision: revision + 1, body: `${shellMarker(row.body)}\n${boundText(rendered)}` } : entry,
      )
      noteReplaceAt(index)
    }
    bump()
  }
  const liveIndices = (): Set<number> => {
    const live = new Set<number>()
    for (const state of streams.values()) {
      if (state.liveBlockIndex !== null) live.add(state.liveBlockIndex)
    }
    return live
  }
  const rebuildToolIndexes = (): void => {
    toolIndexes.clear()
    for (let index = 0; index < transcript.length; index += 1) {
      const block = transcript[index]
      if (block?.kind === "tool") toolIndexes.set(block.toolUseId, index)
    }
  }
  const shiftArrayIndexes = (values: number[], removed: number): void => {
    let write = 0
    for (const index of values) {
      if (index >= removed) values[write++] = index - removed
    }
    values.length = write
  }
  const shiftIndexMap = (values: Map<string, number>, removed: number): void => {
    for (const [key, index] of values) {
      if (index < removed) values.delete(key)
      else values.set(key, index - removed)
    }
  }
  const shiftIndexSet = (values: Set<number>, removed: number): void => {
    const shifted = new Set<number>()
    for (const index of values) {
      if (index >= removed) shifted.add(index - removed)
    }
    values.clear()
    for (const index of shifted) values.add(index)
  }
  const remapIndexMap = (values: Map<string, number>, shifts: Map<number, number>): void => {
    for (const [key, index] of values) {
      const shifted = shifts.get(index)
      if (shifted === undefined) values.delete(key)
      else values.set(key, shifted)
    }
  }
  const remapIndexSet = (values: Set<number>, shifts: Map<number, number>): void => {
    const remapped = new Set<number>()
    for (const index of values) {
      const shifted = shifts.get(index)
      if (shifted !== undefined) remapped.add(shifted)
    }
    values.clear()
    for (const index of remapped) values.add(index)
  }
  const pruneIndexMap = (values: Map<string, number>, safe: number): void => {
    for (const [key, index] of values) {
      if (index >= safe) values.delete(key)
    }
  }
  const pruneIndexSet = (values: Set<number>, safe: number): void => {
    for (const index of values) {
      if (index >= safe) values.delete(index)
    }
  }
  const dropPendingShellIndex = (index: number): void => {
    const at = pendingShellIndexes.indexOf(index)
    if (at >= 0) pendingShellIndexes.splice(at, 1)
    for (const [runId, pendingIndex] of pendingShellRuns) {
      if (pendingIndex === index) pendingShellRuns.delete(runId)
    }
  }
  const dropShellAliases = (runId: string): void => {
    for (const [localRunId, canonicalRunId] of shellRunAliases) {
      if (localRunId === runId || canonicalRunId === runId) shellRunAliases.delete(localRunId)
    }
  }
  const rememberClosedShellRun = (runId: string): void => {
    if (runId.length === 0 || closedShellRuns.has(runId)) return
    closedShellRuns.add(runId)
    closedShellRunOrder.push(runId)
    while (closedShellRunOrder.length > MAX_CLOSED_SHELL_RUNS) {
      const evicted = closedShellRunOrder.shift()
      if (evicted !== undefined) closedShellRuns.delete(evicted)
    }
  }
  const closedShellIndexFor = (body: string): number | undefined => {
    const index = transcript.findIndex(
      (entry, at) => closedShellIndexes.has(at) && entry.kind === "shell" && shellMarker(entry.body) === body,
    )
    return index >= 0 ? index : undefined
  }
  const associateShellRun = (localRunId: string, canonicalRunId: string): void => {
    if (
      typeof localRunId !== "string" ||
      localRunId.length === 0 ||
      typeof canonicalRunId !== "string" ||
      canonicalRunId.length === 0 ||
      localRunId === canonicalRunId
    ) {
      return
    }
    if (pendingShellRuns.has(localRunId) || shellRuns.has(localRunId)) shellRunAliases.set(localRunId, canonicalRunId)
  }
  const trimOverflow = (): void => {
    const removed = transcript.length - maxItems
    if (removed <= 0) return
    const lengthBefore = transcript.length
    transcript = transcript.slice(removed)
    note({ kind: "truncate", from: 0, to: removed, throughEnd: removed >= lengthBefore })
    for (const [toolUseId, index] of toolIndexes) {
      if (index < removed) toolIndexes.delete(toolUseId)
      else toolIndexes.set(toolUseId, index - removed)
    }
    for (const [runId, index] of shellRuns) {
      if (index < removed) {
        shellRuns.delete(runId)
        dropShellAliases(runId)
      } else shellRuns.set(runId, index - removed)
    }
    shiftArrayIndexes(pendingUserIndexes, removed)
    shiftArrayIndexes(pendingShellIndexes, removed)
    shiftIndexMap(pendingShellRuns, removed)
    shiftIndexSet(closedShellIndexes, removed)
    for (const state of streams.values()) {
      // A trimmed live block re-promotes as a fresh block on its next delta.
      if (state.liveBlockIndex === null) continue
      state.liveBlockIndex = state.liveBlockIndex >= removed ? state.liveBlockIndex - removed : null
    }
  }
  const appendBlock = (draft: TranscriptDraft): number => {
    // Drafts may carry a pre-minted id (tool promotion); plain drafts mint.
    const existing = (draft as { sourceId?: string }).sourceId
    const block = { ...draft, sourceId: existing ?? mintSourceId() } as TranscriptBlock
    transcript = [...transcript, block]
    note({ kind: "append", sourceIds: [block.sourceId] })
    trimOverflow()
    return transcript.length - 1
  }
  /** Tool-scoped transient routing: block growth when live, orphan buffers otherwise. */
  const applyToolTransient = (input: TransientStreamInput): void => {
    // Shell runs drink output deltas first (legacy appendShellOutput order).
    if (input.kind === "tool-output-delta") {
      const shellIndex = shellIndexFor(input.streamId)
      const row = shellIndex === undefined ? undefined : transcript[shellIndex]
      if (row !== undefined && row.kind === "shell") {
        const output = appendBoundedText(shellOutput(row.body), input.text ?? "")
        transcript = transcript.map((entry, at) =>
          at === shellIndex ? { ...entry, revision: revision + 1, body: `${shellMarker(row.body)}\n${output}` } : entry,
        )
        noteReplaceAt(shellIndex)
        bump()
        return
      }
      const hasGenericToolState =
        toolIndexes.get(input.toolUseId!) !== undefined ||
        pendingToolInputs.has(input.toolUseId!) ||
        pendingToolFinalInputs.has(input.toolUseId!)
      if (shellIndex === undefined && !hasGenericToolState) {
        if (closedShellRuns.has(input.streamId)) return
        pendingToolOutputs.set(input.toolUseId!, appendBoundedText(pendingToolOutputs.get(input.toolUseId!) ?? "", input.text ?? ""))
        trackPendingToolStream(input.toolUseId!)
        pendingShellOutputs.set(input.streamId, appendBoundedText(pendingShellOutputs.get(input.streamId) ?? "", input.text ?? ""))
        trackPendingShellOutput(input.streamId)
        const previousStreamId = pendingShellOutputStreams.get(input.toolUseId!)
        if (previousStreamId !== undefined && previousStreamId !== input.streamId) {
          pendingShellOutputTools.get(previousStreamId)?.delete(input.toolUseId!)
        }
        pendingShellOutputStreams.set(input.toolUseId!, input.streamId)
        const toolIds = pendingShellOutputTools.get(input.streamId) ?? new Set<string>()
        toolIds.add(input.toolUseId!)
        pendingShellOutputTools.set(input.streamId, toolIds)
        return
      }
    }
    const toolUseId = input.toolUseId!
    const index = toolIndexes.get(toolUseId)
    const block = index === undefined ? undefined : transcript[index]
    if (input.kind === "tool-start") {
      if (block !== undefined && block.kind === "tool") {
        // Deliberate deviation: a tool-start replay on a terminal block is a
        // no-op here, where legacy's merge would demote it back to streaming.
        if (isTerminalToolStatus(block.status)) return
        transcript = transcript.map((entry, at) =>
          at === index
            ? {
                ...block,
                revision: revision + 1,
                body: `${block.name} streaming`,
                status: "streaming",
                ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
              }
            : entry,
        )
        noteReplaceAt(index)
        bump()
        return
      }
      const drained = {
        finalInput: pendingToolFinalInputs.get(toolUseId),
        bufferedPartial: pendingToolInputs.get(toolUseId),
        bufferedOutput: pendingToolOutputs.get(toolUseId),
      }
      dropPendingToolStream(toolUseId)
      toolIndexes.set(
        toolUseId,
        appendBlock(
          mergedToolBlock(
            null,
            {
              revision: revision + 1,
              runId: input.runId ?? input.streamId,
              turn: input.turn ?? 0,
              toolUseId,
              name: input.name!,
              input: {},
              status: "streaming",
            },
            revision + 1,
            mintSourceId(),
            drained,
          ),
        ),
      )
      bump()
      return
    }
    if (input.kind === "tool-input-delta") {
      if (block === undefined) {
        pendingToolInputs.set(toolUseId, appendBoundedText(pendingToolInputs.get(toolUseId) ?? "", input.text ?? ""))
        trackPendingToolStream(toolUseId)
        return
      }
      if (block.kind === "tool" && !isTerminalToolStatus(block.status)) {
        const grown = appendBoundedText(block.partialInput ?? "", input.text ?? "")
        transcript = transcript.map((entry, at) => (at === index ? { ...block, revision: revision + 1, partialInput: grown } : entry))
        noteReplaceAt(index)
        bump()
      }
      return
    }
    if (input.kind === "tool-output-delta") {
      if (block === undefined) {
        pendingToolOutputs.set(toolUseId, appendBoundedText(pendingToolOutputs.get(toolUseId) ?? "", input.text ?? ""))
        trackPendingToolStream(toolUseId)
        return
      }
      if (block.kind === "tool" && !isTerminalToolStatus(block.status)) {
        const grown = appendBoundedText(block.result ?? "", input.text ?? "")
        transcript = transcript.map((entry, at) => (at === index ? { ...block, revision: revision + 1, result: grown } : entry))
        noteReplaceAt(index)
        bump()
      }
      return
    }
    // tool-end: the final input lands; partial input is spent.
    if (block !== undefined && block.kind === "tool") {
      const status = isTerminalToolStatus(block.status) ? block.status : "streaming"
      // A tool-end without input observes nothing new: keep the stored
      // input (and its title), matching the durable merge's fallback.
      const finalInput = input.input !== undefined ? boundInput(input.input) : block.input
      transcript = transcript.map((entry, at) =>
        at === index
          ? {
              ...block,
              revision: revision + 1,
              body: `${block.name} ${status}`,
              input: finalInput,
              title: toolTitle(finalInput),
              partialInput: undefined,
              status,
            }
          : entry,
      )
      noteReplaceAt(index)
      bump()
      return
    }
    pendingToolInputs.delete(toolUseId)
    pendingToolFinalInputs.set(toolUseId, input.input)
    trackPendingToolStream(toolUseId)
  }
  return {
    content() {
      return snapshot
    },
    liveTail() {
      const live = liveIndices()
      for (const index of toolIndexes.values()) {
        const block = transcript[index]
        if (block?.kind === "tool" && !isTerminalToolStatus(block.status)) live.add(index)
      }
      if (live.size === 0) return []
      return transcript
        .filter((_, index) => live.has(index))
        .map((block): LiveTailBlock => {
          if (block.kind === "tool") {
            return {
              sourceId: block.sourceId,
              kind: "tool",
              body: block.body,
              runId: block.runId,
              turn: block.turn,
              toolUseId: block.toolUseId,
              name: block.name,
              input: block.input,
              ...(block.title === undefined ? {} : { title: block.title }),
              status: block.status,
              ...(block.toolStatus === undefined ? {} : { toolStatus: block.toolStatus }),
              ...(block.result === undefined ? {} : { result: block.result }),
              ...(block.partialInput === undefined ? {} : { partialInput: block.partialInput }),
              ...(block.durationMs === undefined ? {} : { durationMs: block.durationMs }),
              ...(block.questionOutcome === undefined ? {} : { questionOutcome: block.questionOutcome }),
              ...(block.diff === undefined ? {} : { diff: block.diff }),
            }
          }
          return {
            sourceId: block.sourceId,
            kind: block.kind,
            body: block.body,
            ...(block.streaming === undefined ? {} : { streaming: block.streaming }),
          }
        })
    },
    sourceGeneration() {
      return sourceGeneration
    },
    changesSince(fromRevision) {
      if (!Number.isFinite(fromRevision)) return null
      if (fromRevision >= revision) {
        return { sinceRevision: fromRevision, upToRevision: revision, changes: [] }
      }
      if (fromRevision < logBaseRevision) return null
      const changes = changeLog.filter((entry) => entry.revision > fromRevision).map((entry) => entry.change)
      return { sinceRevision: fromRevision, upToRevision: revision, changes }
    },
    unsettledSourceIds() {
      const unsettled = new Set<string>()
      for (const index of toolIndexes.values()) {
        const block = transcript[index]
        if (block !== undefined && block.kind === "tool" && !isTerminalToolStatus(block.status)) unsettled.add(block.sourceId)
      }
      for (const index of shellRuns.values()) {
        const block = transcript[index]
        if (block !== undefined && block.kind === "shell") unsettled.add(block.sourceId)
      }
      // A session-backed bang has an optimistic row before RunStarted claims
      // it. Keep that row mutable until the canonical run edge; otherwise an
      // early frame freezes the command before its output can merge in place.
      for (const index of pendingShellIndexes) {
        const block = transcript[index]
        if (block !== undefined && block.kind === "shell") unsettled.add(block.sourceId)
      }
      return unsettled
    },
    applyTransient(input) {
      if (!isTransientInput(input)) return
      const state = streams.get(input.streamId)
      if (state !== undefined && input.sequence <= state.sequence) return
      const toolScoped = input.kind.startsWith("tool-")
      // Tool-scoped events may legitimately precede the run's start; they
      // create a fence-only entry (sequence watermark, no parked run).
      if (state === undefined && input.kind !== "start" && !toolScoped) return
      const stream = state ?? { sequence: 0, liveBlockIndex: null, bodyBytes: 0, bodyTruncated: false }
      stream.sequence = input.sequence
      if (toolScoped) {
        streams.set(input.streamId, stream)
        applyToolTransient(input)
        return
      }
      if (input.kind === "start") {
        streams.set(input.streamId, stream)
        pending = [...pending.filter((run) => run.runId !== input.streamId), { runId: input.streamId, goal: input.goal ?? "" }]
        bump()
        return
      }
      if (input.kind === "delta" || input.kind === "text-delta") {
        // Zero-length text deltas carry no state (legacy skips them whole).
        if ((input.text ?? "").length === 0) return
        if (stream.liveBlockIndex === null) {
          pending = pending.filter((run) => run.runId !== input.streamId)
          const body = appendBoundedText("", input.text ?? "")
          stream.bodyBytes = Buffer.byteLength(body, "utf8")
          stream.bodyTruncated = body.endsWith(TRUNCATION_MARKER)
          stream.liveBlockIndex = appendBlock({
            kind: "assistant",
            revision: revision + 1,
            body,
            streaming: true,
            ...(input.kind !== "text-delta" || input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.kind !== "text-delta" || input.turn === undefined ? {} : { turn: input.turn }),
          })
        } else {
          const delta = input.text ?? ""
          const deltaBytes = Buffer.byteLength(delta, "utf8")
          const live = transcript[stream.liveBlockIndex]!
          // Running byte count: the fast path appends without rescanning
          // the accumulated body; only the one overflow delta pays for
          // the bounded rewrite.
          let body: string
          if (stream.bodyTruncated) {
            body = live.body
          } else if (stream.bodyBytes + deltaBytes <= MAX_TEXT_BYTES) {
            body = `${live.body}${delta}`
            stream.bodyBytes += deltaBytes
          } else {
            body = appendBoundedText(live.body, delta)
            stream.bodyBytes = Buffer.byteLength(body, "utf8")
            stream.bodyTruncated = true
          }
          transcript = transcript.map((entry, index) =>
            index === stream.liveBlockIndex ? { ...entry, revision: revision + 1, body } : entry,
          )
          noteReplaceAt(stream.liveBlockIndex)
        }
        bump()
        return
      }
      pending = pending.filter((run) => run.runId !== input.streamId)
      // Closing the text stream finalizes its live block: streaming is a
      // property of an OPEN stream, so the block stops rendering in the
      // raw streaming phase the moment the stream ends (the run path has
      // no durable assistant envelope to reconcile it).
      if (state !== undefined && state.liveBlockIndex !== null) {
        const index = state.liveBlockIndex
        const block = transcript[index]
        if (block?.kind === "assistant" && block.streaming === true) {
          transcript = transcript.map((entry, at) => (at === index ? { ...entry, revision: revision + 1, streaming: false } : entry))
          noteReplaceAt(index)
        }
      }
      streams.delete(input.streamId)
      bump()
    },
    applyDurable(input) {
      if (!isDurableInput(input)) return false
      if (input.revision <= durableWatermark) return false
      durableWatermark = input.revision
      // An associated durable assistant response reconciles the live block
      // for the same run turn in place; the final payload wins unless it is
      // empty and text is already visible (never erase visible content).
      if (input.kind === "assistant" && typeof input.runId === "string" && input.runId.length > 0 && Number.isFinite(input.turn)) {
        const at = transcript.findIndex((entry) => entry.kind === "assistant" && entry.runId === input.runId && entry.turn === input.turn)
        const existing = at >= 0 ? transcript[at] : undefined
        if (existing !== undefined && existing.kind === "assistant") {
          const finalText = stripAnsi(input.body)
          const body = finalText.trim().length === 0 && existing.body.trim().length > 0 ? existing.body : boundText(finalText)
          transcript = transcript.map((entry, index) =>
            index === at
              ? {
                  ...existing,
                  revision: input.revision,
                  body,
                  streaming: false,
                  ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
                }
              : entry,
          )
          noteReplaceAt(at)
          closeStreamAt(at)
          bump()
          return true
        }
      }
      // A suppressed user echo consumes its durable event; the optimistic
      // row already showing it stays as rendered.
      if (input.kind === "user" && suppressedUserMessages.delete(input.body)) return true
      // Optimistic claims: a pending user row is claimed by text (chip-form
      // echoes FIFO-claim the oldest pending row and keep their compact
      // text); a shell run-start goal claims its pending shell row.
      if (input.kind === "user" && claimPendingUser(input)) return true
      if (input.kind === "shell" && input.runId !== undefined && shellDurable(input.runId, input.body, input.shellPhase)) return true
      // A first-seen durable assistant response with no visible text (a
      // tool-only turn) parks no empty row (legacy first-append guard).
      if (input.kind === "assistant" && stripAnsi(input.body).trim().length === 0) return true
      appendBlock({
        kind: input.kind,
        revision: input.revision,
        body: boundText(input.kind === "assistant" ? stripAnsi(input.body) : input.body),
        ...(input.kind === "user" && input.inputId !== undefined ? { inputId: input.inputId } : {}),
        ...(input.kind === "user" && input.acceptedAt !== undefined ? { acceptedAt: input.acceptedAt } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.kind !== "assistant"
          ? {}
          : {
              ...(input.turn !== undefined ? { turn: input.turn } : {}),
              ...(input.streaming !== undefined ? { streaming: input.streaming } : {}),
              ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
            }),
      })
      bump()
      return true
    },
    applyTool(input) {
      if (!isToolApplyInput(input)) return
      if (input.revision <= durableWatermark) return
      durableWatermark = input.revision
      const drained = {
        finalInput: pendingToolFinalInputs.get(input.toolUseId),
        bufferedPartial: pendingToolInputs.get(input.toolUseId),
        bufferedOutput: pendingToolOutputs.get(input.toolUseId),
      }
      dropPendingToolStream(input.toolUseId)
      const index = toolIndexes.get(input.toolUseId)
      const previous = index === undefined ? undefined : transcript[index]
      if (previous !== undefined && previous.kind === "tool") {
        transcript = transcript.map((entry, at) =>
          at === index ? mergedToolBlock(previous, input, input.revision, previous?.sourceId ?? mintSourceId(), drained) : entry,
        )
        noteReplaceAt(index)
        bump()
        return
      }
      toolIndexes.set(input.toolUseId, appendBlock(mergedToolBlock(null, input, input.revision, mintSourceId(), drained)))
      bump()
    },
    replace(input) {
      if (!isReplaceInput(input)) return
      // Snapshot adoption opens a new identity generation: re-minted ids
      // must not collide with ledger marks keyed to the previous
      // generation.
      sourceGeneration += 1
      transcript = input.transcript.map((block) => ({ ...block, sourceId: mintSourceId() }) as TranscriptBlock)
      pending = input.pending.map((run) => ({ ...run }))
      // A snapshot error lands only when it outlives the current durable
      // watermark, exactly once per (revision, message) fact.
      const snapshotError = input.lastError
      if (
        snapshotError !== undefined &&
        typeof snapshotError.message === "string" &&
        snapshotError.message.length > 0 &&
        Number.isFinite(snapshotError.revision) &&
        durableWatermark < snapshotError.revision
      ) {
        const key = `${snapshotError.revision}:${snapshotError.message}`
        if (!seenSnapshotErrors.has(key)) {
          seenSnapshotErrors.add(key)
          // Keys accumulate only across distinct adoption snapshots; the
          // cap bounds that dedupe memory, evicting the oldest key first.
          while (seenSnapshotErrors.size > MAX_SNAPSHOT_ERRORS) {
            seenSnapshotErrors.delete(seenSnapshotErrors.values().next().value!)
          }
          transcript = [
            ...transcript,
            { kind: "error", revision: input.revision, body: boundText(snapshotError.message) } as TranscriptBlock,
          ]
        }
      }
      durableWatermark = Math.max(durableWatermark, input.revision)
      streams.clear()
      clearPendingToolStreams()
      // Session adoption resets optimistic state (legacy reset()).
      pendingUserIndexes.length = 0
      pendingShellIndexes.length = 0
      pendingShellRuns.clear()
      closedShellIndexes.clear()
      shellRuns.clear()
      shellRunAliases.clear()
      closedShellRuns.clear()
      closedShellRunOrder.length = 0
      shellClaimFence = false
      suppressedUserMessages.clear()
      rebuildToolIndexes()
      trimOverflow()
      revision = Math.max(revision + 1, input.revision)
      snapshot = freeze({ projectionRevision: revision, transcript, pending })
      mintReset(revision)
    },
    reset() {
      // Session adoption opens a new identity generation.
      sourceGeneration += 1
      transcript = []
      pending = []
      streams.clear()
      clearPendingToolStreams()
      pendingUserIndexes.length = 0
      pendingShellIndexes.length = 0
      pendingShellRuns.clear()
      closedShellIndexes.clear()
      shellRuns.clear()
      shellRunAliases.clear()
      closedShellRuns.clear()
      closedShellRunOrder.length = 0
      shellClaimFence = false
      suppressedUserMessages.clear()
      seenSnapshotErrors.clear()
      durableWatermark = 0
      rebuildToolIndexes()
      revision += 1
      snapshot = freeze({ projectionRevision: revision, transcript, pending })
      mintReset(revision)
    },
    rebase(baseRevision) {
      if (!Number.isFinite(baseRevision)) return
      const live = liveIndices()
      // Non-terminal tool blocks are unfinalized projection state: durable
      // replay after a resync rebuilds them, so they drop like live tails.
      // Surviving rows shift down with the filter; every tracker remaps.
      const kept: TranscriptBlock[] = []
      const shifts = new Map<number, number>()
      for (let index = 0; index < transcript.length; index += 1) {
        const block = transcript[index]!
        const survives =
          block.revision <= baseRevision && !live.has(index) && !(block.kind === "tool" && !isTerminalToolStatus(block.status))
        if (!survives) continue
        shifts.set(index, kept.length)
        kept.push(block)
      }
      noteCutRanges(shifts, transcript.length)
      transcript = kept
      pending = []
      streams.clear()
      clearPendingToolStreams()
      // Rewind keeps suppressions (legacy rollbackTo) but drops optimistic
      // trackers and shell-run associations past the surviving tail.
      const remap = (values: number[]): void => {
        let write = 0
        for (const index of values) {
          const shifted = shifts.get(index)
          if (shifted !== undefined) values[write++] = shifted
        }
        values.length = write
      }
      remap(pendingUserIndexes)
      remap(pendingShellIndexes)
      remapIndexMap(pendingShellRuns, shifts)
      remapIndexSet(closedShellIndexes, shifts)
      for (const [key, index] of shellRuns) {
        const shifted = shifts.get(index)
        if (shifted === undefined) {
          shellRuns.delete(key)
          dropShellAliases(key)
        } else shellRuns.set(key, shifted)
      }
      rebuildToolIndexes()
      bump()
    },
    appendLocal(kind, body) {
      if (!TEXT_BLOCK_KINDS.includes(kind) || typeof body !== "string") return
      appendBlock({ kind, revision: revision + 1, body: boundText(body) })
      bump()
    },
    appendPendingUser(text) {
      if (typeof text !== "string" || text.length === 0) return
      pendingUserIndexes.push(appendBlock({ kind: "user", revision: revision + 1, body: boundText(text) }))
      bump()
    },
    appendPendingShell(command, runId) {
      if (typeof command !== "string" || command.length === 0) return
      const index = appendBlock({ kind: "shell", revision: revision + 1, body: boundText(`! ${command}`) })
      pendingShellIndexes.push(index)
      if (typeof runId === "string" && runId.length > 0) pendingShellRuns.set(runId, index)
      bump()
    },
    settleShellRun,
    associateShellRun,
    fenceShellBodyClaims() {
      shellClaimFence = true
    },
    suppressUserMessage(text) {
      if (typeof text !== "string" || text.length === 0) return
      suppressedUserMessages.add(text)
      // Marks are spent one-shot at their durable echo; an echo that
      // never arrives leaves the body parked, so the cap bounds the
      // leak (insertion order evicts the oldest parked body first).
      while (suppressedUserMessages.size > MAX_SUPPRESSED_USER_MESSAGES) {
        suppressedUserMessages.delete(suppressedUserMessages.values().next().value!)
      }
    },
    removeRun(runId) {
      if (typeof runId !== "string" || runId.length === 0) return
      const pendingShellKeys = shellRelatedRunIds(runId)
      const hadPendingShellOutput = [...pendingShellKeys].some((key) => pendingShellOutputs.has(key))
      for (const key of pendingShellKeys) dropPendingShellOutput(key)
      // Optimistic rows and shell rows carry no run identity and survive.
      const kept: TranscriptBlock[] = []
      const shifts = new Map<number, number>()
      for (let index = 0; index < transcript.length; index += 1) {
        const block = transcript[index]!
        const belongs = (block.kind === "assistant" && block.runId === runId) || (block.kind === "tool" && block.runId === runId)
        if (belongs) continue
        shifts.set(index, kept.length)
        kept.push(block)
      }
      if (
        kept.length === transcript.length &&
        !streams.has(runId) &&
        !shellRuns.has(runId) &&
        !pending.some((run) => run.runId === runId) &&
        !hadPendingShellOutput
      ) {
        return
      }
      noteCutRanges(shifts, transcript.length)
      transcript = kept
      const remap = (values: number[]): void => {
        let write = 0
        for (const index of values) {
          const shifted = shifts.get(index)
          if (shifted !== undefined) values[write++] = shifted
        }
        values.length = write
      }
      remap(pendingUserIndexes)
      remap(pendingShellIndexes)
      remapIndexMap(pendingShellRuns, shifts)
      remapIndexSet(closedShellIndexes, shifts)
      for (const [key, index] of shellRuns) {
        const shifted = shifts.get(index)
        if (shifted === undefined) {
          shellRuns.delete(key)
          dropShellAliases(key)
        } else shellRuns.set(key, shifted)
      }
      // Other runs' live tails shift with the splice; a removed live block
      // re-promotes as a fresh block on its next delta.
      for (const state of streams.values()) {
        if (state.liveBlockIndex === null) continue
        const shifted = shifts.get(state.liveBlockIndex)
        state.liveBlockIndex = shifted ?? null
      }
      streams.delete(runId)
      shellRuns.delete(runId)
      dropShellAliases(runId)
      pending = pending.filter((run) => run.runId !== runId)
      rebuildToolIndexes()
      bump()
    },
    abandonRunTools(runId) {
      if (typeof runId !== "string" || runId.length === 0) return
      for (const key of shellRelatedRunIds(runId)) dropPendingShellOutput(key)
      // Non-terminal tool blocks are unfinalized projection state — the
      // cancelled or failed run never sends their terminal upsert — so they
      // drop instead of parking in the mutable tail forever. Terminal tool
      // blocks, text rows, and other runs' blocks survive.
      const kept: TranscriptBlock[] = []
      const shifts = new Map<number, number>()
      for (let index = 0; index < transcript.length; index += 1) {
        const block = transcript[index]!
        const belongs = block.kind === "tool" && block.runId === runId && !isTerminalToolStatus(block.status)
        if (belongs) continue
        shifts.set(index, kept.length)
        kept.push(block)
      }
      if (kept.length === transcript.length) return
      noteCutRanges(shifts, transcript.length)
      transcript = kept
      const remap = (values: number[]): void => {
        let write = 0
        for (const index of values) {
          const shifted = shifts.get(index)
          if (shifted !== undefined) values[write++] = shifted
        }
        values.length = write
      }
      remap(pendingUserIndexes)
      remap(pendingShellIndexes)
      remapIndexMap(pendingShellRuns, shifts)
      remapIndexSet(closedShellIndexes, shifts)
      for (const [key, index] of shellRuns) {
        const shifted = shifts.get(index)
        if (shifted === undefined) {
          shellRuns.delete(key)
          dropShellAliases(key)
        } else shellRuns.set(key, shifted)
      }
      // Live tails shift with the splice; a removed live block re-promotes
      // as a fresh block on its next delta.
      for (const state of streams.values()) {
        if (state.liveBlockIndex === null) continue
        const shifted = shifts.get(state.liveBlockIndex)
        state.liveBlockIndex = shifted ?? null
      }
      rebuildToolIndexes()
      bump()
    },
    rollbackTo(checkpoint, runId) {
      if (!Number.isFinite(checkpoint)) return
      const safe = Math.max(0, Math.min(transcript.length, Math.floor(checkpoint)))
      if (
        safe === transcript.length &&
        runId === undefined &&
        streams.size === 0 &&
        pendingToolStreamOrder.length === 0 &&
        pendingShellOutputOrder.length === 0
      )
        return
      const lengthBefore = transcript.length
      transcript = transcript.slice(0, safe)
      if (safe < lengthBefore) note({ kind: "truncate", from: safe, to: lengthBefore, throughEnd: true })
      const prune = (values: number[]): void => {
        let write = 0
        for (const index of values) {
          if (index < safe) values[write++] = index
        }
        values.length = write
      }
      prune(pendingUserIndexes)
      prune(pendingShellIndexes)
      pruneIndexMap(pendingShellRuns, safe)
      pruneIndexSet(closedShellIndexes, safe)
      for (const [key, index] of shellRuns) {
        if (index >= safe) {
          shellRuns.delete(key)
          dropShellAliases(key)
        }
      }
      // The slice only removes the tail: any live block past the checkpoint
      // is gone and its fence entry must not dangle at a regrowing index.
      for (const state of streams.values()) {
        if (state.liveBlockIndex !== null && state.liveBlockIndex >= safe) state.liveBlockIndex = null
      }
      if (typeof runId === "string" && runId.length > 0) {
        streams.delete(runId)
        shellRuns.delete(runId)
        dropShellAliases(runId)
        pending = pending.filter((run) => run.runId !== runId)
      }
      clearPendingToolStreams()
      rebuildToolIndexes()
      bump()
    },
    clear() {
      if (
        transcript.length === 0 &&
        pending.length === 0 &&
        streams.size === 0 &&
        pendingToolStreamOrder.length === 0 &&
        pendingShellOutputOrder.length === 0
      )
        return
      const lengthBefore = transcript.length
      transcript = []
      if (lengthBefore > 0) note({ kind: "truncate", from: 0, to: lengthBefore, throughEnd: true })
      pending = []
      streams.clear()
      clearPendingToolStreams()
      pendingUserIndexes.length = 0
      pendingShellIndexes.length = 0
      pendingShellRuns.clear()
      closedShellIndexes.clear()
      shellRuns.clear()
      shellRunAliases.clear()
      closedShellRuns.clear()
      closedShellRunOrder.length = 0
      // A cleared view forgets which snapshot errors were already shown.
      seenSnapshotErrors.clear()
      bump()
    },
    sealStream(streamId, marker) {
      if (typeof streamId !== "string" || streamId.length === 0) return
      const state = streams.get(streamId)
      if (state === undefined) return
      let changed = false
      if (state.liveBlockIndex !== null && typeof marker === "string" && marker.length > 0) {
        transcript = transcript.map((entry, index) =>
          index === state.liveBlockIndex ? { ...entry, revision: revision + 1, body: appendBoundedText(entry.body, marker) } : entry,
        )
        noteReplaceAt(state.liveBlockIndex)
        changed = true
      }
      const pendingBefore = pending.length
      pending = pending.filter((run) => run.runId !== streamId)
      streams.delete(streamId)
      // A fence-only stream (tool traffic only, never a text block, no
      // pending run) seals without an observable change: deregistering
      // it alone must not mint a phantom revision for the store to
      // re-poll into a same-content commit.
      if (changed || pending.length !== pendingBefore) bump()
    },
    finalizeAssistant(input) {
      if (!isRunFinalizeInput(input)) return
      const visible = stripAnsi(input.text)
      if (visible.trim().length === 0) return
      const at = transcript.findIndex((entry) => entry.kind === "assistant" && entry.runId === input.runId && entry.turn === input.turn)
      const existing = at >= 0 ? transcript[at] : undefined
      if (existing !== undefined && existing.kind === "assistant") {
        // Settled turns keep their text; only streaming or empty blocks adopt.
        if (existing.streaming === true || existing.body.trim().length === 0) {
          transcript = transcript.map((entry, index) =>
            index === at ? { ...existing, revision: revision + 1, body: boundText(visible), streaming: false } : entry,
          )
          noteReplaceAt(at)
          closeStreamAt(at)
          bump()
        }
        return
      }
      appendBlock({
        kind: "assistant",
        revision: revision + 1,
        body: boundText(visible),
        runId: input.runId,
        turn: input.turn,
        streaming: false,
      })
      bump()
    },
  }
}

function freeze(content: SessionContent): SessionContent {
  return Object.freeze({
    ...content,
    transcript: Object.freeze([...content.transcript]),
    pending: Object.freeze([...content.pending]),
  })
}
