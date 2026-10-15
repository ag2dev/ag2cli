/**
 * BriefTool — proactive status updates from the agent to the user.
 *
 * The agent sends a visible message to the user,
 * unlike a regular tool_result, which is an intermediate artifact for the model.
 *
 * In our CLI, brief output is highlighted with a border for the user.
 * call returns only the message; the CLI applies special rendering based on the tool name.
 */

import { z } from "zod/v4"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool } from "@ag2cli/runtime/ports/tool/contract.js"

const inputSchema = z.object({
  message: z.string().min(1).describe("Message text to show to the user"),
})

export class BriefTool implements Tool<typeof inputSchema> {
  readonly name = "brief"
  readonly description =
    "Send a status update to the user, displayed prominently. Use for important notices, progress summaries, or prompts that need the user's attention; this is distinct from regular tool output."
  readonly inputSchema = inputSchema

  async call(args: z.infer<typeof inputSchema>): Promise<ToolResult> {
    // Return the content unchanged; the client chooses how to display it based on the tool name.
    return { content: args.message }
  }

  isReadOnly(): boolean {
    return true
  }
  isConcurrencySafe(): boolean {
    return true
  }
}

/** Brief tool name constant, used by the CLI to recognize special rendering. */
export const BRIEF_TOOL_NAME = "brief"
