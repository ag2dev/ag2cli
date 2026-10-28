#!/usr/bin/env bun

import { buildServeRuntime } from "../composition/serve-runtime.js"
import { pickModelClient } from "../composition/model-client.js"
import {
  createAppServerWebSocketServer,
  type AppServerWebSocketServerOptions,
} from "../interfaces/transport/app-server-websocket-server.js"
import { createPendingApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import { createPendingAskBroker } from "@ag2cli/runtime/ports/ask-broker.js"
import { DEFAULT_EVENT_ROOT, loadRuntimeConfig } from "../config/runtime.js"
import { validateHeadlessServerSecurity } from "../capabilities/security/headless-server.js"
import { cleanupScratchRoots } from "../capabilities/security/scratch.js"
import { JsonAppServerDeviceRegistry } from "../infrastructure/persistence/json-app-server-device-registry.js"
import { InMemoryAppServerPairingRegistry } from "../interfaces/transport/in-memory-app-server-pairing-registry.js"
import { InMemoryAppServerDeviceProofService } from "../interfaces/transport/app-server-device-proof.js"
import { JsonAppServerHostIdentity } from "../infrastructure/persistence/app-server-host-identity.js"

import { join, resolve } from "node:path"

interface ServerArgs {
  readonly configPath?: string
  readonly workspaceRoots: readonly string[]
}

function parseServerArgs(argv: readonly string[]): ServerArgs {
  let configPath: string | undefined
  const workspaceRoots: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--config" || arg.startsWith("--config=")) {
      if (configPath !== undefined) throw new Error("--config may only be specified once")
      const value = arg === "--config" ? argv[++index] : arg.slice("--config=".length)
      if (!value || value.trim().length === 0) throw new Error("--config requires a non-empty path")
      configPath = value
      continue
    }
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const value = arg === "--workspace" ? argv[++index] : arg.slice("--workspace=".length)
      if (!value || value.trim().length === 0) throw new Error("--workspace requires a non-empty path")
      workspaceRoots.push(resolve(safeCwd() ?? "/", value))
      continue
    }
    throw new Error(`server does not support option: ${arg}`)
  }
  return { ...(configPath === undefined ? {} : { configPath }), workspaceRoots }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const serverArgs = parseServerArgs(argv)
  const configPath = serverArgs.configPath
  const launchCwd = safeCwd()
  const config = loadRuntimeConfig(process.env, {
    mode: "headless",
    cwd: launchCwd ?? "/",
    ...(configPath === undefined ? {} : { configPath }),
  })
  const bearerToken = config.server.token
  const tls = config.server.tls
  validateHeadlessServerSecurity({
    host: config.server.host,
    bearerToken,
    requireAuth: config.server.requireAuth,
    tlsConfigured: tls !== undefined,
  })
  if (config.applicationHome === undefined) throw new Error("App Server Host identity requires AG2CLI_HOME")
  const identityRoot = join(config.applicationHome, "app-server")
  const deviceRegistry = new JsonAppServerDeviceRegistry(identityRoot)
  const serveRoot = config.paths.eventRoot === DEFAULT_EVENT_ROOT ? join(config.applicationHome, "serve") : resolve(config.paths.eventRoot)
  const hostIdentity = await JsonAppServerHostIdentity.open(identityRoot, {
    existingStatePaths: [deviceRegistry.path, join(serveRoot, "workspaces.json")],
  })
  const client = await pickModelClient(config)
  // Remote HTTP clients must explicitly approve non-read-only tool calls.
  const host = await buildServeRuntime({
    client,
    approval: createPendingApprovalBroker(),
    // Remote clients answer ask_user cards through session.resolveInteraction;
    // there is no local interactive surface to receive them.
    ask: createPendingAskBroker(),
    // This is the initial registry entry only; Session routing uses the
    // persisted workspaceId, never this process cwd.
    ...(launchCwd === undefined ? {} : { workspaceRoot: launchCwd }),
    workspaceRoots: serverArgs.workspaceRoots,
    hostId: hostIdentity.hostId,
    // `!` is an explicit client-originated action. Keep model Bash governed by
    // the configured permission profile, but make the user-shell path
    // available to authenticated App Server clients.
    enableInteractiveShell: true,
    runtimeConfig: config,
  })
  const pairingRegistry = new InMemoryAppServerPairingRegistry(deviceRegistry, hostIdentity.hostId)
  const deviceProof = new InMemoryAppServerDeviceProofService()
  const createConnection: AppServerWebSocketServerOptions["createConnection"] = (onNotification, identity) =>
    host.createConnection({
      onNotification,
      deviceRegistry,
      ...(identity.deviceId === undefined ? {} : { deviceId: identity.deviceId }),
      grantedScopes: identity.grantedScopes,
    })
  let server: ReturnType<typeof createAppServerWebSocketServer> | undefined
  const transportProtocol = tls === undefined ? "ws" : "wss"
  const healthProtocol = tls === undefined ? "http" : "https"
  try {
    server = createAppServerWebSocketServer({
      port: config.server.port,
      hostname: config.server.host,
      hostIdentity,
      deviceRegistry,
      pairingRegistry,
      deviceProof,
      ...(bearerToken === undefined ? {} : { operatorToken: bearerToken }),
      corsOrigins: config.server.corsOrigins,
      ...(tls === undefined
        ? {}
        : {
            tls: {
              cert: Bun.file(tls.certFile),
              key: Bun.file(tls.keyFile),
              ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
            },
          }),
      createConnection,
    })
    const port = server.port
    if (!Number.isSafeInteger(port) || port <= 0) throw new Error("App Server TCP listener did not return a port")
  } catch (error) {
    pairingRegistry?.close()
    deviceProof.close()
    if (server !== undefined) await server.stop(true).catch(() => {})
    await host.close().catch(() => {})
    throw error
  }

  const port = server.port

  console.log(
    `ag2cli serve listening on ${transportProtocol}://${config.server.host}:${port}/app-server (Host ID: ${hostIdentity.hostId}; health: ${healthProtocol}://${config.server.host}:${port}/health)`,
  )

  let shutdownPromise: Promise<void> | undefined
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      let failed = false
      pairingRegistry?.close()
      deviceProof.close()
      try {
        if (server !== undefined) await server.stop(true)
      } catch {
        failed = true
      }
      try {
        await host.close()
      } catch {
        failed = true
      }
      try {
        await cleanupScratchRoots()
      } catch {
        failed = true
      }
      if (failed) process.exitCode = 1
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
    })()
    return shutdownPromise
  }
  const onSignal = (): void => {
    void shutdown()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
}

function safeCwd(): string | undefined {
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Failed to start the headless server: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
