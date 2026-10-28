/**
 * TUI process entrypoint: TTY guards, argument parsing, configuration,
 * the embedded runtime and the process wiring around the kernel entry
 * and the Ink frame. The interactive tree is wired exclusively through
 * createTuiEntry + createInkTuiFrame; this file owns what cannot live
 * there — config, the model client and runtime build, session
 * selection, signals and process exit.
 */
import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative, sep } from "node:path"
import { parseGitDiff, readGitDiff } from "../capabilities/workspace/git-diff.js"
import { cleanupScratchRoots } from "../capabilities/security/scratch.js"
import { drainChildAgents, type ChildAgentRunner } from "../capabilities/execution/child-agent-runner.js"
import { loadRuntimeConfig, loadTuiThemePreference } from "../config/runtime.js"
import { guardianReviewDeadlineMs, pickGuardian, pickModelClient } from "../composition/model-client.js"
import { resolveTuiProviderIdentity } from "../composition/tui-provider-identity.js"
import { createTuiEmbeddedSession } from "../composition/tui-embedded-session.js"
import { createTuiEntry, type CompletionItem, type TuiEntry } from "../composition/tui-entry.js"
import { createTuiSessionId } from "../composition/tui-session-id.js"
import { openTuiPublicSession } from "../composition/tui-public-session.js"
import { createTuiResumeSeam } from "../composition/tui-resume-seam.js"
import { buildTuiRuntime } from "../composition/tui-runtime.js"
import { createChildDecisionSurface } from "../composition/child-decision-surface.js"
import {
  createChildApprovalBridge,
  createChildApprovalRunnerSurface,
  type ChildApprovalBridge,
} from "../composition/child-approval-bridge.js"
import { createTuiScreen } from "../composition/tui-screen-terminal.js"
import { workspaceIntroLines, type TuiStartupScreen } from "../composition/tui-startup-screen.js"
import { createTuiPreferencesCoordinator } from "../composition/tui-preferences.js"
import { createTuiPreferenceStore } from "../infrastructure/persistence/tui-preference-store.js"
import { createTuiHistoryStore, resolveTuiHistoryPath } from "../infrastructure/persistence/tui-history-store.js"
import { parseTuiProcessArgs, TUI_PROCESS_HELP, type TuiProcessArgs } from "../interfaces/cli/tui-process-args.js"
import { createInkTuiFrame, SUPPORT_FLOOR, type InkTuiFrame } from "../ui/tui/bootstrap/ink.js"

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
  const modelClient = await pickModelClient(config, { onModelMiss: null })
  const guardian = await pickGuardian(config, { onModelMiss: null })
  const guardianDeadlineMs = guardianReviewDeadlineMs(config)
  const mentionItems = await readWorkspaceCompletionItems(workspaceRoot)
  return {
    config,
    themePreference,
    modelClient,
    guardian,
    guardianDeadlineMs,
    providerIdentity: resolveTuiProviderIdentity(config),
    mentionItems,
  }
}

/** Process entrypoint: argument + TTY guards, config and runtime, then the kernel entry and Ink frame until exit. */
export async function main(argv: readonly string[] = process.argv.slice(2), startupScreen?: TuiStartupScreen): Promise<void> {
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
  const homeDirectory = homedir()
  let startup: Awaited<ReturnType<typeof prepareStartup>>
  try {
    startup = await prepareStartup(args, workspaceRoot)
  } catch (error) {
    process.stderr.write(`tui startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  const promptHistory = createTuiHistoryStore(resolveTuiHistoryPath(startup.config.applicationHome))
  await promptHistory.load()
  // From here the screen owns stdin, so every failure path exits the
  // process directly instead of returning into a held-open event loop.
  // A handed-in startup screen is adopted as-is: it already prepared,
  // activated and painted, and the frame's idempotent prepare/activate
  // reuse it without a second buffer switch.
  const screen = startupScreen?.screen ?? createTuiScreen({ mouseTracking: args.noMouse !== true })
  // Late-bound assembly: the runtime build wires the child approval
  // bridge, the entry receives a session factory that needs that
  // runtime, and the theme coordinator is built before the frame it
  // swaps — shutdown reaches all of them through these holders.
  let runtime: Awaited<ReturnType<typeof buildTuiRuntime>> | null = null
  let entry: TuiEntry | undefined
  let frame: InkTuiFrame | undefined
  // The runtime build hands the assembled child-agent runner over;
  // shutdown drains it (children are process-local).
  let childRunner: ChildAgentRunner | null = null
  // Deliberately hand-rolled: shutdown memoizes forever, failure included —
  // a run-once guard that evicts on failure would newly allow re-running a
  // failed shutdown.
  let shutdownPromise: Promise<void> | undefined
  // The public session factory is late-bound with the runtime: one TUI
  // process embeds exactly one entry and one workspace, so every embedded
  // session opens the public contract over that host.
  const publicSessionFor = (session: string) => {
    if (runtime === null) {
      throw new Error("the TUI session factory needs a built runtime and a selected session")
    }
    return openTuiPublicSession({
      host: runtime,
      sessionId: session,
      workspaceRoot,
      guardianAvailable: startup.guardian !== undefined,
    })
  }
  const shutdown = (requestedExitCode: number): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      let exitCode = requestedExitCode
      // The frame first: it fences input and restores the terminal
      // while the session loop can still dispatch.
      try {
        await frame?.stop()
      } catch (error) {
        process.stderr.write(`\r\n[tui shutdown] frame cleanup failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
        if (exitCode === 0) exitCode = 1
      }
      entry?.kernel.dispose?.()
      // An adopted startup screen is already active while no frame
      // exists yet; a failure in that window must still restore the
      // terminal before the process exits.
      if (frame === undefined) {
        try {
          screen.teardown()
          await screen.flush()
        } catch (error) {
          process.stderr.write(`\r\n[tui shutdown] screen cleanup failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
          if (exitCode === 0) exitCode = 1
        } finally {
          screen.finishShutdown()
        }
      }
      // Then the session loop: teardown kills the hooks and the
      // generation fence every abandoned observation rode.
      try {
        await entry?.teardown()
      } catch (error) {
        process.stderr.write(`\r\n[tui shutdown] session teardown failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
        if (exitCode === 0) exitCode = 1
      }
      // Async children are process-local: their terminals must land in
      // durable history before the runtime that writes it closes. The
      // entry teardown already swept the bridged cards closed.
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
    const preferences = createTuiPreferencesCoordinator({
      initialTheme: startup.themePreference.theme,
      configPath: startup.themePreference.configPath,
      store: createTuiPreferenceStore(),
      // The coordinator exists before the frame it swaps, so the live
      // re-render reaches the frame through the holder above.
      onThemeChange: (next) => frame?.setTheme(next),
    })
    // Child cards ride the kernel's decision chain: the surface raises
    // bridge tokens as ask/approval facts, and the entry's executor
    // settles them back onto the bridge.
    const childDecisions = createChildDecisionSurface(() => childApprovals)
    const childApprovals: ChildApprovalBridge = createChildApprovalBridge(childDecisions.surface)
    const resumeSeam = createTuiResumeSeam(() => runtime?.catalog ?? null)
    const createdEntry = createTuiEntry({
      workspaceRoot,
      createSession: (context) => {
        if (context.sessionId === undefined) {
          throw new Error("the TUI session factory needs a built runtime and a selected session")
        }
        return {
          session: createTuiEmbeddedSession({
            session: publicSessionFor(context.sessionId),
            writer: context.writer,
            // A fresh session's log holds no directory facts yet; the
            // first directory add needs a root to mint from.
            workspaceRoot,
            ...context.hooks,
            agents: context.agents,
          }),
          sessionId: context.sessionId,
        }
      },
      preferences,
      promptHistory,
      completion: { mention: () => startup.mentionItems },
      provider: () => ({
        label: startup.providerIdentity.providerName,
        modelName: startup.providerIdentity.modelName,
        endpoint: startup.providerIdentity.endpoint,
        protocol: startup.providerIdentity.protocol,
      }),
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
      resumeSessions: resumeSeam.resumeSessions,
      setSessionTitleIfAbsent: resumeSeam.setTitleIfAbsent,
      resumeGate: resumeSeam.resumeGate,
      childDecisions,
      // The registry is process-scoped: the lever reads the live runner
      // regardless of the session binding, and a settled id answers false.
      cancelChild: (childId) => childRunner?.cancelChild(childId) ?? false,
      onExit: () => {
        void shutdown(0)
      },
      onFatal: (reason) => {
        process.stderr.write(`\r\n[tui fatal] ${reason}\r\n`)
        void shutdown(1)
      },
    })
    entry = createdEntry
    childDecisions.bind(createdEntry.kernel)
    // Signal/stdin-end first fence screen input; shutdown then unmounts
    // the frame, tears the session loop down, and closes the runtime.
    screen.onTerminationRequest(() => {
      void shutdown(0)
    })
    // Input-ownership swap: take, adopt and stand-down run as one
    // synchronous block, and the frame created right after registers its
    // input handler before any further byte can arrive. The stand-down
    // also flips the tty from the splash's canonical mode to raw inside
    // this block — the mode flip preserves queued input — so lines
    // typed before, during and after the swap each land exactly once.
    const bufferedKeys = startupScreen?.takeTypeAhead() ?? ""
    if (bufferedKeys.length > 0) createdEntry.kernel.adoptTypeAhead(bufferedKeys)
    // The startup screen's own early-exit guards stand down only now:
    // the termination fence above is in place, so a Ctrl+C during the
    // runtime build reaches shutdown instead of a raw process exit.
    startupScreen?.handoff()
    const createdFrame = createInkTuiFrame({
      screen,
      kernel: createdEntry.kernel,
      theme: startup.themePreference.theme,
      intro: (width) => workspaceIntroLines(workspaceRoot, homeDirectory, width),
      onFatal: (reason) => {
        // The frame fault already restored the terminal; exit is now
        // queued behind session teardown, runtime close and the
        // terminal output barrier.
        process.stderr.write(`\r\n[tui fatal] ${reason}\r\n`)
        void shutdown(1)
      },
    })
    frame = createdFrame
    // Process-private embedded host; the TUI never reads discovery and
    // never connects a daemon. Pending brokers park ask-classed tools on
    // the durable interactions until a decision resolves them through the
    // public resolution surface.
    runtime = await buildTuiRuntime({
      client: startup.modelClient,
      // Attributed child asks settle fail-closed through the same
      // bridge the runner raises them onto.
      childApprovals: createChildApprovalRunnerSurface(childApprovals),
      // Auto-mode asks are answered by this reviewer alone, bounded by the
      // configured whole-review deadline from the same startup snapshot.
      ...(startup.guardian === undefined ? {} : { guardian: startup.guardian }),
      ...(startup.guardianDeadlineMs === undefined ? {} : { guardianDeadlineMs: startup.guardianDeadlineMs }),
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
    const initialSessionId = selectedSessionId ?? createTuiSessionId()
    // The session exists before anything connects: a fresh id lands in
    // the catalog, a resumed one is already there.
    await publicSessionFor(initialSessionId).ensureSession()
    await createdEntry.start({ sessionId: initialSessionId })
    if (startupScreen?.preparation.ok === true) {
      // The splash tail has no line break. Clear it through the same
      // screen FIFO and flush barrier before Ink writes its first frame.
      screen.frame("\u001b[2J\u001b[H")
      await screen.flush()
    }
    const preparation = createdFrame.start()
    if (!preparation.ok) {
      process.stderr.write(`${preparation.diagnostics}\n`)
      await shutdown(1)
      return
    }
    await createdFrame.flush()
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
