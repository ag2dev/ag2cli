#!/usr/bin/env bun

/**
 * Unified `ag2cli` entry: route the process arguments to exactly one
 * business mode. Only classification lives here; each mode owns its own
 * config, runtime and error surface, loaded on demand via literal
 * dynamic imports.
 */
import { AG2CLI_INVOCATION, routeUnifiedCliArgs, UNIFIED_CLI_HELP } from "../interfaces/cli/unified-cli.js"
import { parseTuiProcessArgs, TUI_PROCESS_HELP } from "../interfaces/cli/tui-process-args.js"
import { readAg2cliVersion } from "../public/version.js"

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const route = routeUnifiedCliArgs(argv)
  switch (route.kind) {
    case "help":
      console.log(UNIFIED_CLI_HELP)
      return
    case "version":
      console.log(`ag2cli ${await readAg2cliVersion()}`)
      return
    case "tui": {
      // Help and argument errors must not load the TUI renderer.
      const parsed = parseTuiProcessArgs(route.args)
      if ("help" in parsed) {
        console.log(TUI_PROCESS_HELP)
        return
      }
      if ("error" in parsed) {
        process.stderr.write(`${parsed.error}\n`)
        process.exitCode = 1
        return
      }
      const { main: tuiMain } = await import("./tui.js")
      await tuiMain(route.args)
      return
    }
    case "run":
    case "serve": {
      const { main: agentMain } = await import("./agent.js")
      await agentMain([route.kind, ...route.args], { invocationName: AG2CLI_INVOCATION })
      return
    }
    case "acp": {
      const { runAcpProcess } = await import("./acp.js")
      await runAcpProcess(route.args)
      return
    }
    case "headless": {
      // Hidden commands and unknown bare positionals keep the legacy
      // headless parser byte-for-byte, including its error envelopes.
      const { main: agentMain } = await import("./agent.js")
      await agentMain(route.args)
      return
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
