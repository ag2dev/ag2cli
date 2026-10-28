import type { WebSocketLike } from "@ag2cli/app-server-client/websocket.js"

/** Create an unauthenticated Bun WebSocket; App Server credentials are sent only after Host preflight. */
export function createBunWebSocket(url: string): WebSocketLike {
  if (!/^wss?:\/\//iu.test(url)) throw new Error("App Server WebSocket endpoint only supports ws:// or wss://")
  return new WebSocket(url) as unknown as WebSocketLike
}
