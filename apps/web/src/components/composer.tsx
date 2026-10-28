import { ArrowUp, Folder, LoaderCircle, Navigation2, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "./ui/button"

interface ComposerProps {
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  onSteer?: () => void
  onCancel: () => void
  workspaceName?: string
  disabled: boolean
  sending: boolean
  running: boolean
  /** Capability gate: a server without session.steer hides the toggle (§5). */
  steerCapable?: boolean
}

export function Composer({
  draft,
  onChange,
  onSubmit,
  onSteer,
  onCancel,
  workspaceName,
  disabled,
  sending,
  running,
  steerCapable = false,
}: ComposerProps) {
  const [steerMode, setSteerMode] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [draft])
  // A steer toggle with no active run has no target; drop the mode when it ends.
  useEffect(() => {
    if (!running && steerMode) setSteerMode(false)
  }, [running, steerMode])
  function submit(): void {
    if (disabled || sending || !draft.trim()) return
    // While a run is active a plain submit queues for the next run; steer
    // mode redirects the text into the active run instead.
    if (steerMode && running && onSteer) onSteer()
    else onSubmit()
  }
  return (
    <form
      className="w-full rounded-2xl border bg-background p-4 pb-2.5 shadow-xs transition-colors focus-within:border-muted-foreground/60"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={input}
        className="block min-h-11 max-h-50 w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        value={draft}
        aria-label="Message"
        placeholder="Ask anything about your code…"
        rows={2}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="mt-2.5 flex items-center justify-between gap-2.5">
        <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Folder size={14} />
          {workspaceName ?? "Choose a workspace"}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {steerCapable && running ? (
            <Button
              type="button"
              size="icon"
              variant={steerMode ? "default" : "ghost"}
              className="size-[30px] rounded-full"
              aria-pressed={steerMode}
              aria-label="Steer the active response"
              disabled={disabled}
              onClick={() => setSteerMode((current) => !current)}
            >
              <Navigation2 size={15} />
            </Button>
          ) : null}
          {running ? (
            <Button
              size="icon"
              className="size-[30px] shrink-0 rounded-full"
              aria-label="Stop response"
              disabled={disabled}
              onClick={onCancel}
            >
              <Square size={14} fill="currentColor" />
            </Button>
          ) : null}
          <Button
            type="submit"
            size="icon"
            className="size-[30px] shrink-0 rounded-full"
            aria-label={steerMode && running ? "Send steering message" : "Send message"}
            disabled={disabled || sending || !draft.trim()}
          >
            {sending ? <LoaderCircle size={18} className="animate-spin" /> : <ArrowUp size={19} />}
          </Button>
        </div>
      </div>
    </form>
  )
}
