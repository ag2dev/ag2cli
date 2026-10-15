import { retryDelay } from "./backoff.js"
import { maxAttemptsFor } from "./budget.js"
import type { ModelFailure, ModelFailureCode, ModelFailureContext, ModelRetryEvent } from "@ag2cli/runtime/ports/model/retry.js"
import { classifyModelFailure, classifyStreamFailure, partialStreamFailure } from "./failure.js"

export interface ModelRetryOptions<T> {
  readonly signal?: AbortSignal
  readonly classifyResult?: (result: T) => ModelFailure | undefined
  readonly classifyError?: (error: unknown, context: ModelFailureContext) => ModelFailure
  readonly onRetry?: (event: ModelRetryEvent) => void | Promise<void>
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly remainingMs?: () => number | undefined
}

/**
 * Provider-independent retry controller. It owns retry budget and timing;
 * provider adapters only classify their response and execute one request.
 */
export async function withModelRetry<T>(operation: (attempt: number) => Promise<T>, options: ModelRetryOptions<T> = {}): Promise<T> {
  let attempt = 0
  let maxAttempts: number | undefined
  let lastFailure: ModelFailure | undefined
  let lastError: unknown

  while (true) {
    throwIfAborted(options.signal)
    attempt += 1
    try {
      const result = await operation(attempt)
      lastError = undefined
      const failure = options.classifyResult?.(result)
      if (!failure) return result
      lastFailure = failure
    } catch (error) {
      const context: ModelFailureContext = {}
      lastFailure = options.classifyError?.(error, context) ?? classifyModelFailure(error, context)
      lastError = error
    }

    const failure = lastFailure
    if (!failure) throw new Error("Model retry controller lost its failure state")
    if (failure.category === "cancelled" && lastError !== undefined) throw lastError
    maxAttempts = maxAttempts === undefined ? maxAttemptsFor(failure) : Math.min(maxAttempts, maxAttemptsFor(failure))
    if (!canRetry(failure, attempt, maxAttempts)) {
      throw new ModelRetryError(failure, attempt)
    }

    const delayMs = retryDelay(attempt, failure, {
      random: options.random?.() ?? Math.random(),
      remainingMs: options.remainingMs?.(),
    })
    const event = { attempt, nextAttempt: attempt + 1, delayMs, failure }
    await options.onRetry?.(event)
    await (options.sleep ?? sleep)(delayMs, options.signal)
  }
}

export class ModelRetryError extends Error {
  readonly code: ModelFailureCode

  constructor(
    readonly failure: ModelFailure,
    readonly attempts: number,
  ) {
    super(failure.message)
    this.name = "ModelRetryError"
    this.code = failureCode(failure.category)
  }
}

function failureCode(category: ModelFailure["category"]): ModelFailureCode {
  const codes: Record<ModelFailure["category"], ModelFailureCode> = {
    empty_response: "EMPTY_RESPONSE",
    transport: "TRANSPORT_ERROR",
    timeout: "REQUEST_TIMEOUT",
    rate_limited: "RATE_LIMITED",
    provider_unavailable: "PROVIDER_UNAVAILABLE",
    quota_exhausted: "QUOTA_EXHAUSTED",
    authentication: "AUTHENTICATION_ERROR",
    context_overflow: "CONTEXT_OVERFLOW",
    request_invalid: "INVALID_REQUEST",
    tool_compatibility: "TOOL_COMPATIBILITY",
    malformed_response: "MALFORMED_RESPONSE",
    partial_stream_failure: "PARTIAL_STREAM_FAILURE",
    cancelled: "CANCELLED",
    unknown: "UNKNOWN",
  }
  return codes[category]
}

export interface ModelStreamRetryOptions<T> {
  readonly signal?: AbortSignal
  readonly isTerminal: (event: T) => boolean
  readonly isVisibleOutput: (event: T) => boolean
  readonly isToolCall: (event: T) => boolean
  readonly errorFromEvent?: (event: T) => Error | undefined
  readonly classifyTerminal?: (event: T) => ModelFailure | undefined
  readonly classifyError?: (error: unknown, context: ModelFailureContext) => ModelFailure
  readonly onRetry?: (event: ModelRetryEvent) => void | Promise<void>
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly remainingMs?: () => number | undefined
}

/**
 * Retry a stream only while no visible text or tool call has been committed.
 * Already-rendered output is never replayed, so a partial stream is terminal.
 */
export async function* withModelStreamRetry<T>(
  createAttempt: (attempt: number) => AsyncIterable<T>,
  options: ModelStreamRetryOptions<T>,
): AsyncGenerator<T> {
  let attempt = 0
  let maxAttempts: number | undefined

  while (true) {
    throwIfAborted(options.signal)
    attempt += 1
    let committed = false
    let hasToolCall = false
    let terminal: T | undefined
    let streamError: unknown
    const buffered: T[] = []

    try {
      for await (const event of createAttempt(attempt)) {
        const eventError = options.errorFromEvent?.(event)
        if (eventError) {
          streamError = eventError
          break
        }
        if (options.isTerminal(event)) {
          terminal = event
          continue
        }
        const visible = options.isVisibleOutput(event)
        const toolCall = options.isToolCall(event)
        hasToolCall ||= toolCall
        if (!committed && (visible || toolCall)) {
          committed = true
          for (const previous of buffered.splice(0)) yield previous
          yield event
        } else if (committed) {
          yield event
        } else {
          buffered.push(event)
        }
      }
    } catch (error) {
      streamError = error
    }

    let failure: ModelFailure | undefined
    if (streamError !== undefined) {
      const classified =
        options.classifyError?.(streamError, {
          hasVisibleOutput: committed,
          hasToolCall,
        }) ??
        classifyStreamFailure(streamError, {
          hasVisibleOutput: committed,
          hasToolCall,
        })
      failure = committed && classified.category !== "cancelled" ? partialStreamFailure(classified.message) : classified
    } else if (terminal === undefined) {
      failure = partialStreamFailure(
        committed ? "Model stream ended after producing output" : "Model stream ended before completion",
        !committed,
      )
    } else if (!committed) {
      failure = options.classifyTerminal?.(terminal)
    }

    if (!failure) {
      for (const event of buffered) yield event
      if (terminal !== undefined) yield terminal
      return
    }

    if (failure.category === "cancelled" && streamError !== undefined) throw streamError
    maxAttempts = maxAttempts === undefined ? maxAttemptsFor(failure) : Math.min(maxAttempts, maxAttemptsFor(failure))
    if (!canRetry(failure, attempt, maxAttempts)) throw new ModelRetryError(failure, attempt)

    const delayMs = retryDelay(attempt, failure, {
      random: options.random?.() ?? Math.random(),
      remainingMs: options.remainingMs?.(),
    })
    await options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, failure })
    await (options.sleep ?? sleep)(delayMs, options.signal)
  }
}

function canRetry(failure: ModelFailure, attempt: number, maxAttempts: number): boolean {
  return (failure.retryable || failure.conservativeRetryable) && failure.replayable && attempt < maxAttempts
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    throwIfAborted(signal)
    return
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      const error = new Error("Model call cancelled")
      error.name = "AbortError"
      reject(error)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("Model call cancelled")
  error.name = "AbortError"
  throw error
}
