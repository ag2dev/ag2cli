/**
 * Public contract for the non-interactive CLI boundary.
 *
 * Internal use cases and local session files may evolve independently. This
 * envelope is the stable machine-readable boundary consumed by scripts and CI.
 */

export const HEADLESS_PROTOCOL_VERSION = 1 as const

/**
 * Capabilities exposed by the stable non-interactive boundary.
 *
 * Keep this list independent from runtime configuration: clients need to
 * discover the protocol before they provide provider credentials.
 */
export const HEADLESS_CAPABILITIES = {
  protocolVersion: HEADLESS_PROTOCOL_VERSION,
  commands: ["run", "serve", "pair", "inspect", "trace", "observe", "session"],
  outputFormats: ["text", "json", "jsonl"],
  permissionModes: ["manual", "accept-edits", "plan", "full-access", "auto"],
  transports: ["in-process", "app-server-ws", "acp-stdio"],
} as const

export type HeadlessCommand = "help" | "version" | "capabilities" | "serve" | "pair" | "run" | "inspect" | "trace" | "observe" | "session"

export type HeadlessErrorCode =
  | "USAGE_ERROR"
  | "CONFIG_ERROR"
  | "PROVIDER_ERROR"
  | "AUTH_ERROR"
  | "APPROVAL_REQUIRED"
  | "PERMISSION_DENIED"
  | "CANCELLED"
  | "TIMEOUT"
  | "RUNTIME_ERROR"
  | "TOOL_ERROR"
  | "PERSISTENCE_ERROR"
  | "PROTOCOL_ERROR"
  | "TRANSPORT_ERROR"
  | "INTERNAL_ERROR"

export const HEADLESS_EXIT_CODES = {
  success: 0,
  usage: 2,
  config: 3,
  provider: 4,
  approval: 5,
  cancelled: 6,
  runtime: 7,
  persistence: 8,
  protocol: 9,
} as const

export type HeadlessExitCode = (typeof HEADLESS_EXIT_CODES)[keyof typeof HEADLESS_EXIT_CODES]

export interface HeadlessError {
  readonly code: HeadlessErrorCode
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface HeadlessMeta {
  readonly traceId?: string
  readonly revision?: number
  readonly [key: string]: unknown
}

export interface HeadlessEnvelope<T = unknown> {
  readonly schemaVersion: typeof HEADLESS_PROTOCOL_VERSION
  readonly ok: boolean
  readonly command: HeadlessCommand
  readonly requestId: string
  readonly sessionId?: string
  readonly runId?: string
  readonly data?: T
  readonly error?: HeadlessError
  readonly meta?: HeadlessMeta
}

export function successEnvelope<T>(
  command: HeadlessCommand,
  requestId: string,
  data: T,
  options: {
    readonly sessionId?: string
    readonly runId?: string
    readonly meta?: HeadlessMeta
  } = {},
): HeadlessEnvelope<T> {
  return {
    schemaVersion: HEADLESS_PROTOCOL_VERSION,
    ok: true,
    command,
    requestId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    data,
    ...(options.meta ? { meta: options.meta } : {}),
  }
}

export function errorEnvelope(
  command: HeadlessCommand,
  requestId: string,
  error: HeadlessError,
  options: {
    readonly sessionId?: string
    readonly runId?: string
    readonly meta?: HeadlessMeta
  } = {},
): HeadlessEnvelope<never> {
  return {
    schemaVersion: HEADLESS_PROTOCOL_VERSION,
    ok: false,
    command,
    requestId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    error,
    ...(options.meta ? { meta: options.meta } : {}),
  }
}

export function exitCodeForError(code: HeadlessErrorCode): HeadlessExitCode {
  switch (code) {
    case "USAGE_ERROR":
      return HEADLESS_EXIT_CODES.usage
    case "CONFIG_ERROR":
      return HEADLESS_EXIT_CODES.config
    case "PROVIDER_ERROR":
    case "AUTH_ERROR":
      return HEADLESS_EXIT_CODES.provider
    case "APPROVAL_REQUIRED":
    case "PERMISSION_DENIED":
      return HEADLESS_EXIT_CODES.approval
    case "CANCELLED":
    case "TIMEOUT":
      return HEADLESS_EXIT_CODES.cancelled
    case "PERSISTENCE_ERROR":
      return HEADLESS_EXIT_CODES.persistence
    case "PROTOCOL_ERROR":
    case "TRANSPORT_ERROR":
      return HEADLESS_EXIT_CODES.protocol
    case "TOOL_ERROR":
    case "RUNTIME_ERROR":
    case "INTERNAL_ERROR":
      return HEADLESS_EXIT_CODES.runtime
  }
}
