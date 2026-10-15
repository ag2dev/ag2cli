/**
 * TodoWriteTool — todo-list management.
 *
 * The model passes a complete new todo list (full replacement, not incremental updates), stored in context.todos.
 * Clear the list when all items are complete so completed items are not kept in the context.
 *
 * The tool only maintains the list; notifications and telemetry are handled elsewhere.
 */

import { z } from "zod/v4"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"

const todoItemSchema = z.object({
  content: z.string().min(1).describe("Todo item in imperative form, such as 'Fix the login bug'"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Status"),
  activeForm: z.string().min(1).optional().describe("Present-progress display text, such as 'Fixing the login bug'; defaults to content"),
})

const inputSchema = z.object({
  todos: z.array(todoItemSchema).describe("Complete todo list (full replacement, not incremental updates)"),
})

export class TodoWriteTool implements Tool<typeof inputSchema> {
  readonly name = "todo_write"
  readonly description =
    "Update the todo list by passing a complete new list (full replacement). Use it to plan and track multi-step tasks. Each item has content, status (pending/in_progress/completed), and activeForm."
  readonly inputSchema = inputSchema

  async call(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolResult> {
    const allDone = args.todos.length > 0 && args.todos.every((t) => t.status === "completed")
    // Clear the list when complete so the next read returns only unfinished items.
    const newTodos = allDone ? [] : args.todos

    if (context) {
      context.todos = newTodos
    }

    if (newTodos.length === 0) {
      return { content: "Todo list cleared (all items are complete)." }
    }

    const lines = newTodos.map((t, i) => {
      const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? "o" : " "
      const label = t.activeForm ?? t.content
      return `${i + 1}. [${mark}] ${label}`
    })
    return { content: `Todo list updated (${newTodos.length} items):\n${lines.join("\n")}` }
  }

  isReadOnly(): boolean {
    return false // Mutates context.todos (state, though not a file).
  }
  isConcurrencySafe(): boolean {
    return false // Full replacement; must not run concurrently.
  }
}
