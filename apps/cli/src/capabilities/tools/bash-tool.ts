/** Model Bash tool: fixed argv, bounded host execution, canonical permission judgment. */

import { z } from "zod/v4"
import type { ToolPreparation, ToolResult, ToolResultDenial } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import { buildBashEnvironment, buildInteractiveBashEnvironment } from "../security/bash-environment.js"
import { readBoundedOutput, type BoundedOutput } from "../security/bash-output.js"
import {
  BASH_PREPARATION_VERSION,
  BASH_POLICY_VERSION,
  canonicalFingerprint,
  fixedBashArgv,
  MAX_MODEL_BASH_TIMEOUT_MS,
  normalizeModelBashPreparation,
} from "../security/bash/security-layer.js"
import { interpretCommandResult } from "../security/bash/command-semantics.js"
import { classifyReadOnlyTemplate } from "../security/bash/read-only-templates.js"
import { securityDenialCode } from "../security/workspace.js"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = MAX_MODEL_BASH_TIMEOUT_MS
const MAX_OUTPUT_BYTES = 20_000

const inputSchema = z.strictObject({
  command: z.string().min(1).describe("Bash command to execute; authorization follows the Session permission policy."),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds, default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}`),
  description: z.string().optional().describe("Short description of what the command does"),
})

type Input = z.infer<typeof inputSchema>

function outputText(label: string, output: BoundedOutput): string {
  if (!output.text && !output.truncated) return ""
  const marker = output.truncated
    ? `\n…(output truncated: ${label} exceeded ${MAX_OUTPUT_BYTES} bytes; at least ${output.bytes} bytes were produced)`
    : ""
  return `${label}:\n${output.text.trimEnd()}${marker}`
}

function terminateProcessGroup(proc: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal)
    } catch {
      /* process group may have exited */
    }
  }
  try {
    proc.kill(signal)
  } catch {
    /* process may have exited */
  }
}

export class BashTool implements Tool<typeof inputSchema> {
  readonly name = "bash"
  readonly description =
    "Run a Bash command with the host user's permissions, without a sandbox. The runtime checks the working directory and authorizes execution using the Session permission mode, explicit rules, and prepared command facts; a command may be allowed, require approval, or be denied. Output is bounded and execution has a timeout cap."
  readonly inputSchema = inputSchema

  constructor(private readonly options: { mode?: "agent" | "interactive" } = {}) {}

  async prepare(args: Input, context?: ToolContext): Promise<ToolPreparation> {
    const parsed = inputSchema.safeParse(args)
    if (!parsed.success) {
      return {
        status: "invalid",
        decision: "deny",
        preparedInput: args,
        reasons: [`input validation failed: ${parsed.error.message}`],
        analyzerVersion: "input-contract",
        policyVersion: "input-contract",
      }
    }
    args = parsed.data
    if (this.options.mode === "interactive") {
      return {
        status: "ready",
        decision: "allow",
        preparedInput: args,
        reasons: [],
        analyzerVersion: "interactive-shell",
        policyVersion: "user-owned",
      }
    }
    const requestedCwd = context?.execution?.cwd ?? context?.workspace?.workspaceRoot ?? process.cwd()
    let cwd = requestedCwd
    if (context?.workspace) {
      try {
        cwd = await context.workspace.resolveWithin(requestedCwd, "bash-cwd")
      } catch (error) {
        const denialCode = securityDenialCode(error)
        return {
          status: "denied",
          decision: "deny",
          preparedInput: args,
          reasons: [error instanceof Error ? error.message : String(error)],
          analyzerVersion: BASH_PREPARATION_VERSION,
          policyVersion: BASH_POLICY_VERSION,
          approvalFingerprint: canonicalFingerprint(args.command, requestedCwd),
          cwd: requestedCwd,
          ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
        }
      }
    }
    return {
      status: "ready",
      decision: "ask",
      preparedInput: args,
      reasons: [],
      analyzerVersion: BASH_PREPARATION_VERSION,
      policyVersion: BASH_POLICY_VERSION,
      approvalFingerprint: canonicalFingerprint(args.command, cwd),
      cwd,
      // The template label is a fact for the canonical judgment to consume;
      // it never authorizes a spawn on its own.
      ...(classifyReadOnlyTemplate(args.command) ? { securityFact: { kind: "bash-read-only-template" as const } } : {}),
    }
  }

  async call(args: Input, context?: ToolContext): Promise<ToolResult> {
    const mode = this.options.mode ?? "agent"
    const parsed = inputSchema.safeParse(args)
    if (!parsed.success) {
      return this.result(mode, `input validation failed: ${parsed.error.message}`, "denied", true, undefined, {
        code: "unknown_tool_or_input",
      })
    }
    args = parsed.data
    const requestedCwd = context?.execution?.cwd ?? context?.workspace?.workspaceRoot ?? process.cwd()
    let cwd = requestedCwd
    if (mode === "agent" && context?.workspace) {
      try {
        cwd = await context.workspace.resolveWithin(requestedCwd, "bash-cwd")
      } catch (error) {
        const denialCode = securityDenialCode(error)
        const message = error instanceof Error ? error.message : String(error)
        // A mapped security refusal renders the family shape; an unmapped
        // resolution failure is an environment error, not a permission
        // denial, so it settles without a code as a failed command.
        return denialCode === undefined
          ? this.result(mode, message, "failed", true)
          : this.result(mode, message, "denied", true, undefined, { code: denialCode })
      }
    }
    const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return this.result(mode, `timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}`, "denied", true, undefined, {
        code: "unknown_tool_or_input",
      })
    }
    if (context?.signal?.aborted) {
      return this.result(mode, "command was cancelled before a process started", "cancelled", true)
    }
    // Agent Bash is a canonical-event capability, not a public raw process
    // primitive.  The registry and execution use cases pass the exact
    // preparation fact selected for this call; a direct tool invocation must
    // fail closed instead of becoming an event-free security bypass.
    const trustedPreparation = context?.execution?.preparation
    if (mode === "agent" && !trustedPreparation) {
      return this.result(mode, "canonical preparation was not injected, no process started", "denied", true, undefined, {
        code: "denied_by_rule",
      })
    }
    if (
      mode === "agent" &&
      trustedPreparation &&
      trustedPreparation.policyVersion !== "user-owned" &&
      !trustedPreparation.approvalFingerprint
    ) {
      return this.result(mode, "canonical Bash preparation is missing its fingerprint, no process started", "denied", true, undefined, {
        code: "denied_by_rule",
      })
    }
    // The fingerprint binds the exact command and cwd that were judged;
    // recomputing it at call time denies any divergence before spawn.
    if (
      mode === "agent" &&
      trustedPreparation &&
      trustedPreparation.approvalFingerprint !== undefined &&
      trustedPreparation.approvalFingerprint !== canonicalFingerprint(args.command, cwd)
    ) {
      // Binding invalidation, same family as the executor fences: the
      // judged fact no longer describes this call, so it settles stale.
      return this.result(
        mode,
        "canonical preparation does not match the current command (command, cwd, or preparation version changed), no process started",
        "denied",
        true,
        undefined,
        { code: "stale_policy" },
      )
    }
    if (mode === "agent" && trustedPreparation && normalizeModelBashPreparation(args, trustedPreparation).status === "invalid") {
      return this.result(mode, "canonical Bash preparation violates the executor contract, no process started", "denied", true, undefined, {
        code: "unknown_tool_or_input",
      })
    }
    if (
      mode === "agent" &&
      trustedPreparation &&
      (trustedPreparation.status === "invalid" ||
        trustedPreparation.status === "blocked" ||
        trustedPreparation.status === "denied" ||
        trustedPreparation.status === "reused")
    ) {
      // The preparation's own declared code is the honest cause; the guard
      // itself is a rule refusal. Only the code is adopted so the rendered
      // sentence and the structured denial reason never diverge.
      return this.result(mode, "canonical Bash preparation does not permit starting a process", "denied", true, undefined, {
        code: trustedPreparation.denial?.code ?? "denied_by_rule",
      })
    }
    // Model bash authorization is the canonical judgment/approval pair for
    // every preparation decision: an allow-carrying fact alone never starts
    // a process. User-owned shells keep their own allow path.
    if (
      mode === "agent" &&
      trustedPreparation &&
      trustedPreparation.policyVersion !== "user-owned" &&
      context?.execution?.approvalDecision !== "approved" &&
      context?.execution?.judgmentDecision !== "allow"
    ) {
      return this.result(mode, "command requires a canonical approval result, no process started", "approval_required", true, undefined, {
        code: "approval_required",
      })
    }

    const env = mode === "interactive" ? buildInteractiveBashEnvironment() : buildBashEnvironment(args.command)
    const rawArgv = mode === "interactive" ? ["/bin/bash", "-c", args.command] : fixedBashArgv(args.command)

    let proc!: Bun.Subprocess<"ignore", "pipe", "pipe">
    const spawnProcess = (): void => {
      proc = Bun.spawn({
        cmd: rawArgv,
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        detached: true,
      })
    }
    try {
      const gate = context?.execution?.preSpawnGate
      if (gate === undefined) {
        spawnProcess()
      } else {
        // The gate re-checks canonical policy inside the session serial
        // section; a stale call is denied before the process starts. Abort
        // may land while the gate queues, so it is re-checked inside the
        // section — a cancelled call never starts a process.
        let abortedBeforeSpawn = false
        await gate(async (): Promise<unknown> => {
          if (context?.signal?.aborted) {
            abortedBeforeSpawn = true
            return undefined
          }
          spawnProcess()
          return undefined
        })
        if (abortedBeforeSpawn) {
          return this.result(mode, "command was cancelled before a process started", "cancelled", true)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("stale_policy")) {
        return this.result(mode, message, "denied", true, undefined, { code: "stale_policy" })
      }
      return this.result(mode, `failed to start command: ${message}`, "failed", true)
    }

    let timedOut = false
    let cancelled = false
    let terminated = false
    let escalationTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = (): void => {
      if (terminated) return
      terminated = true
      terminateProcessGroup(proc, "SIGTERM")
      escalationTimer = setTimeout(() => terminateProcessGroup(proc, "SIGKILL"), 100)
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      terminate()
    }
    context?.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const stdoutPromise = readBoundedOutput(proc.stdout, MAX_OUTPUT_BYTES, (text) => context?.onOutput?.({ stream: "stdout", text }))
      const stderrPromise = readBoundedOutput(proc.stderr, MAX_OUTPUT_BYTES, (text) => context?.onOutput?.({ stream: "stderr", text }))
      const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise])
      const stdoutContent = outputText("stdout", stdout)
      const stderrContent = outputText("stderr", stderr)
      if (cancelled)
        return this.result(mode, `command was cancelled.\n${stdoutContent}\n${stderrContent}`.trimEnd(), "cancelled", true, exitCode)
      if (timedOut)
        return this.result(
          mode,
          `command timed out (>${timeoutMs}ms) and was terminated.\n${stdoutContent}\n${stderrContent}`.trimEnd(),
          "timed_out",
          true,
          exitCode,
        )
      const semantic = interpretCommandResult(args.command, exitCode, stdout.text, stderr.text)
      const parts = [`exit_code: ${exitCode}`]
      if (stdoutContent) parts.push(stdoutContent)
      if (stderrContent) parts.push(stderrContent)
      if (semantic.message) parts.push(`diagnostic: ${semantic.message}`)
      return this.result(mode, parts.join("\n"), semantic.isError ? "failed" : "succeeded", semantic.isError, exitCode)
    } catch (error) {
      terminate()
      return this.result(mode, `command execution failed: ${error instanceof Error ? error.message : String(error)}`, "failed", true)
    } finally {
      clearTimeout(timeoutTimer)
      if (escalationTimer) clearTimeout(escalationTimer)
      context?.signal?.removeEventListener("abort", onAbort)
    }
  }

  isReadOnly(_args: Input): boolean {
    return false
  }
  isConcurrencySafe(_args: Input): boolean {
    return false
  }

  private result(
    mode: "agent" | "interactive",
    content: string,
    status: string,
    isError: boolean,
    exitCode?: number,
    denial?: ToolResultDenial,
  ): ToolResult {
    // Denials render the code-first family: agent results lead with the
    // stable code (a gate-thrown message may already carry it), while
    // interactive shells keep the plain user-facing sentence. The structured
    // denial mirrors only the text rendered after the code, matching the
    // runtime executors' settlement.
    const prefixed = denial === undefined ? undefined : `${denial.code}: `
    const sentence = prefixed !== undefined && content.startsWith(prefixed) ? content.slice(prefixed.length) : content
    const rendered =
      denial === undefined
        ? content
        : mode === "agent"
          ? `tool bash denied (${prefixed !== undefined && content.startsWith(prefixed) ? content : `${denial.code}: ${content}`})`
          : `command denied: ${content}`
    return {
      content: rendered,
      ...(isError ? { isError: true } : {}),
      ...(denial === undefined ? {} : { denial: denial.reason === undefined ? { ...denial, reason: sentence } : denial }),
      metadata: {
        executionMode: mode === "interactive" ? "user-shell" : "model",
        executionStatus: status,
        ...(exitCode === undefined ? {} : { exitCode: String(exitCode) }),
      },
    }
  }
}
