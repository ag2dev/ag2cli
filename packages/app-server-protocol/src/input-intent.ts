import { AppServerProtocolError } from "./validation.js"
import type { InputIntent, InteractionLeaseScope } from "./types.js"

/** Stable parse failure for the raw input accepted by `session.submit`. */
export class InputIntentParseError extends AppServerProtocolError {
  constructor(message: string) {
    super("invalid_intent", message)
    this.name = "InputIntentParseError"
  }
}

/** Parse raw client text without performing any effect. Effects remain Host-owned. */
export function parseInputIntent(text: string): InputIntent {
  if (text.startsWith("/")) return parseSlashIntent(text)
  if (text.startsWith("!")) return parseShellIntent(text)
  const references = extractFileReferences(text)
  if (references.length > 0) return { kind: "mention", text, references }
  return { kind: "prompt", text }
}

/** Resolve the interaction scope for a raw submit without performing any effect. */
export function interactionLeaseScopeForInput(text: string): InteractionLeaseScope {
  return interactionLeaseScopeForIntent(parseInputIntent(text))
}

export function interactionLeaseScopeForIntent(intent: InputIntent): InteractionLeaseScope {
  return intent.kind === "slash" && intent.name === "permissions" ? "session-control" : "composer"
}

function parseSlashIntent(raw: string): Extract<InputIntent, { kind: "slash" }> {
  const tokens = tokenizeWords(raw.slice(1), "slash command")
  const [name = "", ...args] = tokens
  if (name.length === 0) throw new InputIntentParseError("slash command name must not be empty")
  return { kind: "slash", name: name.toLowerCase(), args, raw }
}

function parseShellIntent(raw: string): Extract<InputIntent, { kind: "shell" }> {
  const command = raw.slice(1).trim()
  if (command.length === 0) throw new InputIntentParseError("! needs a Bash command")
  return { kind: "shell", command, raw }
}

/** Extract whitespace-delimited @path or @glob references from a normal prompt. */
function extractFileReferences(text: string): readonly string[] {
  const references: string[] = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf("@", index)
    if (at < 0) break
    if (at > 0 && !/\s/u.test(text[at - 1] ?? "")) {
      index = at + 1
      continue
    }
    let end = at + 1
    let path: string
    if (text[at + 1] === '"') {
      end = at + 2
      while (end < text.length && text[end] !== '"') end++
      path = text.slice(at + 2, end)
      if (text[end] === '"') end++
    } else {
      while (end < text.length && !/\s/u.test(text[end] ?? "")) end++
      path = text.slice(at + 1, end)
    }
    const range = /^#L?\d+(?:-\d+)?/u.exec(text.slice(end))
    if (range) {
      path += range[0]
      end += range[0].length
    }
    if (path.length > 0) references.push(path)
    index = end
  }
  return references
}

function tokenizeWords(value: string, label: string): string[] {
  const result: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaping = false
  for (const char of value) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/[|;&><`\n\r]/u.test(char)) throw new InputIntentParseError(`${label} does not support shell metacharacters: ${char}`)
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        result.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (escaping) current += "\\"
  if (quote) throw new InputIntentParseError(`${label} has an unclosed quote`)
  if (current.length > 0) result.push(current)
  if (result.length === 0) throw new InputIntentParseError(`${label} must not be empty`)
  return result
}
