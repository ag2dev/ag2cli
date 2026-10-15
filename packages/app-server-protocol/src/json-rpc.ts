import type {
  JsonRpcErrorData,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonValue,
} from "./types.js"

export const JSON_RPC_PARSE_ERROR = -32700 as const
export const JSON_RPC_INVALID_REQUEST = -32600 as const
export const JSON_RPC_METHOD_NOT_FOUND = -32601 as const
export const JSON_RPC_INVALID_PARAMS = -32602 as const
export const JSON_RPC_INTERNAL_ERROR = -32603 as const

export function createRequest(method: string, id: JsonRpcId, params?: JsonValue): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }
}

export function createNotification(method: string, params?: JsonValue): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params }),
  }
}

export function createSuccess(id: JsonRpcId | null, result: JsonValue): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result }
}

export function createFailure(id: JsonRpcId | null, code: number, message: string, data?: JsonRpcErrorData): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }
}

export function encodeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message)
}

/** Parse one complete JSON-RPC message and reject ambiguous envelopes. */
export function parseMessage(value: unknown): JsonRpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") throw new Error("JSON-RPC message must use jsonrpc 2.0")

  const hasMethod = typeof value.method === "string"
  const hasResult = Object.hasOwn(value, "result")
  const hasError = Object.hasOwn(value, "error")
  if (hasMethod && (hasResult || hasError)) throw new Error("JSON-RPC message cannot be both a request and a response")
  if (hasMethod) {
    if ((value.method as string).trim().length === 0) throw new Error("JSON-RPC method must not be empty")
    const hasId = Object.hasOwn(value, "id")
    if (hasId && !isJsonRpcId(value.id)) throw new Error("JSON-RPC request id is invalid")
    if (Object.hasOwn(value, "params") && !isJsonValue(value.params)) throw new Error("JSON-RPC params must be a JSON value")
    if (hasId) {
      return {
        jsonrpc: "2.0",
        id: value.id as JsonRpcId,
        method: value.method as string,
        ...(value.params === undefined ? {} : { params: value.params as JsonValue }),
      }
    }
    return {
      jsonrpc: "2.0",
      method: value.method as string,
      ...(value.params === undefined ? {} : { params: value.params as JsonValue }),
    }
  }

  if (!hasResult && !hasError) throw new Error("JSON-RPC message must contain method, result, or error")
  if (hasResult && hasError) throw new Error("JSON-RPC response cannot contain both result and error")
  const id = value.id === null ? null : isJsonRpcId(value.id) ? value.id : undefined
  if (id === undefined) throw new Error("JSON-RPC response id is invalid")
  if (hasResult) {
    if (!isJsonValue(value.result)) throw new Error("JSON-RPC result must be a JSON value")
    return { jsonrpc: "2.0", id, result: value.result }
  }
  if (!isRecord(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") {
    throw new Error("JSON-RPC error structure is invalid")
  }
  if (value.error.data !== undefined && !isRecord(value.error.data)) throw new Error("JSON-RPC error.data must be an object")
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: value.error.code,
      message: value.error.message,
      ...(value.error.data === undefined ? {} : { data: parseErrorData(value.error.data) }),
    },
  }
}

export function parseEncodedMessage(text: string): JsonRpcMessage {
  try {
    return parseMessage(JSON.parse(text) as unknown)
  } catch (error) {
    throw new Error(`Could not parse JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message)
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "result" in message || "error" in message
}

function parseErrorData(value: Record<string, unknown>): JsonRpcErrorData {
  if (typeof value.code !== "string") throw new Error("JSON-RPC error.data.code must be a string")
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    throw new Error("JSON-RPC error.data.retryable must be a boolean")
  }
  if (value.details !== undefined && !isJsonValue(value.details)) throw new Error("JSON-RPC error.data.details must be a JSON value")
  return {
    code: value.code,
    ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
    ...(value.details === undefined ? {} : { details: value.details }),
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isSafeInteger(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}
