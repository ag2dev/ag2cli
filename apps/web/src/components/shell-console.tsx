import { useState } from "react"
import type { BrowserShellTask } from "../lib/session-mirrors"
import type { BrowserClient } from "../lib/browser-client"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"

const STATUS_LABELS: Record<BrowserShellTask["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

/** Session-level console (ruling H): task output lives here only, never in
 * the transcript; each row keeps first-seen order because the mirror's
 * insertion order is the admission order. */
export function ShellConsole({
  client,
  tasks,
  sending,
  error,
}: {
  readonly client: BrowserClient
  readonly tasks: readonly BrowserShellTask[]
  readonly sending: boolean
  readonly error?: string
}) {
  const [command, setCommand] = useState("")
  const run = async (): Promise<void> => {
    if (sending || !command.trim()) return
    setCommand("")
    await client.executeUserShell(command)
  }
  return (
    <section aria-label="Remote shell" className="mb-3 rounded-xl border bg-card px-3.5 py-3">
      <div className="flex items-center gap-2">
        <input
          aria-label="Shell command"
          className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none"
          placeholder="Run a command on the host"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run()
          }}
        />
        <Button
          size="sm"
          className="shrink-0 text-xs"
          aria-label="Run shell command"
          disabled={sending || !command.trim()}
          onClick={() => void run()}
        >
          Run
        </Button>
      </div>
      {error ? <p className="mt-2 text-[11px] text-destructive">{error}</p> : null}
      {tasks.length > 0 ? (
        <div className="mt-2.5 space-y-2">
          {tasks.map((task) => (
            <article key={task.taskId} aria-label={`Shell task ${task.title}`} className="rounded-lg border px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-xs font-medium">{task.title}</span>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {STATUS_LABELS[task.status]}
                </Badge>
                {task.status === "queued" || task.status === "running" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto shrink-0 text-[10px]"
                    aria-label={`Cancel task ${task.taskId}`}
                    onClick={() => void client.cancelShellTask(task.taskId)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
              {task.output ? (
                <pre
                  aria-label={`Task output ${task.taskId}`}
                  className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-[11px]"
                >
                  {task.output}
                </pre>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  )
}
