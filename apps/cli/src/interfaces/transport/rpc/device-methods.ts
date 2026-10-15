import { type AppServerDeviceRecord, type JsonValue } from "@ag2cli/app-server-protocol/types.js"
import { parseDeviceRevokeParams } from "@ag2cli/app-server-protocol/validation.js"
import { type MethodContext } from "./method-context.js"

/** Device administration operations for an authorized App Server connection. */
export class DeviceMethods {
  constructor(private readonly context: MethodContext) {}

  async list(): Promise<readonly AppServerDeviceRecord[]> {
    this.context.requireScope("device:admin")
    return this.context.requireDeviceRegistry().list()
  }

  async revoke(value: unknown): Promise<JsonValue> {
    this.context.requireScope("device:admin")
    const { deviceId } = parseDeviceRevokeParams(value)
    const revoked = await this.context.requireDeviceRegistry().revoke(deviceId)
    return { deviceId, revoked }
  }
}
