/**
 * The kernel entry: the composition root that binds the session host,
 * the projection pump, the command executor and the kernel into one
 * assembly. Every kernel probe closes over the host's mirror getters
 * and the projection holder, so adjudication always reads live facts;
 * the executor reaches the host through a second mutable holder
 * because it must exist before the host does. The workspace diff
 * adapter lives here and nowhere else — the port's file shape maps to
 * the mirror's view shape in this one place.
 */
import { createTuiKernel, type TuiKernel, type TuiKernelPorts } from "../ui/tui/kernel/index.js"
import type { CompletionItem } from "../ui/tui/kernel/fields/index.js"
import { THEME_IDS } from "../ui/tui/text/index.js"
import type { TuiSessionProjection } from "../ui/tui/sessionprojection/index.js"
import { createTuiCommandExecutor, type TuiMirrorFileView, type TuiResumeSessionView } from "./tui-command-executor.js"
import type { TuiChildDecisionSeam } from "./child-decision-surface.js"
import { createTuiProjectionPump, mailboxPreviewRow, planPreviewRow } from "./tui-projection-pump.js"
import { createTuiSessionHost, type TuiSessionHost, type TuiSessionHostOptions } from "./tui-session-host.js"
import type { TuiPreferencesCoordinator } from "./tui-preferences.js"

/** The entrypoint's completion vocabulary source; re-exported for the CLI's workspace reader. */
export type { CompletionItem }

type FieldsKit = TuiKernelPorts["fields"]
type ReadingKit = TuiKernelPorts["reading"]
type TranscriptKit = TuiKernelPorts["transcript"]
type CompletionSources = ReturnType<TuiKernelPorts["completion"]>

/** One workspace file's diff facts as the diff source reports them. */
export interface SlashWorkspaceDiffFile {
  readonly path: string
  readonly untracked: boolean
  readonly binary: boolean
  readonly additions: number
  readonly deletions: number
  readonly truncated: boolean
  readonly diff: string
}

export interface TuiEntryOptions {
  readonly createSession: TuiSessionHostOptions["createSession"]
  readonly workspaceId?: string
  /** The authorized workspace root path the permission disclosure names; absent reports none. */
  readonly workspaceRoot?: string
  /** Preference coordinator instance built by the composition root; the entry never sees the config path. */
  readonly preferences: TuiPreferencesCoordinator
  readonly completion?: CompletionSources
  /** Process-local view and persistence for composer prompt history. */
  readonly promptHistory?: {
    snapshot(): readonly { readonly id: string; readonly text: string; readonly submittedAt: string }[]
    add(value: string): Promise<void>
  }
  /** Kit injections; absent means the kernel's built-in wiring. */
  readonly fields?: FieldsKit
  readonly reading?: ReadingKit
  readonly transcript?: TranscriptKit
  /** Working-tree facts for the diff browser; absent keeps the browser honest and empty. */
  readonly diffFiles?: {
    files(signal?: AbortSignal): Promise<readonly SlashWorkspaceDiffFile[]> | readonly SlashWorkspaceDiffFile[]
  }
  /** Resumable session rows as the entrypoint maps them from the catalog; required. */
  readonly resumeSessions: (query: {
    readonly excludeSessionId: string | null
    readonly signal?: AbortSignal
  }) => Promise<readonly TuiResumeSessionView[]> | readonly TuiResumeSessionView[]
  /** Persist the first accepted prompt as a title when the session has none. */
  readonly setSessionTitleIfAbsent?: (sessionId: string, title: string) => Promise<void>
  /** Refuses a resume whose target no longer exists; runs before the host adopts a session. */
  readonly resumeGate: (sessionId: string) => Promise<void>
  /**
   * Child card seam: child tokens settle on it ahead of the session
   * guard, and every session switch sweeps the raised cards and
   * releases the survivors once the new binding settled.
   */
  readonly childDecisions?: TuiChildDecisionSeam
  /** Child cancel lever over the process-scoped registry; absent or false reports a failed command. */
  readonly cancelChild?: (childId: string) => boolean
  /** Provider identity probe for read-only diagnostics; absent reports only available session facts. */
  readonly provider?: () => { label: string | null; modelName?: string | null; endpoint?: string | null; protocol?: string | null }
  readonly onExit?: () => void
  readonly onFatal?: (reason: string) => void
  readonly capacity?: { readonly viewStateBytes: number }
}

export interface TuiEntry {
  readonly kernel: TuiKernel
  readonly host: TuiSessionHost
  start(input: { readonly sessionId: string }): Promise<void>
  switchSession(sessionId: string): Promise<void>
  teardown(): Promise<void>
}

const toMirrorFiles = (files: readonly SlashWorkspaceDiffFile[]): readonly TuiMirrorFileView[] =>
  files.map((file) => ({
    path: file.path,
    description: file.binary ? "binary" : file.untracked ? "untracked" : `+${file.additions} -${file.deletions}`,
    ...(file.diff.length === 0 ? {} : { detail: file.truncated ? [...file.diff.split("\n"), "diff truncated"] : file.diff.split("\n") }),
  }))

/** The card row's preview: the body folded to one line, bounded to keep the picker scannable. */
const rewindCheckpointLabel = (body: string): string => {
  const folded = body.replaceAll(/\s+/g, " ").trim()
  return folded.length > 72 ? `${folded.slice(0, 71)}…` : folded
}

export function createTuiEntry(options: TuiEntryOptions): TuiEntry {
  const holder: { reader: TuiSessionProjection | null } = { reader: null }
  const hostRef: { host: TuiSessionHost | null } = { host: null }

  const kernel = createTuiKernel({
    sessionFacts: () => ({
      sessionId: hostRef.host?.origin()?.sessionId ?? null,
      workspaceId: options.workspaceId ?? null,
    }),
    permission: () => {
      const host = hostRef.host
      const mode = host?.probes.permissionMode() ?? null
      if (mode === null) return null
      const selectableModes = host?.probes.selectableModes() ?? []
      return {
        currentMode: mode,
        selectableModes,
        // The selectable set already excludes auto without a Guardian,
        // so membership is the availability probe.
        guardianAvailable: selectableModes.includes("auto"),
        // The host feed drops malformed rows, so the enum narrows here —
        // the one adapter point between the host and kernel vocabularies.
        rules: (host?.probes.permissionRules() ?? []).flatMap((rule) =>
          rule.behavior === "allow" || rule.behavior === "ask" || rule.behavior === "deny"
            ? [{ name: rule.name, behavior: rule.behavior }]
            : [],
        ),
        directories: host?.probes.additionalDirectories() ?? [],
        workspaceRoot: options.workspaceRoot ?? null,
        deniedLedger: host?.probes.deniedLedger() ?? [],
      }
    },
    // Rewind checkpoints are the transcript's user rows: the checkpoint
    // id is the accepted input's id, the same identity the rewind port
    // takes. Newest first, with accepted time beside the preview; the
    // restored draft comes back from the canonical rewind.
    history: () => ({
      rewindCheckpoints:
        holder.reader
          ?.content()
          .transcript.flatMap((block) =>
            block.kind === "user" && block.inputId !== undefined && block.inputId.length > 0
              ? [
                  {
                    checkpoint: block.inputId,
                    label: rewindCheckpointLabel(block.body),
                    ...(block.acceptedAt === undefined ? {} : { acceptedAt: block.acceptedAt }),
                  },
                ]
              : [],
          )
          .reverse() ?? [],
    }),
    theme: () => ({ committedThemeId: options.preferences.committedTheme(), themeIds: THEME_IDS }),
    ...(options.promptHistory === undefined ? {} : { promptHistory: () => options.promptHistory?.snapshot() ?? [] }),
    completion: () => options.completion ?? {},
    provider: options.provider,
    context: () => hostRef.host?.probes.context() ?? null,
    io: () => ({ degraded: hostRef.host?.probes.degraded() ?? false }),
    fields: options.fields,
    reading: options.reading,
    transcript: options.transcript,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  })

  const pump = createTuiProjectionPump({
    reader: () => holder.reader,
    dispatch: (input) => kernel.dispatch(input),
    origin: () => hostRef.host?.origin() ?? null,
  })

  const executor = createTuiCommandExecutor({
    session: () => hostRef.host?.session() ?? null,
    origin: () => hostRef.host?.origin() ?? null,
    activeRun: () => kernel.snapshot().runSlot.runId,
    degraded: () => hostRef.host?.probes.degraded() ?? false,
    theme: options.preferences.port,
    diffFiles: async (signal) => {
      if (options.diffFiles === undefined) throw new Error("No workspace diff source is wired")
      return toMirrorFiles(await options.diffFiles.files(signal))
    },
    switchSession: (sessionId) => {
      const host = hostRef.host
      if (host === null) return Promise.reject(new Error("No session host is bound to switch"))
      return host.switchSession(sessionId)
    },
    resumeSessions: options.resumeSessions,
    ...(options.setSessionTitleIfAbsent === undefined ? {} : { setSessionTitleIfAbsent: options.setSessionTitleIfAbsent }),
    ...(options.promptHistory === undefined ? {} : { onPromptHistory: (text: string) => void options.promptHistory?.add(text) }),
    ...(options.childDecisions === undefined ? {} : { childDecisions: options.childDecisions }),
    ...(options.cancelChild === undefined ? {} : { cancelChild: options.cancelChild }),
    dispatch: (input) => kernel.dispatch(input),
    onExit: () => options.onExit?.(),
  })
  kernel.onCommand((command) => executor.execute(command))

  // The queued-mailbox and plan mirrors ride the same cadence as the
  // projection push: admission, consumption, cancellation and plan
  // transitions all land as applied batches, and the kernel dedups a
  // repeat fact into no revision.
  const pushQueueMirror = (): void => {
    const rows = (hostRef.host?.mailboxQueued() ?? []).map(mailboxPreviewRow).flatMap((row) => (row === null ? [] : [row]))
    kernel.dispatch({ kind: "mirror", fact: { source: "queue", rows } })
  }

  const pushPlanMirror = (): void => {
    const rows = (hostRef.host?.planSummaries() ?? []).map(planPreviewRow)
    kernel.dispatch({ kind: "mirror", fact: { source: "plan", rows } })
  }

  const host = createTuiSessionHost({
    createSession: options.createSession,
    dispatch: (input) => kernel.dispatch(input),
    resumeGate: options.resumeGate,
    // The authoritative first push: backlog adoption happens inside
    // session start and can precede this callback, so the full push
    // covers facts an onApplied before the holder existed already lost.
    onProjection: (reader) => {
      holder.reader = reader
      pump.reset()
      pump.push()
      pushQueueMirror()
      pushPlanMirror()
    },
    onApplied: () => {
      pump.push()
      pushQueueMirror()
      pushPlanMirror()
    },
    ...(options.childDecisions === undefined ? {} : { childDecisions: options.childDecisions }),
    ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
  })
  hostRef.host = host

  return {
    kernel,
    host,
    start: (input) => host.attach({ sessionId: input.sessionId }),
    switchSession: (sessionId) => host.switchSession(sessionId),
    async teardown() {
      holder.reader = null
      pump.reset()
      await host.teardown()
    },
  }
}
