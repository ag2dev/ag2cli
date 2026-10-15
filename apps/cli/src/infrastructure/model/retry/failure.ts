/**
 * Failure classification implementation. Canonical types (ModelFailure* / ModelRetryEvent) live in
 * ports/model/retry; this module contains only the classifier and constructors.
 */
import type { ModelFailure, ModelFailureCategory, ModelFailureContext, ModelFailureSource } from "@ag2cli/runtime/ports/model/retry.js"

export interface ModelResponseLike {
  readonly stopReason?: string
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

export function emptyModelFailure(message = "Model returned no visible response"): ModelFailure {
  return {
    category: "empty_response",
    source: "semantic",
    message,
    retryable: true,
    replayable: true,
    conservativeRetryable: false,
  }
}

export function partialStreamFailure(message = "Model stream ended after producing output", replayable = false): ModelFailure {
  return {
    category: "partial_stream_failure",
    source: "stream",
    message,
    retryable: true,
    replayable,
    conservativeRetryable: false,
  }
}

/** Convert a normalized stream error into a replay decision without importing a provider SDK. */
export function classifyStreamFailure(error: unknown, context: ModelFailureContext = {}): ModelFailure {
  return classifyModelFailure(
    error,
    {
      ...context,
      hasVisibleOutput: context.hasVisibleOutput,
    },
    "stream",
  )
}

export function classifyModelFailure(error: unknown, context: ModelFailureContext = {}, sourceHint?: ModelFailureSource): ModelFailure {
  const record = asRecord(error)
  const response = asRecord(record?.response)
  const message = errorMessage(error, record)
  const responseBodyValue = record?.responseBody ?? record?.body ?? response?.body ?? response?.data
  const responseBody = valueText(responseBodyValue)
  const responseBodyRecord = objectValue(responseBodyValue)
  const providerError = asRecord(record?.error)
  const lower =
    `${message} ${responseBody ?? ""} ${valueText(record?.type) ?? ""} ${valueText(record?.code) ?? ""} ${valueText(providerError?.code) ?? ""}`.toLowerCase()
  const status = numberValue(
    record?.status ??
      record?.statusCode ??
      response?.status ??
      response?.statusCode ??
      responseBodyRecord?.status ??
      responseBodyRecord?.statusCode,
  )
  const providerCode = stringValue(
    record?.code ??
      providerError?.code ??
      response?.code ??
      asRecord(response?.error)?.code ??
      responseBodyRecord?.code ??
      asRecord(responseBodyRecord?.error)?.code,
  )
  const source = sourceHint ?? inferSource(status, providerCode, lower)
  const retryAfterMs = parseRetryAfter(record, response)
  const replayable = !context.hasVisibleOutput && !context.hasToolCall && !context.userCancelled

  if (context.userCancelled || isAbortError(error)) {
    return make("cancelled", "semantic", message || "Model call cancelled", {
      status,
      providerCode,
      retryAfterMs,
      retryable: false,
      replayable: false,
    })
  }

  if (isContextOverflow(lower, status)) {
    return make("context_overflow", source, message, { status, providerCode, retryAfterMs })
  }

  if (isQuota(lower, status)) {
    return make("quota_exhausted", source, message, { status, providerCode, retryAfterMs })
  }

  if (isAuthentication(lower, status)) {
    return make("authentication", source, message, { status, providerCode, retryAfterMs })
  }

  if (status === 404) {
    return make("request_invalid", "http", message, { status, providerCode, retryAfterMs })
  }

  if (status === 408 || status === 409 || (status === undefined && isTimeout(providerCode, lower))) {
    return make("timeout", source, message, {
      status,
      providerCode,
      retryAfterMs,
      retryable: true,
      replayable,
    })
  }

  if (status === 429 || isRateLimited(providerCode, lower)) {
    return make("rate_limited", source, message, {
      status,
      providerCode,
      retryAfterMs,
      retryable: true,
      replayable,
    })
  }

  if ((status !== undefined && status >= 500) || isUnavailable(providerCode, lower)) {
    return make("provider_unavailable", source, message, {
      status,
      providerCode,
      retryAfterMs,
      retryable: true,
      replayable,
    })
  }

  if (isToolCompatibility(lower, status, providerCode)) {
    return make("tool_compatibility", source, message, { status, providerCode, retryAfterMs })
  }

  if (isMalformedResponse(lower, status)) {
    return make("malformed_response", source, message, { status, providerCode, retryAfterMs })
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return make("request_invalid", source, message, { status, providerCode, retryAfterMs })
  }

  if (isKnownTransport(providerCode, lower)) {
    return make("transport", source, message, {
      status,
      providerCode,
      retryAfterMs,
      retryable: true,
      replayable,
    })
  }

  if (record?.isRetryable === true) {
    return make("transport", source, message, {
      status,
      providerCode,
      retryAfterMs,
      retryable: true,
      replayable,
    })
  }

  return make("unknown", source, message || "Unknown model provider error", {
    status,
    providerCode,
    retryAfterMs,
    replayable,
    conservativeRetryable: source === "network" && status === undefined && replayable,
  })
}

export function classifyModelResponse(response: ModelResponseLike): ModelFailure | undefined {
  const stop = response.stopReason
  const hasVisibleText =
    response.content?.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) ?? false
  const hasToolUse = response.content?.some((block) => block.type === "tool_use") ?? false
  if (hasVisibleText || hasToolUse) return undefined
  if (stop !== "stop" && stop !== "end_turn") return undefined
  return emptyModelFailure()
}

function make(
  category: ModelFailureCategory,
  source: ModelFailureSource,
  message: string,
  values: {
    status?: number
    providerCode?: string
    retryAfterMs?: number
    retryable?: boolean
    replayable?: boolean
    conservativeRetryable?: boolean
  },
): ModelFailure {
  return {
    category,
    source,
    message: message || category,
    status: values.status,
    providerCode: values.providerCode,
    retryAfterMs: values.retryAfterMs,
    retryable: values.retryable ?? false,
    replayable: values.replayable ?? false,
    conservativeRetryable: values.conservativeRetryable ?? false,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function valueText(value: unknown): string | undefined {
  const string = stringValue(value)
  if (string !== undefined) return string
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === "string" ? serialized.slice(0, 16_384) : undefined
  } catch {
    return undefined
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (record !== undefined) return record
  if (typeof value !== "string") return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function errorMessage(error: unknown, record: Record<string, unknown> | undefined): string {
  if (error instanceof Error && error.message) return error.message
  const message = stringValue(record?.message) ?? stringValue(asRecord(record?.error)?.message)
  if (message) return message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown model provider error"
  }
}

function inferSource(status: number | undefined, code: string | undefined, message: string): ModelFailureSource {
  if (status !== undefined) return "http"
  if (code || isKnownTransport(code, message)) return "network"
  return "semantic"
}

function isAbortError(error: unknown): boolean {
  const record = asRecord(error)
  return record?.name === "AbortError" || record?.code === "ABORT_ERR" || record?.code === "ERR_ABORTED"
}

function isContextOverflow(message: string, status: number | undefined): boolean {
  return (
    status === 413 ||
    message.includes("context_length_exceeded") ||
    /too many tokens|request too large|context length|maximum context|input length|payload too large|prompt is too long/.test(message)
  )
}

function isQuota(message: string, status: number | undefined): boolean {
  return (
    status === 402 ||
    /insufficient_quota|quota exhausted|quota_exhausted|exceeded your current quota|credit limit|out of credits|payment required|usage limit|allotment|insufficient funds|billing quota|billing credits|freeusagelimit|gousagelimit/.test(
      message,
    )
  )
}

function isAuthentication(message: string, status: number | undefined): boolean {
  return (
    status === 401 ||
    status === 403 ||
    /invalid api key|authentication failed|unauthorized|forbidden|token revoked|token expired|invalid_grant/.test(message)
  )
}

function isTimeout(code: string | undefined, message: string): boolean {
  const normalized = code?.toLowerCase()
  return (
    normalized === "etimedout" ||
    normalized === "und_err_connect_timeout" ||
    /(^|\b)(request|response|connection|network|stream|read)? ?timed? ?out|timeout|time out/.test(message)
  )
}

function isRateLimited(code: string | undefined, message: string): boolean {
  const normalized = code?.toLowerCase()
  return (
    normalized === "rate_limited" ||
    normalized === "rate_limit_exceeded" ||
    /too many requests|rate limit|rate-limit|rate_limit|too_many_requests|resource exhausted/.test(message)
  )
}

function isUnavailable(code: string | undefined, message: string): boolean {
  const normalized = code?.toLowerCase()
  return (
    normalized === "overloaded" ||
    normalized === "server_error" ||
    /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|provider returned error|provider_returned_error|provider-returned-error|server_is_overloaded/.test(
      message,
    )
  )
}

function isKnownTransport(code: string | undefined, message: string): boolean {
  const normalized = code?.toLowerCase()
  return (
    normalized === "econnrefused" ||
    normalized === "econnreset" ||
    normalized === "epipe" ||
    normalized === "eai_again" ||
    normalized === "enotfound" ||
    normalized === "etimedout" ||
    normalized === "und_err_connect_timeout" ||
    /fetch failed|failed to fetch|socket hang up|connection reset|connection refused|network error|connection error|zliberror|decompression failed/.test(
      message,
    )
  )
}

function isToolCompatibility(message: string, status: number | undefined, code: string | undefined): boolean {
  const normalized = code?.toLowerCase()
  return (
    (status === 400 || status === 422 || normalized === "tool_call_incompatible" || normalized === "tool_stream_unsupported") &&
    /tool_calls?|tool_use|tool_result|function call|function calling|tool_stream/.test(message)
  )
}

function isMalformedResponse(message: string, status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    /<!doctype html|<html|invalid json|malformed|unexpected token|cannot parse|not valid json/.test(message)
  )
}

function parseRetryAfter(record: Record<string, unknown> | undefined, response?: Record<string, unknown>): number | undefined {
  const headers = record?.headers ?? record?.responseHeaders ?? response?.headers ?? response?.responseHeaders
  if (!headers) return undefined
  const milliseconds = firstHeader(headers, ["retry-after-ms", "x-retry-after-ms"])
  if (milliseconds !== undefined && /^\d+(?:\.\d+)?$/.test(milliseconds)) return Math.max(0, Math.ceil(Number(milliseconds)))
  const retryAfter = firstHeader(headers, ["retry-after"])
  if (retryAfter === undefined) return undefined
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return Math.max(0, Math.ceil(Number(retryAfter) * 1000))
  const date = Date.parse(retryAfter)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

function firstHeader(headers: unknown, names: readonly string[]): string | undefined {
  const getter = asRecord(headers)?.get
  if (typeof getter === "function") {
    for (const name of names) {
      const value = getter.call(headers, name)
      if (typeof value === "string") return value
    }
  }
  const record = asRecord(headers)
  if (!record) return undefined
  for (const name of names) {
    const value = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()]
    if (typeof value === "string") return value
    if (typeof value === "number") return String(value)
  }
  return undefined
}
