#!/usr/bin/env bun

import * as acp from "@agentclientprotocol/sdk"
import { createAcpPlanAgent, createAcpRunAgent } from "../public/acp.js"
import { connectEphemeralAppServer } from "../composition/acp-app-server.js"
import { loadRuntimeConfig } from "../config/runtime.js"
import { parseConfigPathArgs } from "../config/config-file.js"
import { APP_SERVER_PROTOCOL_VERSION } from "@ag2cli/app-server-protocol/types.js"
import { resolve } from "node:path"
import { workspaceIdForRoot } from "../capabilities/security/workspace.js"
import { cleanupScratchRoots } from "../capabilities/security/scratch.js"

const ACP_HELP = `Usage: ag2cli acp [--config <path>]

Runs the ACP stdio adapter for editor integrations over stdin/stdout;
no interactive terminal is required.

Options:
  --config <path>   explicit config file
  --help, -h        show this help`

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Pre-scan: parseConfigPathArgs would consume --help as a --config
  // value, so help is detected before parsing.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${ACP_HELP}\n`)
    return
  }
  const configPath = parseConfigPathArgs(argv, "acp")
  // Config validation precedes the stdio stream: ndJsonStream pumps stdin
  // eagerly from construction, so a config error must reject before any
  // reader exists that could orphan the process.
  const config = loadRuntimeConfig(process.env, {
    mode: "headless",
    ...(configPath === undefined ? {} : { configPath }),
  })
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return Bun.write(Bun.stdout, chunk).then(() => undefined)
    },
  })

  const stream = acp.ndJsonStream(output, Bun.stdin.stream())
  // ACP is an external protocol edge. It speaks the public App Server
  // contract to a private ephemeral Host composed in-process for the
  // adapter's lifetime.
  const appServer = await connectEphemeralAppServer(config)
  try {
    const initialize = await appServer.client.initialize({
      appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
      client: { clientId: "acp-edge", clientKind: "acp", name: "ag2cli-acp", version: "1" },
    })
    const workspaceIdForAcpRoot = (workspaceRoot: string): string | undefined => {
      const requested = resolve(workspaceRoot)
      const registered = initialize.host?.workspaces?.find((workspace) => resolve(workspace.workspaceRoot) === requested)
      if (registered !== undefined) return registered.workspaceId
      if (initialize.host?.workspaceRoot !== undefined && resolve(initialize.host.workspaceRoot) === requested) {
        return workspaceIdForRoot(requested)
      }
      // ACP's cwd is a client-facing session hint.  The private ephemeral
      // App Server has one workspace (the ACP process cwd), so preserve that
      // edge's stable identity when a client supplies a virtual/nonexistent
      // cwd such as a remote editor URI.
      if (initialize.host?.workspaceRoot !== undefined) return workspaceIdForRoot(initialize.host.workspaceRoot)
      return undefined
    }
    const app =
      config.acp.mode === "run"
        ? createAcpRunAgent({
            client: appServer.client,
            workspaceIdForRoot: workspaceIdForAcpRoot,
            // Async children are turn-scoped in ACP: the prompt answer waits
            // for this turn's children to settle or cancel.
            onInvocationEnd: () => appServer.drainChildAgents(),
          })
        : createAcpPlanAgent({ client: appServer.client, workspaceIdForRoot: workspaceIdForAcpRoot })
    const connection = app.connect(stream)
    await connection.closed
  } finally {
    // host.close() drains the remaining connections before releasing
    // storage, so the single close covers the JSON-RPC connection too.
    await appServer.close()
    await cleanupScratchRoots()
  }
}

/**
 * Process face of the ACP adapter: startup failures print the branded
 * stderr line and exit 1 instead of surfacing as an unhandled rejection.
 */
export function runAcpProcess(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  return main(argv).catch((error: unknown) => {
    console.error(`Failed to start ACP: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

if (import.meta.main) {
  void runAcpProcess()
}
