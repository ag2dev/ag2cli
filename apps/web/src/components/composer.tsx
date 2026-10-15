import { ArrowUp, Folder, LoaderCircle, Square } from "lucide-react"
import { useEffect, useRef } from "react"
import { Button } from "./ui/button"

interface ComposerProps {
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  workspaceName?: string
  disabled: boolean
  sending: boolean
  running: boolean
}

export function Composer({ draft, onChange, onSubmit, onCancel, workspaceName, disabled, sending, running }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [draft])
  return (
    <form
      className="w-full rounded-2xl border bg-background p-4 pb-2.5 shadow-xs transition-colors focus-within:border-muted-foreground/60"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && !sending && !running && draft.trim()) onSubmit()
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
            if (!disabled && !sending && !running && draft.trim()) onSubmit()
          }
        }}
      />
      <div className="mt-2.5 flex items-center justify-between gap-2.5">
        <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Folder size={14} />
          {workspaceName ?? "Choose a workspace"}
        </span>
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
        ) : (
          <Button
            type="submit"
            size="icon"
            className="size-[30px] shrink-0 rounded-full"
            aria-label="Send message"
            disabled={disabled || sending || !draft.trim()}
          >
            {sending ? <LoaderCircle size={18} className="animate-spin" /> : <ArrowUp size={19} />}
          </Button>
        )}
      </div>
    </form>
  )
}
