import { JsonRpcAppServerClient, type AppServerTransport } from "@ag2cli/app-server-client/client.js"
import { APP_SERVER_PROTOCOL_VERSION, type JsonRpcMessage, type JsonValue } from "@ag2cli/app-server-protocol/types.js"
import type { BrowserConnector } from "./browser-client"

type RecordValue = { [key: string]: JsonValue }
type DemoSessionEvent = RecordValue & {
  eventId: string
  sessionId: string
  revision: number
  timestamp: string
  type: string
  criticality: string
}
type DemoInput = {
  inputId: string
  commandId: string
  kind: "prompt" | "notification" | "steer"
  status: "queued" | "consumed" | "cancelled"
  text: string
  acceptedAt: string
  runId?: string
}
type DemoPolicy = {
  mode: string
  policyRevision: number
  rules: string[]
  selectableModes: string[]
}
type DemoPlanStep = { order: number; title: string; status: "pending" | "blocked" | "ready" }
type DemoPlan = {
  planId: string
  title: string
  status: "proposed" | "active" | "completed" | "abandoned"
  totalSteps: number
  completedSteps: number
  steps: DemoPlanStep[]
  updatedAt: string
}
type DemoSession = {
  sessionId: string
  title: string
  workspaceId: string
  updatedAt: string
  events: DemoSessionEvent[]
  inputs: DemoInput[]
  notified: boolean
  policy: DemoPolicy
  plans: DemoPlan[]
}
type DemoWorkspaceFile = {
  path: string
  kind: "text" | "binary"
  content?: string
  sizeBytes?: number
}
type DemoWorkspaceChange = {
  operation: "add" | "delete" | "modify" | "move" | "copy"
  path: string
  oldPath?: string
  fileKind: "text" | "binary" | "symlink" | "directory" | "unknown"
  additions?: number
  deletions?: number
  truncated: boolean
  gitPatch?: string
}
type DemoShellTask = {
  taskId: string
  kind: "shell" | "user_shell"
  title: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  chunks: { sequence: number; text: string }[]
  timeoutMs?: number
}

const toWireInput = (input: DemoInput): RecordValue => ({
  inputId: input.inputId,
  commandId: input.commandId,
  kind: input.kind,
  status: input.status,
  acceptedAt: input.acceptedAt,
  text: input.text,
  ...(input.runId === undefined ? {} : { runId: input.runId }),
})

const toWirePlan = (plan: DemoPlan): RecordValue => ({
  planId: plan.planId,
  title: plan.title,
  status: plan.status,
  totalSteps: plan.totalSteps,
  completedSteps: plan.completedSteps,
  steps: plan.steps.map((step) => ({ ...step })),
  updatedAt: plan.updatedAt,
})

class DemoRpcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message)
  }
}

const toWireWorkspaceChange = (change: DemoWorkspaceChange, includePatch: boolean): RecordValue => ({
  operation: change.operation,
  path: change.path,
  ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
  fileKind: change.fileKind,
  ...(change.additions === undefined ? {} : { additions: change.additions }),
  ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
  truncated: change.truncated,
  ...(includePatch && change.gitPatch !== undefined ? { gitPatch: change.gitPatch } : {}),
})

const timestamp = "2026-10-05T08:00:00.000Z"
const hostId = `ag2cli-host.v1.${"A".repeat(43)}`
const workspace = { workspaceId: "demo-workspace", workspaceRoot: "/projects/ag2cli", availability: "available" }
// Seeded policies start at revision 1 so the seeded approval's captured
// policyRevision matches until a mode write bumps it (§13 CAS).
const seedPolicy = (): DemoPolicy => ({
  mode: "manual",
  policyRevision: 1,
  rules: [],
  selectableModes: ["manual", "accept-edits", "plan", "full-access"],
})
const reply =
  "Here is a practical starting point:\n\n- Keep the conversation focused on one task.\n- Review changes before applying them.\n- Verify the result with a targeted test.\n\n```ts\nconst result = await client.send(message)\n```\n\nWhat would you like to explore next?"

const CRITICALITY_BY_TYPE: Record<string, string> = {
  "input.accepted": "critical",
  "input.updated": "critical",
  "input.failed": "critical",
  "run.updated": "critical",
  "message.upserted": "critical",
  "tool_call.upserted": "critical",
  "interaction.requested": "critical",
  "interaction.resolved": "critical",
  "security.updated": "critical",
  "session.archived": "critical",
  "plan.updated": "informational",
  "task.updated": "informational",
  "background_task.updated": "informational",
  "session.title.updated": "informational",
}

// An event type no shipped parser knows; injected with critical criticality
// so clients must treat it as unknown-critical vocabulary.
const UNKNOWN_EVENT_TYPE = "mock.future.critical"

/** Capability gates for degradation tests: each flag removes the matching
 * advertised capability (contract §5) so clients render their degraded faces
 * while the server keeps sending the underlying data. */
export interface MockCapabilityGates {
  readonly steer?: boolean
  readonly cancelInput?: boolean
  readonly askUser?: boolean
  readonly permissionModes?: readonly string[]
  readonly workspaceDiff?: boolean
  readonly workspaceReadFile?: boolean
  /** Removes `workspace:read` from the connection scopes while the
   * capabilities stay advertised — the use-time `scope_denied` face. */
  readonly workspaceScope?: boolean
  /** Removes `execution.explicitShell` from the advertised capabilities and
   * the session method list — the hidden-entry degradation face. */
  readonly shellExecute?: boolean
  /** Removes `shell:execute` from the connection scopes while the capability
   * stays advertised — the use-time `scope_denied` face. */
  readonly shellScope?: boolean
}

export interface MockAppServerOptions {
  /** Splits session.replay responses into continuation pages of this size;
   * the default serves the whole remaining history as one page. */
  readonly replayPageSize?: number
}

/** Exercise the public RPC client and its validators without requiring a running host.
 * All connections to one mock share the session state and the event broadcast,
 * so multi-client races resolve against a single canonical history. */
export function createMockAppServer(
  gates: MockCapabilityGates = {},
  options: MockAppServerOptions = {},
): {
  connector: BrowserConnector
  /** Server-driven expiry: closes the ask and fails its run without any client. */
  expireInteraction(sessionId: string, interactionId: string): void
  /** Server-directed resync trigger: broadcasts session.resyncRequired to every
   * connected client with the protocol's four-reason vocabulary. */
  triggerResync(sessionId: string, reason: "queue_overflow" | "restart" | "rewind" | "history_unavailable"): void
  /** Appends an event type outside the shipped parser vocabulary — durable by
   * default, live-only when durable is false — exercising the unknown-critical
   * intake and the rebuild that follows it. */
  injectUnknownEvent(sessionId: string, durable?: boolean): void
  /** Drops injected unknown events, restoring a projectable lineage. */
  clearUnknownEvents(sessionId: string): void
  /** Server-side workspace edit: bumps the snapshot token so outstanding
   * diff cursors and file digests fail with workspace_changed, and appends a
   * change entry plus a content line to the seeded file. */
  mutateWorkspace(): void
} {
  const sessionMethods = [
    "session.list",
    "session.create",
    "session.attach",
    "session.replay",
    "session.resync",
    "session.submit",
    "session.steer",
    "session.cancelRun",
    "session.cancelInput",
    "session.resolveInteraction",
    "session.setPermissionMode",
    "session.getPermissionPolicy",
    "session.executeUserShell",
    "session.getTaskLogs",
    "session.cancelTask",
  ]
    .filter((method) => !(method === "session.steer" && gates.steer === false))
    .filter((method) => !(method === "session.cancelInput" && gates.cancelInput === false))
    .filter((method) => !(method === "session.executeUserShell" && gates.shellExecute === false))
  const permissionModes = gates.permissionModes ?? ["manual", "accept-edits", "plan", "full-access"]
  let runCounter = 0
  let planTick = 0
  const sessions = new Map<string, DemoSession>()
  // §14 connection-domain state: in-memory and per session; rosters and lease
  // holders expose only clientId/clientKind/name-level identity.
  const sessionClients = new Map<string, { clientId: string; clientKind: string; name: string; version: string }[]>()
  const leaseStates = new Map<
    string,
    { status: "available" | "held"; generation: number; holder?: { clientId: string; clientKind: string; name: string } }
  >()
  const replayPageSize = options.replayPageSize
  const resolvedInteractions = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const activeRuns = new Map<string, { session: DemoSession; commandId: string }>()
  // §12 workspace face: one demo tree plus a change list. The revision is the
  // snapshotToken; every mutation invalidates outstanding cursors and digests.
  let workspaceRevision = 0
  const workspaceFile = (path: string, lineCount: number): DemoWorkspaceFile => ({
    path,
    kind: "text",
    content: Array.from({ length: lineCount }, (_, index) => `${path} line ${index + 1}`).join("\n"),
  })
  const workspaceFiles = new Map<string, DemoWorkspaceFile>([
    ["src/app.tsx", workspaceFile("src/app.tsx", 240)],
    ["src/components/workspace-browser.tsx", workspaceFile("src/components/workspace-browser.tsx", 96)],
    ["src/lib/workspace-panel.tsx", workspaceFile("src/lib/workspace-panel.tsx", 40)],
    ["assets/logo.png", { path: "assets/logo.png", kind: "binary", sizeBytes: 4821 }],
    // Present in the tree but policy-denied: the refusal is about the path,
    // not the file's existence.
    [".env", workspaceFile(".env", 4)],
  ])
  let workspaceChanges: DemoWorkspaceChange[] = [
    {
      operation: "modify",
      path: "src/app.tsx",
      fileKind: "text",
      additions: 12,
      deletions: 4,
      truncated: false,
      gitPatch:
        "--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -12,7 +12,15 @@ export function App() {\n+  const [workspaceOpen, setWorkspaceOpen] = useState(false)\n+  const capabilities = sessionCapabilities(state.initialize?.capabilities)\n // eleven more added lines\n-foure removed lines",
    },
    {
      operation: "add",
      path: "src/components/workspace-browser.tsx",
      fileKind: "text",
      additions: 96,
      deletions: 0,
      truncated: false,
      gitPatch:
        "--- /dev/null\n+++ b/src/components/workspace-browser.tsx\n@@ -0,0 +1,96 @@\n+export function WorkspaceBrowser() {\n+  // ninety-four more added lines\n+}",
    },
    {
      operation: "move",
      path: "src/lib/workspace-panel.tsx",
      oldPath: "src/lib/panel.tsx",
      fileKind: "text",
      additions: 2,
      deletions: 2,
      truncated: false,
    },
    { operation: "add", path: "assets/logo.png", fileKind: "binary", additions: 0, deletions: 0, truncated: true },
    { operation: "delete", path: "src/old-panel.tsx", fileKind: "text", deletions: 88, truncated: false },
  ]
  const workspaceToken = (): string => `demo-workspace:${workspaceRevision}`
  const workspaceDigest = (path: string): string => `sha256:${path}:${workspaceRevision}`
  const workspaceSensitive = (path: string): boolean =>
    path.split("/").some((segment) => segment === ".git" || segment === ".env" || segment.startsWith(".env."))
  const workspaceSize = (file: DemoWorkspaceFile): number => file.content?.length ?? file.sizeBytes ?? 0
  const advertisedScopes = [
    "session:read",
    "session:write",
    ...(gates.workspaceScope === false ? [] : ["workspace:read"]),
    ...(gates.shellScope === false ? [] : ["shell:execute"]),
  ]
  const requireWorkspaceScope = (): void => {
    if (!advertisedScopes.includes("workspace:read"))
      throw new DemoRpcError("scope_denied", "This connection is not allowed to read the workspace")
  }
  // §11.8 shell face state: admitted tasks are the identity progress, output
  // and cancellation ride; a commandId maps to its task so retries read back
  // the first admission instead of spawning a second task.
  let taskCounter = 0
  const shellTasks = new Map<string, DemoShellTask>()
  const taskAdmissions = new Map<string, string>()
  const taskTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const requireShellScope = (): void => {
    if (!advertisedScopes.includes("shell:execute"))
      throw new DemoRpcError("scope_denied", "This connection is not allowed to run shell commands")
  }
  const toWireTask = (task: DemoShellTask): RecordValue => ({
    taskId: task.taskId,
    kind: task.kind,
    title: task.title,
    status: task.status,
    updatedAt: timestamp,
  })
  const messageListeners = new Set<(message: JsonRpcMessage) => void>()
  const emit = (message: JsonRpcMessage): void => {
    for (const listener of messageListeners) listener(message)
  }
  function append(session: DemoSession, type: string, payload: RecordValue): DemoSessionEvent {
    const revision = session.events.length + 1
    const event: DemoSessionEvent = {
      eventId: `${session.sessionId}:${revision}`,
      sessionId: session.sessionId,
      revision,
      timestamp,
      type,
      criticality: CRITICALITY_BY_TYPE[type] ?? "informational",
      ...payload,
    }
    session.events.push(event)
    return event
  }
  const event = (session: DemoSession, type: string, payload: RecordValue): void => {
    emit({ jsonrpc: "2.0", method: "session.event", params: { event: append(session, type, payload) } })
  }
  function seedConversation(): DemoSession {
    const seeded: DemoSession = {
      sessionId: "demo-conversation",
      title: "Explore your workspace",
      workspaceId: workspace.workspaceId,
      updatedAt: timestamp,
      events: [],
      inputs: [],
      notified: false,
      policy: seedPolicy(),
      plans: [],
    }
    // One retired plan in history plus one active plan: replay carries both,
    // while snapshot.activePlan points only at the live one.
    const retiredPlan: DemoPlan = {
      planId: "demo-plan-recce",
      title: "Initial reconnaissance",
      status: "completed",
      totalSteps: 2,
      completedSteps: 0,
      steps: [
        { order: 1, title: "List workspace roots", status: "ready" },
        { order: 2, title: "Read the README", status: "ready" },
      ],
      updatedAt: "2026-10-05T07:59:00.000Z",
    }
    const activePlan: DemoPlan = {
      planId: "demo-plan",
      title: "Harden the demo workspace",
      status: "active",
      totalSteps: 3,
      // The protocol has no step-completion lifecycle; the counter stays 0.
      completedSteps: 0,
      steps: [
        { order: 1, title: "Audit the seeded conversation", status: "ready" },
        { order: 2, title: "Draft the follow-up prompt", status: "pending" },
        { order: 3, title: "Verify the queued run", status: "pending" },
      ],
      updatedAt: "2026-10-05T08:00:00.000Z",
    }
    seeded.plans = [retiredPlan, activePlan]
    append(seeded, "plan.updated", { plan: toWirePlan(retiredPlan) })
    append(seeded, "plan.updated", { plan: toWirePlan(activePlan) })
    append(seeded, "session.title.updated", { title: seeded.title })
    append(seeded, "input.accepted", {
      input: {
        inputId: "demo-input",
        commandId: "demo-command",
        kind: "prompt",
        status: "queued",
        acceptedAt: timestamp,
        text: "How should we approach a new task?",
      },
    })
    append(seeded, "input.updated", {
      input: {
        inputId: "demo-input",
        commandId: "demo-command",
        kind: "prompt",
        status: "consumed",
        acceptedAt: timestamp,
        runId: "demo-run",
        text: "How should we approach a new task?",
      },
    })
    append(seeded, "message.upserted", {
      message: {
        messageId: "message:demo-input",
        role: "user",
        createdAt: timestamp,
        content: [{ type: "text", text: "How should we approach a new task?" }],
      },
    })
    append(seeded, "message.upserted", {
      message: {
        messageId: "response:demo-conversation:5",
        role: "assistant",
        runId: "demo-run",
        createdAt: timestamp,
        content: [{ type: "text", text: reply }],
      },
    })
    append(seeded, "run.updated", {
      run: { runId: "demo-run", status: "completed", turn: 1, startedAt: timestamp, phase: "thinking", completedAt: timestamp },
    })
    append(seeded, "interaction.requested", {
      interaction: {
        interactionId: "demo-conversation:7",
        sessionId: seeded.sessionId,
        runId: "demo-run",
        turn: 2,
        createdAt: timestamp,
        kind: "tool_approval",
        toolCallId: "demo-tool",
        title: "Bash",
        subject: { type: "command", command: "npm test", workspaceId: workspace.workspaceId, cwdRelative: "." },
        options: [
          { optionId: "approve_once", label: "Allow once", outcome: "approve_once" },
          { optionId: "deny", label: "Deny", outcome: "deny" },
        ],
        policyRevision: 1,
        scopeRevision: 3,
      },
    })
    return seeded
  }
  function seedAsk(): DemoSession {
    const seeded: DemoSession = {
      sessionId: "demo-ask",
      title: "Answer a question",
      workspaceId: workspace.workspaceId,
      updatedAt: timestamp,
      events: [],
      inputs: [
        {
          inputId: "ask-input",
          commandId: "ask-command",
          kind: "prompt",
          status: "consumed",
          text: "Set up the project storage",
          acceptedAt: timestamp,
          runId: "demo-ask-run",
        },
      ],
      notified: false,
      policy: seedPolicy(),
      plans: [],
    }
    append(seeded, "session.title.updated", { title: seeded.title })
    append(seeded, "input.accepted", { input: toWireInput({ ...seeded.inputs[0]!, status: "queued", runId: undefined }) })
    append(seeded, "input.updated", { input: toWireInput(seeded.inputs[0]!) })
    append(seeded, "run.updated", {
      run: { runId: "demo-ask-run", status: "running", turn: 1, startedAt: timestamp, phase: "thinking" },
    })
    append(seeded, "message.upserted", {
      message: {
        messageId: "message:ask-input",
        role: "user",
        createdAt: timestamp,
        content: [{ type: "text", text: "Set up the project storage" }],
      },
    })
    // The seeded ask pauses a genuinely running run; chat resolutions keep
    // it active, so follow-up prompts must queue behind it (§11.4).
    activeRuns.set("demo-ask-run", { session: seeded, commandId: "ask-command" })
    append(seeded, "interaction.requested", {
      interaction: {
        interactionId: "demo-ask:5",
        sessionId: seeded.sessionId,
        runId: "demo-ask-run",
        turn: 2,
        createdAt: timestamp,
        kind: "ask_user",
        questions: [
          {
            questionId: "storage",
            question: "Which storage should we use?",
            multiSelect: false,
            options: [
              { optionId: "postgres", label: "PostgreSQL", description: "Relational server" },
              { optionId: "sqlite", label: "SQLite", description: "Embedded file database" },
            ],
          },
          {
            questionId: "features",
            question: "Which features matter most?",
            multiSelect: true,
            options: [
              { optionId: "auth", label: "Authentication" },
              { optionId: "logging", label: "Structured logging" },
            ],
          },
        ],
      },
    })
    return seeded
  }
  sessions.set("demo-conversation", seedConversation())
  sessions.set("demo-ask", seedAsk())
  const summary = (session: DemoSession): RecordValue => ({
    sessionId: session.sessionId,
    title: session.title,
    status: session.events.some((item) => item.type === "run.updated" && (item.run as RecordValue | undefined)?.status === "completed")
      ? "completed"
      : "created",
    workspace: { workspaceId: session.workspaceId, displayName: "ag2cli", availability: "available" },
    updatedAt: session.updatedAt,
  })
  const pendingInteraction = (session: DemoSession, interactionId: string): RecordValue | undefined => {
    let found: RecordValue | undefined
    for (const item of session.events) {
      if (item.type === "interaction.requested" && String((item.interaction as RecordValue).interactionId) === interactionId)
        found = item.interaction as RecordValue
      if (item.type === "interaction.resolved" && String((item.resolution as RecordValue).interactionId) === interactionId)
        found = undefined
    }
    return found
  }
  const pendingInteractions = (session: DemoSession): JsonValue[] => {
    const found = new Map<string, RecordValue>()
    for (const item of session.events) {
      if (item.type === "interaction.requested") {
        const interaction = item.interaction as RecordValue
        found.set(String(interaction.interactionId), interaction)
      }
      if (item.type === "interaction.resolved") found.delete(String((item.resolution as RecordValue).interactionId))
    }
    return [...found.values()]
  }
  const activePlanOf = (session: DemoSession): RecordValue | undefined => {
    for (let index = session.plans.length - 1; index >= 0; index -= 1) {
      const plan = session.plans[index]!
      if (plan.status === "proposed" || plan.status === "active") return toWirePlan(plan)
    }
    return undefined
  }
  const snapshot = (session: DemoSession): RecordValue => {
    const activePlan = activePlanOf(session)
    return {
      ...summary(session),
      asOfRevision: session.events.length,
      foreground: { state: "idle" },
      workspace: { workspaceId: session.workspaceId, displayName: "ag2cli", availability: "available" },
      security: {
        permissionMode: session.policy.mode,
        policyRevision: session.policy.policyRevision,
        hasCustomRules: session.policy.rules.length > 0,
        selectableModes: session.policy.selectableModes,
      },
      inputs: session.inputs.map(toWireInput),
      pendingInteractions: pendingInteractions(session),
      activeTasks: [],
      ...(activePlan === undefined ? {} : { activePlan }),
    }
  }
  // Steers ride their target run: consumed when it completes, cancelled when
  // it is stopped, mirroring §11.4 terminal cleanup.
  const settleSteers = (session: DemoSession, runId: string, status: "consumed" | "cancelled"): void => {
    for (const item of session.inputs) {
      if (item.kind !== "steer" || item.status !== "queued" || item.runId !== runId) continue
      item.status = status
      event(session, "input.updated", { input: toWireInput(item) })
    }
  }
  const startRun = (session: DemoSession, input: DemoInput): string => {
    const runId = `demo-run-${++runCounter}`
    // A starting run drains queued notifications; prompts ride their own runs.
    for (const item of session.inputs) {
      if (item.kind !== "notification" || item.status !== "queued") continue
      item.status = "consumed"
      event(session, "input.updated", { input: toWireInput(item) })
    }
    input.runId = runId
    input.status = "consumed"
    event(session, "run.updated", {
      run: { runId, status: "running", turn: 1, startedAt: timestamp, phase: "thinking" },
    })
    event(session, "input.updated", { input: toWireInput(input) })
    event(session, "message.upserted", {
      message: {
        messageId: `message:${input.inputId}`,
        role: "user",
        createdAt: timestamp,
        content: [{ type: "text", text: input.text }],
      },
    })
    // A starting run refreshes informational plan tracking: the live plan gets
    // a later updatedAt and its next pending step becomes ready. Completion
    // counters stay untouched — there is no step-completion lifecycle to move.
    const livePlan = [...session.plans].reverse().find((plan) => plan.status === "proposed" || plan.status === "active")
    if (livePlan) {
      livePlan.updatedAt = new Date(Date.parse(timestamp) + ++planTick * 1000).toISOString()
      const nextStep = livePlan.steps.find((step) => step.status === "pending")
      if (nextStep) nextStep.status = "ready"
      event(session, "plan.updated", { plan: toWirePlan(livePlan) })
    }
    emit({
      jsonrpc: "2.0",
      method: "session.transient",
      params: {
        event: {
          eventId: `${runId}:live`,
          sessionId: session.sessionId,
          sequence: ++runCounter,
          kind: "model_text_delta",
          timestamp,
          runId,
          turn: 1,
          text: "Let me think through this…",
        },
      },
    })
    activeRuns.set(runId, { session, commandId: input.commandId })
    timers.set(
      input.commandId,
      setTimeout(() => {
        event(session, "message.upserted", {
          message: {
            messageId: `response:${runId}`,
            role: "assistant",
            runId,
            createdAt: timestamp,
            content: [{ type: "text", text: reply }],
          },
        })
        settleSteers(session, runId, "consumed")
        event(session, "run.updated", {
          run: { runId, status: "completed", turn: 1, startedAt: timestamp, phase: "thinking", completedAt: timestamp },
        })
        timers.delete(input.commandId)
        activeRuns.delete(runId)
        // Leftover prompts stay queued for the next run; the next run is the
        // one that admits them (§11.4).
        const next = session.inputs.find((item) => item.kind === "prompt" && item.status === "queued")
        if (next) startRun(session, next)
      }, 300),
    )
    return runId
  }
  const triggerResync = (sessionId: string, reason: "queue_overflow" | "restart" | "rewind" | "history_unavailable"): void => {
    const session = sessions.get(sessionId)
    if (!session) return
    emit({
      jsonrpc: "2.0",
      method: "session.resyncRequired",
      params: { sessionId, minimumRevision: Math.max(1, session.events.length), reason },
    })
  }
  const injectUnknownEvent = (sessionId: string, durable = true): void => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (!durable) {
      // Live-only vocabulary: no durable record, so a wholesale rebuild makes
      // the event vanish instead of degrading the session.
      emit({
        jsonrpc: "2.0",
        method: "session.event",
        params: {
          event: {
            eventId: `${sessionId}:live-unknown`,
            sessionId,
            revision: session.events.length + 1,
            timestamp,
            type: UNKNOWN_EVENT_TYPE,
            criticality: "critical",
            payload: { opaque: true },
          },
        },
      })
      return
    }
    event(session, UNKNOWN_EVENT_TYPE, { criticality: "critical", payload: { opaque: true } })
  }
  const clearUnknownEvents = (sessionId: string): void => {
    const session = sessions.get(sessionId)
    if (!session) return
    // Only trailing injections keep the stored revisions consistent with the
    // recomputed head; the demo contract is inject-then-clear in that order.
    session.events = session.events.filter((item) => item.type !== UNKNOWN_EVENT_TYPE)
  }
  const expireInteraction = (sessionId: string, interactionId: string): void => {
    const session = sessions.get(sessionId)
    if (!session) return
    const interaction = pendingInteraction(session, interactionId)
    if (!interaction) return
    resolvedInteractions.add(interactionId)
    event(session, "interaction.resolved", {
      resolution: { interactionId, kind: "ask_user", outcome: "expired", resolvedAt: timestamp, resolver: "system" },
    })
    activeRuns.delete(String(interaction.runId))
    event(session, "run.updated", {
      run: {
        runId: String(interaction.runId),
        status: "failed",
        turn: 1,
        startedAt: timestamp,
        phase: "thinking",
        completedAt: timestamp,
        failure: { code: "interaction_expired", message: "The question expired before it was answered", retryable: false },
      },
    })
  }

  const leaseOf = (sessionId: string, scope: string): RecordValue => {
    const entry = leaseStates.get(`${sessionId}\u0000${scope}`) ?? { status: "available" as const, generation: 0 }
    return { status: entry.status, generation: entry.generation, ...(entry.holder === undefined ? {} : { holder: { ...entry.holder } }) }
  }
  const leasesOf = (sessionId: string): RecordValue => ({
    composer: leaseOf(sessionId, "composer"),
    "session-control": leaseOf(sessionId, "session-control"),
  })
  // Attach, detach, and every lease mutation publish the dual notification so
  // both broadcast-seeded clients and mid-flight races converge on one state.
  const publishPresence = (sessionId: string): void => {
    const leases = leasesOf(sessionId)
    emit({ jsonrpc: "2.0", method: "presence.updated", params: { sessionId, clients: sessionClients.get(sessionId) ?? [], leases } })
    emit({ jsonrpc: "2.0", method: "interaction.lease.updated", params: { sessionId, leases } })
  }

  const connector: BrowserConnector = async (_endpoint, clientId, connectOptions = {}) => {
    connectOptions.signal?.throwIfAborted()
    const closes = new Set<(error?: Error) => void>()
    const connectionId = `demo-${clientId}`
    const self = { clientId, clientKind: "web", name: `Demo browser ${clientId}` }
    let open = true
    function handle(method: string, params: RecordValue): JsonValue {
      if (method === "server.initialize")
        return {
          appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
          server: { name: "ag2cli demo", version: "demo", hostId, protocolVersion: APP_SERVER_PROTOCOL_VERSION },
          connection: { connectionId, deviceId: "demo-device", scopes: advertisedScopes },
          capabilities: {
            session: {
              methods: sessionMethods,
              eventTypes: [
                "input.accepted",
                "input.updated",
                "run.updated",
                "message.upserted",
                "interaction.requested",
                "interaction.resolved",
                "security.updated",
                "plan.updated",
                "task.updated",
              ],
            },
            interactions: { approval: true, askUser: gates.askUser !== false },
            workspace: { diff: gates.workspaceDiff !== false, readFile: gates.workspaceReadFile !== false },
            security: { permissionModes, editableRules: false },
            execution: { explicitShell: gates.shellExecute !== false },
          },
          host: { profile: "durable", workspaces: [workspace] },
        }
      if (method === "session.list") return [...sessions.values()].map(summary)
      if (method === "session.create") {
        const session: DemoSession = {
          sessionId: String(params.sessionId),
          title: String(params.title),
          workspaceId: String(params.workspaceId),
          updatedAt: timestamp,
          events: [],
          inputs: [],
          notified: false,
          policy: seedPolicy(),
          plans: [],
        }
        sessions.set(session.sessionId, session)
        return { session: snapshot(session) }
      }
      const session = sessions.get(String(params.sessionId))
      if (!session) throw new Error("Session does not exist")
      if (method === "session.attach") {
        const roster = sessionClients.get(session.sessionId) ?? []
        if (!roster.some((client) => client.clientId === clientId))
          roster.push({ clientId, clientKind: "web", name: `Demo browser ${clientId}`, version: "demo" })
        sessionClients.set(session.sessionId, roster)
        publishPresence(session.sessionId)
        return { snapshot: snapshot(session), barrierRevision: session.events.length }
      }
      if (method === "session.resync") return { snapshot: snapshot(session) }
      if (method === "session.replay") {
        const afterRevision = Number(params.afterRevision ?? 0)
        if (afterRevision > session.events.length) {
          throw new DemoRpcError("revision_ahead", "Replay cursor is beyond the session head")
        }
        const remaining = session.events.filter((item) => item.revision > afterRevision)
        if (replayPageSize !== undefined && remaining.length > replayPageSize) {
          const page = remaining.slice(0, replayPageSize)
          return {
            events: page,
            scannedThroughRevision: session.events.length,
            hasMore: true,
            nextAfterRevision: page[page.length - 1]!.revision,
          }
        }
        return {
          events: remaining,
          scannedThroughRevision: session.events.length,
          hasMore: false,
        }
      }
      if (method === "session.detach") {
        sessionClients.set(
          session.sessionId,
          (sessionClients.get(session.sessionId) ?? []).filter((client) => client.clientId !== clientId),
        )
        publishPresence(session.sessionId)
        return { sessionId: session.sessionId, detached: true }
      }
      if (method === "session.delete") {
        sessions.delete(session.sessionId)
        return { sessionId: session.sessionId, deleted: true }
      }
      if (method === "session.getPermissionPolicy") return { policy: { sessionId: session.sessionId, ...session.policy } }
      if (method === "workspace.diff") {
        requireWorkspaceScope()
        if (gates.workspaceDiff === false) throw new DemoRpcError("capability_unavailable", "Workspace diff is not enabled on this Host")
        const token = workspaceToken()
        let offset = 0
        if (params.cursor !== undefined) {
          const cursor = String(params.cursor)
          const separator = cursor.lastIndexOf(":")
          const cursorOffset = separator === -1 ? Number.NaN : Number(cursor.slice(separator + 1))
          if (separator === -1 || !Number.isInteger(cursorOffset) || cursorOffset < 0)
            throw new DemoRpcError("invalid_params", `cursor is malformed: ${cursor}`)
          if (cursor.slice(0, separator) !== token)
            throw new DemoRpcError("workspace_changed", `Workspace changed since the paginated diff started: ${session.workspaceId}`)
          offset = cursorOffset
        }
        const limit = Math.min(Number(params.limit ?? 200), 500)
        const page = workspaceChanges.slice(offset, offset + limit)
        return {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          snapshotToken: token,
          asOf: { head: `demo-head-${workspaceRevision}`, workingTreeDigest: `working-tree-${workspaceRevision}` },
          changes: page.map((change) => toWireWorkspaceChange(change, params.includePatch === true)),
          ...(offset + page.length < workspaceChanges.length ? { nextCursor: `${token}:${offset + page.length}` } : {}),
        }
      }
      if (method === "workspace.readFile") {
        requireWorkspaceScope()
        if (gates.workspaceReadFile === false)
          throw new DemoRpcError("capability_unavailable", "Workspace file reads are not enabled on this Host")
        const path = String(params.path)
        if (path.startsWith("/") || path.split("/").includes("..") || workspaceSensitive(path))
          throw new DemoRpcError("workspace_path_denied", `Path is outside the readable workspace: ${path}`)
        const file = workspaceFiles.get(path)
        if (!file) throw new DemoRpcError("workspace_path_denied", `Path is not present in the working tree: ${path}`)
        const digest = workspaceDigest(path)
        if (params.expectedDigest !== undefined && String(params.expectedDigest) !== digest)
          throw new DemoRpcError("workspace_changed", `Workspace file changed since it was read: ${path}`)
        const sizeBytes = workspaceSize(file)
        if (file.kind === "binary")
          return { sessionId: session.sessionId, workspaceId: session.workspaceId, path, kind: "binary", sizeBytes, digest }
        const lines = (file.content ?? "").split("\n")
        const startLine = Number(params.startLine ?? 1)
        const maxLines = Math.min(Number(params.maxLines ?? 200), 1000)
        const window = lines.slice(startLine - 1, startLine - 1 + maxLines)
        return {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          path,
          kind: "text",
          content: window.join("\n"),
          encoding: "utf-8",
          sizeBytes,
          digest,
          startLine,
          totalLines: lines.length,
          ...(startLine - 1 + window.length < lines.length ? { nextStartLine: startLine + window.length } : {}),
        }
      }
      if (method === "session.setPermissionMode") {
        const lease = (params.lease ?? {}) as RecordValue
        if (lease.scope === undefined) throw new DemoRpcError("interaction_lease_required", "Mode writes need the session-control lease")
        if (String(lease.scope) !== "session-control")
          throw new DemoRpcError("interaction_lease_scope_mismatch", "Mode writes need the session-control lease scope")
        const mode = String(params.mode)
        if (!session.policy.selectableModes.includes(mode)) throw new DemoRpcError("invalid_params", "Mode is not selectable")
        if (Number(params.expectedPolicyRevision) !== session.policy.policyRevision)
          throw new DemoRpcError("policy_revision_conflict", "Policy changed since the expected revision")
        session.policy = { ...session.policy, mode, policyRevision: session.policy.policyRevision + 1 }
        event(session, "security.updated", {
          permissionMode: session.policy.mode,
          policyRevision: session.policy.policyRevision,
        })
        return { policy: { sessionId: session.sessionId, ...session.policy } }
      }
      if (method.startsWith("interaction.")) {
        const scope = String(params.scope)
        const key = `${session.sessionId}\u0000${scope}`
        const entry = leaseStates.get(key) ?? { status: "available" as const, generation: 0 }
        if (method === "interaction.acquire" || method === "interaction.takeover") {
          const currentHolder = entry.status === "held" ? entry.holder : undefined
          if (method === "interaction.acquire" && currentHolder !== undefined && currentHolder.clientId !== clientId)
            throw new DemoRpcError("interaction_lease_held", `The ${scope} lease is held by ${currentHolder.name}`)
          const next = { status: "held" as const, generation: entry.generation + 1, holder: { ...self } }
          leaseStates.set(key, next)
          publishPresence(session.sessionId)
          return { sessionId: session.sessionId, lease: leaseOf(session.sessionId, scope) }
        }
        if (method === "interaction.renew") {
          if (entry.status !== "held" || entry.holder?.clientId !== clientId || Number(params.leaseGeneration) !== entry.generation)
            throw new DemoRpcError("interaction_lease_stale", `The ${scope} lease can no longer be renewed`)
          return { sessionId: session.sessionId, lease: leaseOf(session.sessionId, scope) }
        }
        if (entry.status === "held" && entry.holder?.clientId === clientId && Number(params.leaseGeneration) === entry.generation) {
          leaseStates.set(key, { status: "available", generation: entry.generation })
          publishPresence(session.sessionId)
          return { sessionId: session.sessionId, lease: leaseOf(session.sessionId, scope) }
        }
        throw new DemoRpcError("interaction_lease_stale", `The ${scope} lease can no longer be released`)
      }
      if (method === "session.submit") {
        const commandId = String(params.commandId)
        const input: DemoInput = {
          inputId: `input-${++runCounter}`,
          commandId,
          kind: "prompt",
          status: "queued",
          text: String(params.text),
          acceptedAt: timestamp,
        }
        session.inputs.push(input)
        event(session, "input.accepted", { input: toWireInput(input) })
        // queued === true iff a run of this session is already active (§11.4);
        // a paused ask_user run counts as active until it is resolved.
        const activeRun = [...activeRuns.values()].some((entry) => entry.session === session) || pendingInteractions(session).length > 0
        if (activeRun) {
          if (!session.notified) {
            session.notified = true
            const notification: DemoInput = {
              inputId: `notification-${++runCounter}`,
              commandId: `notification-command-${runCounter}`,
              kind: "notification",
              status: "queued",
              text: "Queued messages run after the active response completes",
              acceptedAt: timestamp,
            }
            session.inputs.push(notification)
            event(session, "input.accepted", { input: toWireInput(notification) })
          }
          return { sessionId: session.sessionId, commandId, accepted: true, inputId: input.inputId, queued: true }
        }
        startRun(session, input)
        return { sessionId: session.sessionId, commandId, accepted: true, inputId: input.inputId, queued: false }
      }
      if (method === "session.steer") {
        const runId = String(params.runId)
        if (!activeRuns.has(runId)) throw new DemoRpcError("run_not_active", "Steer target run is not active")
        const steer: DemoInput = {
          inputId: `steer-${++runCounter}`,
          commandId: String(params.commandId),
          kind: "steer",
          status: "queued",
          text: String(params.text),
          acceptedAt: timestamp,
          runId,
        }
        session.inputs.push(steer)
        event(session, "input.accepted", { input: toWireInput(steer) })
        return { sessionId: session.sessionId, commandId: steer.commandId, accepted: true, inputId: steer.inputId, queued: true }
      }
      if (method === "session.cancelInput") {
        const input = session.inputs.find((item) => item.inputId === String(params.inputId))
        if (!input) return { requested: false, state: "not_found" }
        if (input.status !== "queued") return { requested: false, state: "already_terminal" }
        input.status = "cancelled"
        event(session, "input.updated", { input: toWireInput(input) })
        return { requested: true, state: "requested" }
      }
      if (method === "session.cancelRun") {
        const cancelledRunId = String(params.runId)
        const run = activeRuns.get(cancelledRunId)
        if (!run) return { requested: false, state: "not_found" }
        clearTimeout(timers.get(run.commandId))
        timers.delete(run.commandId)
        settleSteers(run.session, cancelledRunId, "cancelled")
        event(run.session, "run.updated", {
          run: { runId: cancelledRunId, status: "cancelled", turn: 1, startedAt: timestamp, phase: "thinking", completedAt: timestamp },
        })
        activeRuns.delete(cancelledRunId)
        return { requested: true, state: "requested" }
      }
      if (method === "session.resolveInteraction") {
        const interactionId = String(params.interactionId)
        if (resolvedInteractions.has(interactionId))
          throw new DemoRpcError("interaction_already_resolved", "Interaction was already resolved")
        const interaction = pendingInteraction(session, interactionId)
        if (!interaction) throw new DemoRpcError("interaction_not_found", "Interaction is not pending")
        // Approvals captured before a policy change carry a stale revision;
        // the client re-reads the policy instead of deciding on old rules.
        if (String(params.kind) === "tool_approval" && Number(params.expectedPolicyRevision) < session.policy.policyRevision)
          throw new DemoRpcError("stale_approval", "Approval predates the current policy revision")
        resolvedInteractions.add(interactionId)
        if (String(params.kind) === "ask_user") {
          const answer = (params.answer ?? {}) as RecordValue
          const outcome = String(answer.outcome)
          const resolution = {
            interactionId,
            kind: "ask_user",
            outcome,
            resolvedAt: timestamp,
            resolver: "client",
            resolvedBy: { clientName: self.name, clientKind: "web" },
            ...(outcome === "answered" ? { answers: answer.answers ?? [] } : {}),
          }
          event(session, "interaction.resolved", { resolution })
          // Answered and declined satisfy the ask and end the turn; chat keeps
          // the run active so the follow-up prompt queues behind it.
          if (outcome !== "chat") {
            const runId = String(interaction.runId)
            event(session, "run.updated", {
              run: { runId, status: "completed", turn: 1, startedAt: timestamp, phase: "thinking", completedAt: timestamp },
            })
            activeRuns.delete(runId)
          }
          return { resolved: true, interactionId, kind: "ask_user", resolution }
        }
        const outcome = String(params.optionId).startsWith("approve") ? "approved" : "denied"
        const resolution = {
          interactionId,
          kind: "tool_approval",
          outcome,
          resolvedAt: timestamp,
          resolvedBy: { clientName: self.name, clientKind: "web" },
        }
        event(session, "interaction.resolved", { resolution })
        return { resolved: true, interactionId, kind: "tool_approval", resolution }
      }
      if (method === "session.executeUserShell") {
        requireShellScope()
        if (gates.shellExecute === false) throw new DemoRpcError("capability_unavailable", "Remote shell is not enabled on this Host")
        const commandId = String(params.commandId)
        const admitted = taskAdmissions.get(commandId)
        if (admitted !== undefined) {
          const existing = shellTasks.get(admitted)!
          return { accepted: true, sessionId: session.sessionId, commandId, taskId: existing.taskId, queued: existing.status === "queued" }
        }
        // Shell admission is authorized by the shell:execute scope alone; the
        // composer lease fences composing agent input, never console runs.
        const command = String(params.command)
        const taskId = `demo-task-${++taskCounter}`
        const task: DemoShellTask = { taskId, kind: "user_shell", title: command, status: "queued", chunks: [] }
        if (params.timeoutMs !== undefined) task.timeoutMs = Number(params.timeoutMs)
        shellTasks.set(taskId, task)
        taskAdmissions.set(commandId, taskId)
        event(session, "task.updated", { task: toWireTask(task) })
        task.status = "running"
        for (let line = 1; line <= 6; line += 1) task.chunks.push({ sequence: line, text: `ran ${command}: line ${line}` })
        event(session, "task.updated", { task: toWireTask(task) })
        const timeout = task.timeoutMs !== undefined && task.timeoutMs < 200
        taskTimers.set(
          taskId,
          setTimeout(
            () => {
              taskTimers.delete(taskId)
              if (timeout) {
                task.chunks.push({ sequence: task.chunks.length + 1, text: `command exceeded its timeout of ${task.timeoutMs}ms` })
                task.status = "failed"
              } else {
                for (let line = 7; line <= 12; line += 1) task.chunks.push({ sequence: line, text: `ran ${command}: line ${line}` })
                task.status = "completed"
              }
              event(session, "task.updated", { task: toWireTask(task) })
            },
            timeout ? 100 : 300,
          ),
        )
        return { accepted: true, sessionId: session.sessionId, commandId, taskId, queued: false }
      }
      if (method === "session.getTaskLogs") {
        const taskId = String(params.taskId)
        const task = shellTasks.get(taskId)
        if (!task) throw new DemoRpcError("invalid_params", `session has no background task: ${taskId}`)
        const afterSequence = Number(params.afterSequence ?? 0)
        const limit = Math.min(Number(params.limit ?? 200), 500)
        const page = task.chunks.filter((chunk) => chunk.sequence > afterSequence).slice(0, limit)
        const last = page[page.length - 1]
        return {
          sessionId: session.sessionId,
          taskId,
          status: task.status,
          outputBytes: task.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
          chunks: page.map((chunk) => ({ ...chunk })),
          ...(page.length === limit && last !== undefined ? { nextAfterSequence: last.sequence } : {}),
        }
      }
      if (method === "session.cancelTask") {
        const taskId = String(params.taskId)
        const task = shellTasks.get(taskId)
        if (!task) throw new DemoRpcError("invalid_params", `session has no background task: ${taskId}`)
        // Terminal cancels are convergent no-ops that report false.
        if (task.status === "queued" || task.status === "running") {
          clearTimeout(taskTimers.get(taskId))
          taskTimers.delete(taskId)
          task.status = "cancelled"
          event(session, "task.updated", { task: toWireTask(task) })
          return { cancelled: true, sessionId: session.sessionId, taskId, task: toWireTask(task) }
        }
        return { cancelled: false, sessionId: session.sessionId, taskId, task: toWireTask(task) }
      }
      throw new Error(`Unsupported demo method: ${method}`)
    }
    const detachListeners: Array<() => void> = []
    const transport: AppServerTransport = {
      send(message) {
        if (!open || !("method" in message) || !("id" in message)) return
        const params = (message.params ?? {}) as RecordValue
        try {
          emit({ jsonrpc: "2.0", id: message.id, result: handle(message.method, params) })
        } catch (error) {
          emit({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof DemoRpcError ? { data: { code: error.kind } } : {}),
            },
          })
        }
      },
      onMessage(listener) {
        messageListeners.add(listener)
        const detach = (): void => {
          messageListeners.delete(listener)
        }
        detachListeners.push(detach)
        return detach
      },
      onClose(listener) {
        closes.add(listener)
        return () => closes.delete(listener)
      },
      close() {
        if (!open) return
        open = false
        for (const detach of detachListeners.splice(0)) detach()
        for (const listener of closes) listener()
        closes.clear()
      },
    }
    const rpc = new JsonRpcAppServerClient(transport)
    const abort = () => rpc.close()
    connectOptions.signal?.addEventListener("abort", abort, { once: true })
    const initialize = await rpc.initialize({
      appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
      hostId,
      client: { clientId, clientKind: "web", name: "Demo browser", version: "demo", capabilities: [] },
      auth: {
        type: "device",
        device: {
          deviceId: "demo-device",
          credential: `ag2cli-device.${"A".repeat(43)}`,
          challenge: `ag2cli-challenge.${"A".repeat(43)}`,
          signature: `ag2cli-p256-signature.${"A".repeat(86)}`,
        },
      },
    })
    return {
      rpc,
      initialize,
      onClose: (listener) => transport.onClose(listener),
      close: () => {
        connectOptions.signal?.removeEventListener("abort", abort)
        rpc.close()
      },
    }
  }
  return {
    connector,
    expireInteraction,
    triggerResync,
    injectUnknownEvent,
    clearUnknownEvents,
    mutateWorkspace(): void {
      workspaceRevision += 1
      workspaceChanges = [
        ...workspaceChanges,
        {
          operation: "add",
          path: `docs/change-${workspaceRevision}.md`,
          fileKind: "text",
          additions: 3 + workspaceRevision,
          deletions: 0,
          truncated: false,
        },
      ]
      const app = workspaceFiles.get("src/app.tsx")
      if (app?.content !== undefined)
        workspaceFiles.set("src/app.tsx", { ...app, content: `${app.content}\n// patched in mutation ${workspaceRevision}` })
    },
  }
}
