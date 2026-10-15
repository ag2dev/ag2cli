/**
 * SkillTool — load and return skill instructions.
 *
 * After seeing the skill list in the system prompt, the model
 * calls this tool to get a skill's instruction body and follow its steps.
 *
 * The tool does not execute the skill workflow itself; it returns the instruction body
 * as a tool_result for the model to read and follow. This is instruction injection,
 * not programmatic execution, because skill bodies are natural-language steps.
 *
 * Design:
 *  - Inject the skills list at construction time. A getter may also be passed so every call() reads the latest list,
 *    supporting hot reload: newly added or edited skill files are visible without restarting.
 *  - call({name}) matches the name exactly. If not found, return is_error with the available skills so the model can correct itself.
 *  - isReadOnly=true: reading instructions has no side effects and can run concurrently (no file writes or state changes).
 */

import { z } from "zod/v4"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool } from "@ag2cli/runtime/ports/tool/contract.js"
import type { Skill } from "../skills/store.js"

const inputSchema = z.object({
  name: z.string().describe("Name of the skill to use (see the skill list)"),
})

export class SkillTool implements Tool<typeof inputSchema> {
  readonly name = "skill"
  readonly description =
    "Use a loaded skill by retrieving its instruction body and following the steps. Call this tool when a skill in the skill list " +
    "applies to the current task. The tool returns detailed instructions for you to follow."
  readonly inputSchema = inputSchema

  private getSkills: () => ReadonlyArray<Skill>

  constructor(deps: { skills: ReadonlyArray<Skill> | (() => ReadonlyArray<Skill>) }) {
    this.getSkills = typeof deps.skills === "function" ? deps.skills : () => deps.skills as ReadonlyArray<Skill>
  }

  async call(args: z.infer<typeof inputSchema>): Promise<ToolResult> {
    const skills = this.getSkills()
    // Skill names in the catalog are lowercase-deduplicated (store.ts); the
    // model sometimes echoes a name back with different casing, so matching
    // here must tolerate that instead of failing a call it could satisfy.
    const found = skills.find((s) => s.name.toLowerCase() === args.name.toLowerCase())
    if (!found) {
      const available = skills.map((s) => s.name).join(", ") || "(no skills loaded)"
      return {
        content: `Skill not found: ${args.name}. Available: ${available}`,
        isError: true,
      }
    }
    return {
      content: `[Skill: ${found.name}]\n${found.body}`,
    }
  }

  /** Reading instructions has no side effects and can run concurrently. */
  isReadOnly(): boolean {
    return true
  }
  isConcurrencySafe(): boolean {
    return true
  }
}
