/**
 * TUI process entrypoint: TTY guards, argument parsing, configuration,
 * the embedded runtime and the process wiring around the TUI Ink host.
 * The interactive tree is wired exclusively through createTuiInkHost;
 * this file owns what cannot live there — config, the model client and
 * runtime build, session selection, signals and process exit.
 */
import { randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import { sessionId as mintSessionId } from "@ag2cli/core/ids.js"
import { createPendingApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import { parseGitDiff, readGitDiff } from "../capabilities/workspace/git-diff.js"
import { cleanupScratchRoots } from "../capabilities/security/scratch.js"
import { drainChildAgents, type ChildAgentRunner } from "../capabilities/execution/child-agent-runner.js"
import { loadRuntimeConfig, loadTuiThemePreference } from "../config/runtime.js"
import { guardianReviewDeadlineMs, pickGuardian, pickModelClient } from "../composition/model-client.js"
import { createTuiEmbeddedSession } from "../composition/tui-embedded-session.js"
import { createTuiInkHost, type CompletionItem } from "../composition/tui-ink-host.js"
import { buildTuiRuntime } from "../composition/tui-runtime.js"
import { createChildApprovalRunnerSurface } from "../composition/child-approval-bridge.js"
import { createTuiScreen } from "../composition/tui-screen-terminal.js"
import { createTuiHistoryStore, resolveTuiHistoryPath } from "../infrastructure/persistence/tui-history-store.js"
import { createTuiThemePreferenceStore } from "../infrastructure/persistence/tui-theme-preference-store.js"
import { connectSession } from "../public/sdk.js"
import { parseTuiProcessArgs, TUI_PROCESS_HELP, type TuiProcessArgs } from "../interfaces/cli/tui-process-args.js"
import { SUPPORT_FLOOR } from "../ui/tui/bootstrap/ink.js"

const RUNTIME_CLOSE_TIMEOUT_MS = 2_000

const COMPLETION_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".venv",
  ".next",
  ".cache",
  ".turbo",
  ".ssh",
  ".aws",
  ".gnupg",
])
const MAX_WORKSPACE_COMPLETION_ITEMS = 20_000
const MAX_WORKSPACE_COMPLETION_DIRECTORIES = 5_000
// eslint-disable-next-line no-control-regex -- control characters can never appear in a completion-safe path
const UNSAFE_COMPLETION_PATH = /[\s\u0000-\u001f\u007f()[\]{}<>,;:!?\uFF0C\u3002\uFF01\uFF1F\u3001"'\\]/u

type BoundedOutcome = { readonly kind: "complete" } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "timeout" }

function waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<BoundedOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ kind: "timeout" })
    }, timeoutMs)
    promise.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: "complete" })
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: "error", error })
      },
    )
  })
}

/**
 * TUI-local workspace snapshot; regular non-hidden display-safe files and
 * directories enter @ completion. Directories carry a trailing `/` (their
 * insert keeps the cursor in the path) and the list pre-sorts shallow
 * paths first, so an empty query surfaces the workspace root before the
 * deep tree.
 */
async function readWorkspaceCompletionItems(root: string): Promise<readonly CompletionItem[]> {
  const items: CompletionItem[] = []
  const pending = [root]
  let visitedDirectories = 0
  while (pending.length > 0 && items.length < MAX_WORKSPACE_COMPLETION_ITEMS && visitedDirectories < MAX_WORKSPACE_COMPLETION_DIRECTORIES) {
    const directory = pending.pop()
    if (directory === undefined) break
    visitedDirectories += 1
    let entries: readonly Dirent[]
    try {
      entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (UNSAFE_COMPLETION_PATH.test(entry.name)) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (COMPLETION_IGNORED_DIRECTORIES.has(entry.name)) continue
        const displayPath = `${relative(root, fullPath).split(sep).join("/")}/`
        const displayDirectory = dirname(displayPath) === "." ? "" : dirname(displayPath)
        items.push({
          id: `dir:${displayPath}`,
          label: displayPath,
          kind: "file",
          detail: displayDirectory,
          fields: { basename: basename(displayPath), path: displayPath, directory: displayDirectory },
        })
        pending.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const displayPath = relative(root, fullPath).split(sep).join("/")
      if (displayPath.length === 0 || UNSAFE_COMPLETION_PATH.test(displayPath)) continue
      const displayDirectory = dirname(displayPath) === "." ? "" : dirname(displayPath)
      items.push({
        id: `file:${displayPath}`,
        label: displayPath,
        kind: "file",
        detail: displayDirectory,
        fields: { basename: basename(displayPath), path: displayPath, directory: displayDirectory },
      })
      if (items.length >= MAX_WORKSPACE_COMPLETION_ITEMS) break
    }
  }
  const byDepthThenLabel = (left: CompletionItem, right: CompletionItem): number => {
    const depth = (item: CompletionItem): number => (item.label.match(/\//g) ?? []).length
    return depth(left) - depth(right) || left.label.localeCompare(right.label)
  }
  return items.sort(byDepthThenLabel)
}

/**
 * Everything that must come up before the terminal is touched; a failure
 * here stays a plain stderr line with a normal process exit.
 */
async function prepareStartup(args: TuiProcessArgs, workspaceRoot: string) {
  const config = loadRuntimeConfig(process.env, {
    mode: "interactive",
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
  })
  const themePreference = loadTuiThemePreference(args.configPath, process.env, workspaceRoot)
  const historyStore = createTuiHistoryStore(resolveTuiHistoryPath(config.applicationHome))
  const modelClient = await pickModelClient(config)
  const guardian = await pickGuardian(config)
  const guardianDeadlineMs = guardianReviewDeadlineMs(config)
  const mentionItems = await readWorkspaceCompletionItems(workspaceRoot)
  return {
    config,
    themePreference,
    historyStore,
    modelClient,
    guardian,
    guardianDeadlineMs,
    mentionItems,
    history: await historyStore.load(),
    modelDisplayName: config.provider.model ?? "configured-model",
  }
}

/** Process entrypoint: argument + TTY guards, config and runtime, then the Ink host until exit. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseTuiProcessArgs(argv)
  if ("help" in args) {
    process.stdout.write(`${TUI_PROCESS_HELP}\n`)
    return
  }
  if ("error" in args) {
    process.stderr.write(`${args.error}\n`)
    process.exitCode = 1
    return
  }
  const stdin = process.stdin as typeof process.stdin & { isTTY?: boolean }
  if (stdin.isTTY !== true) {
    process.stderr.write("ag2cli requires an interactive terminal; use 'ag2cli run <goal>' for non-interactive execution\n")
    process.exitCode = 1
    return
  }
  const stdout = process.stdout as typeof process.stdout & { columns?: number; rows?: number }
  const columns = stdout.columns ?? 0
  const rows = stdout.rows ?? 0
  if (columns < SUPPORT_FLOOR.columns || rows < SUPPORT_FLOOR.rows) {
    process.stderr.write(`terminal too small: need at least ${SUPPORT_FLOOR.columns}x${SUPPORT_FLOOR.rows}\n`)
    process.exitCode = 1
    return
  }
  const workspaceRoot = process.cwd()
  let startup: Awaited<ReturnType<typeof prepareStartup>>
  try {
    startup = await prepareStartup(args, workspaceRoot)
  } catch (error) {
    process.stderr.write(`tui startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  // From here the screen owns stdin, so every failure path exits the
  // process directly instead of returning into a held-open event loop.
  const screen = createTuiScreen({ mouseTracking: args.noMouse !== true })
  // Late-bound runtime: the host must exist first (the runtime build
  // injects the host's ask bridge), and the factory only runs inside
  // host.start/switchSession — after the runtime is set.
  let runtime: Awaited<ReturnType<typeof buildTuiRuntime>> | null = null
  let host: ReturnType<typeof createTuiInkHost> | null = null
  // The runtime build hands the assembled child-agent runner over; the
  // host's cancel-child effect speaks to it (children are process-local).
  let childRunner: ChildAgentRunner | null = null
  let shutdownPromise: Promise<void> | undefined
  const shutdown = (requestedExitCode: number): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      let exitCode = requestedExitCode
      try {
        await host?.stop()
      } catch (error) {
        process.stderr.write(`\r\n[tui shutdown] host cleanup failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
        if (exitCode === 0) exitCode = 1
      }
      // Async children are process-local: their terminals must land in
      // durable history before the runtime that writes it closes.
      if (childRunner !== null) await drainChildAgents(childRunner)
      if (runtime !== null) {
        const close = waitBounded(
          Promise.resolve().then(() => runtime?.close()),
          RUNTIME_CLOSE_TIMEOUT_MS,
        )
        const outcome = await close
        if (outcome.kind === "error") {
          process.stderr.write(
            `\r\n[tui shutdown] runtime close failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}\r\n`,
          )
          if (exitCode === 0) exitCode = 1
        } else if (outcome.kind === "timeout") {
          process.stderr.write("\r\n[tui shutdown] runtime close timed out\r\n")
          if (exitCode === 0) exitCode = 1
        }
      }
      await cleanupScratchRoots()
      process.exit(exitCode)
    })()
    return shutdownPromise
  }
  try {
    host = createTuiInkHost({
      screen,
      // Auto mode joins the mode picker only when its reviewer resolved.
      guardianAvailable: startup.guardian !== undefined,
      createSession: (context) => {
        if (runtime === null || context.sessionId === undefined) {
          throw new Error("the TUI session factory needs a built runtime and a selected session")
        }
        return createTuiEmbeddedSession({
          client: connectSession(runtime.sessionServer, context.sessionId),
          writer: context.writer,
          // A fresh session's log holds no SessionCreated yet; the first
          // directory add needs a root to mint it from.
          workspaceRoot,
          ...context.hooks,
          answers: context.ask,
          agents: context.agents,
        })
      },
      identity: { brand: "ag2cli", workspace: workspaceRoot, model: startup.modelDisplayName },
      initialTheme: startup.themePreference.theme,
      ...(startup.themePreference.configPath === undefined ? {} : { themeConfigPath: startup.themePreference.configPath }),
      themePreference: createTuiThemePreferenceStore(),
      firstRunThemeSelection: startup.themePreference.source === "default",
      providerName: startup.config.provider.protocol,
      modelName: startup.modelDisplayName,
      ...(startup.config.provider.baseURL === undefined ? {} : { endpoint: startup.config.provider.baseURL }),
      ...(startup.config.provider.contextWindow === undefined ? {} : { contextWindow: startup.config.provider.contextWindow }),
      effort: startup.config.ui.effort,
      completion: { mention: () => startup.mentionItems },
      history: startup.history,
      onHistory: (text) => {
        void startup.historyStore.add(text)
      },
      diffFiles: {
        files: async (signal?: AbortSignal) =>
          parseGitDiff(await readGitDiff(workspaceRoot, signal)).map((file) => ({
            path: file.path,
            untracked: file.untracked === true,
            binary: file.binary,
            additions: file.additions,
            deletions: file.deletions,
            truncated: file.truncated === true,
            diff: file.diff,
          })),
      },
      sessions: {
        list: async () => {
          const records = (await runtime?.catalog.list()) ?? []
          return records
            .filter((record) => !record.archived)
            .map((record) => ({
              sessionId: `${record.sessionId}`,
              ...(record.title === undefined ? {} : { title: record.title }),
              lastRevision: record.snapshot.lastRevision,
            }))
        },
      },
      onExit: () => {
        void shutdown(0)
      },
      onCancelChild: (childSessionId) => {
        childRunner?.cancelChild(childSessionId)
      },
      onFatal: (reason) => {
        // The frame fault already restored the host terminal; exit is
        // now queued behind runtime close and the terminal output barrier.
        process.stderr.write(`\r\n[tui fatal] ${reason}\r\n`)
        void shutdown(1)
      },
    })
    // Signal/stdin-end first fence screen input; the host then unmounts Ink,
    // waits for its output barrier, restores Screen, and closes the runtime.
    screen.onTerminationRequest(() => {
      void shutdown(0)
    })
    // Process-private embedded host; the TUI never reads discovery and
    // never connects a daemon. A pending approval broker parks ask-classed
    // tools on ToolApprovalRequested until the approval card resolves them.
    runtime = await buildTuiRuntime({
      client: startup.modelClient,
      approval: createPendingApprovalBroker(),
      // Attributed child asks bubble onto the host's child approval cards
      // through the same bridge the cards settle through.
      childApprovals: createChildApprovalRunnerSurface(host.childApprovals),
      // Auto-mode asks are answered by this reviewer alone, bounded by the
      // configured whole-review deadline from the same startup snapshot.
      ...(startup.guardian === undefined ? {} : { guardian: startup.guardian }),
      ...(startup.guardianDeadlineMs === undefined ? {} : { guardianDeadlineMs: startup.guardianDeadlineMs }),
      askUser: host.ask.askUser,
      onChildRunner: (runner) => {
        childRunner = runner
      },
      enableInteractiveShell: true,
      loadProjectInstructions: true,
      runtimeConfig: startup.config,
      workspaceRoot,
    })
    // Session selection: an explicit --session wins over the configured
    // id; --resume without either adopts the latest non-archived record
    // by revision then recency; otherwise a fresh id.
    let selectedSessionId = args.sessionId ?? startup.config.sessionId
    if (args.resume === true && selectedSessionId === undefined) {
      const records = (await runtime.catalog.list()) ?? []
      const latest = records
        .filter((record) => !record.archived)
        .sort((left, right) => right.snapshot.lastRevision - left.snapshot.lastRevision || right.createdAt.localeCompare(left.createdAt))[0]
      selectedSessionId = latest === undefined ? undefined : `${latest.sessionId}`
    }
    const initialSessionId = selectedSessionId ?? randomUUID()
    // The session exists before anything connects: a fresh id lands in
    // the catalog, a resumed one is already there.
    const catalogId = mintSessionId(initialSessionId)
    if ((await runtime.catalog.get(catalogId)) === undefined) {
      await runtime.catalog.create(catalogId, workspaceRoot)
    }
    const preparation = await host.start({ sessionId: initialSessionId })
    if (!preparation.ok) {
      process.stderr.write(`${preparation.diagnostics}\n`)
      await shutdown(1)
      return
    }
    await host.flush()
  } catch (error) {
    process.stderr.write(`tui startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    await shutdown(1)
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
