import type { PublicInputSnapshot } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import { X } from "lucide-react"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"

const DISPLAY_LIMIT = 3

const KIND_LABEL: Record<string, string> = {
  prompt: "Prompt",
  notification: "Notification",
  steer: "Steer",
}

/** FIFO queue strip above the composer. The mirror's acceptedAt order is the
 * presentation order; consumption priority belongs to the server, so the
 * client renders kind labels without reordering. */
export function QueuedInputs({
  inputs,
  canCancel,
  onCancel,
}: {
  readonly inputs: readonly PublicInputSnapshot[]
  readonly canCancel: boolean
  readonly onCancel: (inputId: string) => void
}) {
  if (inputs.length === 0) return null
  const visible = inputs.slice(0, DISPLAY_LIMIT)
  const hidden = inputs.length - visible.length
  return (
    <div className="w-full max-w-3xl shrink-0 space-y-2 self-center px-4 md:px-7" aria-label="Queued messages">
      {visible.map((input) => (
        <div
          key={input.inputId}
          className="flex items-center justify-between gap-3 rounded-xl border bg-card px-3.5 py-2"
          aria-label={`Queued ${KIND_LABEL[input.kind] ?? input.kind}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {KIND_LABEL[input.kind] ?? input.kind}
            </Badge>
            <span className="truncate text-xs text-muted-foreground">{input.text}</span>
          </span>
          {canCancel ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label="Cancel queued message"
              onClick={() => onCancel(input.inputId)}
            >
              <X size={13} />
            </Button>
          ) : null}
        </div>
      ))}
      {hidden > 0 ? <p className="text-center text-[10px] text-muted-foreground">+{hidden} more</p> : null}
    </div>
  )
}
