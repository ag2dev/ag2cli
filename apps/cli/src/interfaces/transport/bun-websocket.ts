import type { WebSocketLike } from "@ag2cli/app-server-client/websocket.js"

/** Create a Bun WebSocket and attach the server bearer token when configured. */
export function createBunWebSocket(url: string, bearerToken?: string): WebSocketLike {
  if (!/^wss?:\/\//iu.test(url)) throw new Error("App Server WebSocket endpoint only supports ws:// or wss://")
  if (bearerToken === undefined || bearerToken.length === 0) return new WebSocket(url) as unknown as WebSocketLike
  return new WebSocket(url, { headers: { Authorization: `Bearer ${bearerToken}` } }) as unknown as WebSocketLike
}
