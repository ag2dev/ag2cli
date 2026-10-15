import { AlertCircle, ArrowDown, ChevronRight, Terminal } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { ChatEntry } from "../lib/conversation"
import { MessageContent, CopyButton } from "./message-content"
import { Button } from "./ui/button"
import { Skeleton } from "./ui/skeleton"

export function Conversation({
  entries,
  sessionId,
  loading,
  running,
}: {
  entries: readonly ChatEntry[]
  sessionId?: string
  loading: boolean
  running: boolean
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  useEffect(() => {
    nearBottom.current = true
    setShowJump(false)
  }, [sessionId])
  useEffect(() => {
    const element = scroller.current
    if (element && nearBottom.current) element.scrollTop = element.scrollHeight
  }, [entries, running])
  return (
    <div
      className="relative min-h-0 flex-1 overflow-y-auto"
      ref={scroller}
      onScroll={() => {
        const element = scroller.current
        if (!element) return
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
        setShowJump(!nearBottom.current)
      }}
      aria-label="Conversation"
    >
      <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-8 md:px-7">
        {loading ? (
          <div className="flex flex-col gap-4 py-3" role="status" aria-label="Loading conversation">
            <Skeleton className="h-14 w-3/4" />
            <Skeleton className="ml-auto h-20 w-2/3" />
            <Skeleton className="h-14 w-1/2" />
          </div>
        ) : (
          entries.map((entry) => <Message key={entry.id} entry={entry} />)
        )}
        {running && !loading ? (
          <div className="flex items-center gap-2 py-2.5 text-xs text-muted-foreground" role="status">
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
            Working…
          </div>
        ) : null}
      </div>
      {showJump ? (
        <Button
          variant="outline"
          size="icon"
          className="sticky bottom-4 ml-[calc(50%-18px)] rounded-full shadow-lg"
          aria-label="Jump to latest message"
          onClick={() => {
            const element = scroller.current
            if (element) element.scrollTop = element.scrollHeight
            nearBottom.current = true
            setShowJump(false)
          }}
        >
          <ArrowDown size={16} />
        </Button>
      ) : null}
    </div>
  )
}

function Message({ entry }: { entry: ChatEntry }) {
  if (entry.role === "tool")
    return (
      <details className="group mb-6 ml-10 rounded-lg border text-[11px] text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
          <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
          <Terminal size={14} />
          <span>{entry.name ?? "Tool output"}</span>
        </summary>
        <pre className="m-0 overflow-x-auto rounded-b-lg border-t bg-card p-3 whitespace-pre-wrap">{entry.text}</pre>
      </details>
    )
  if (entry.role === "status")
    return (
      <div
        className={`mb-5 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
          entry.tone === "error" ? "text-amber-700 dark:text-amber-500" : "text-muted-foreground"
        }`}
      >
        <AlertCircle size={15} className="mt-0.5 shrink-0" />
        <span>{entry.text}</span>
      </div>
    )
  const user = entry.role === "user"
  return (
    <article
      className={`mb-7 flex gap-3.5 text-[13px] leading-relaxed ${user ? "justify-end" : ""}`}
      aria-label={user ? "Your message" : "Agent response"}
    >
      {entry.role === "assistant" ? (
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border">
          <Terminal size={16} />
        </div>
      ) : null}
      <div className={`min-w-0 ${user ? "max-w-[85%]" : "max-w-full flex-1"}`}>
        {user ? (
          <p className="m-0 break-words rounded-2xl bg-accent px-4 py-2.5 whitespace-pre-wrap">{entry.text}</p>
        ) : (
          <MessageContent text={entry.text} />
        )}
        <div className={`mt-1.5 flex gap-1 text-muted-foreground ${user ? "justify-end" : ""}`}>
          <CopyButton text={entry.text} />
        </div>
      </div>
    </article>
  )
}
