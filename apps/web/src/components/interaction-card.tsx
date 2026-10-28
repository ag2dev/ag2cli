import { Check, HelpCircle, Hourglass, MessageSquare, X } from "lucide-react"
import { useState } from "react"
import type {
  PublicAskUserAnswer,
  PublicAskUserInteraction,
  PublicPendingInteraction,
  PublicToolApprovalInteraction,
} from "@ag2cli/app-server-protocol/dto/interactions.js"
import type { BrowserClient } from "../lib/browser-client"
import { Button } from "./ui/button"

/** One component family for both interaction kinds: a card never outlives its
 * interaction — any resolution event, from any client, closes it. */
export function InteractionCards({
  client,
  interactions,
  askUserCapable,
}: {
  client: BrowserClient
  interactions: readonly PublicPendingInteraction[]
  askUserCapable: boolean
}) {
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set())
  if (interactions.length === 0) return null
  function track(interactionId: string, resolving: () => Promise<void>): void {
    setDeciding((current) => new Set(current).add(interactionId))
    void resolving().finally(() =>
      setDeciding((current) => {
        const next = new Set(current)
        next.delete(interactionId)
        return next
      }),
    )
  }
  return (
    <div className="w-full max-w-3xl shrink-0 space-y-2 self-center px-4 md:px-7" aria-label="Pending interactions">
      {interactions.map((interaction) =>
        interaction.kind === "tool_approval" ? (
          <ToolApprovalCard key={interaction.interactionId} client={client} approval={interaction} deciding={deciding} track={track} />
        ) : (
          <AskUserCard
            key={interaction.interactionId}
            client={client}
            ask={interaction}
            capable={askUserCapable}
            deciding={deciding}
            track={track}
          />
        ),
      )}
    </div>
  )
}

type Tracker = (interactionId: string, resolving: () => Promise<void>) => void

function ToolApprovalCard({
  client,
  approval,
  deciding,
  track,
}: {
  client: BrowserClient
  approval: PublicToolApprovalInteraction
  deciding: ReadonlySet<string>
  track: Tracker
}) {
  const busy = deciding.has(approval.interactionId)
  return (
    <section className="rounded-xl border bg-card p-4 shadow-xs" aria-label={`Approve ${approval.title}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Hourglass size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium">Approve {approval.title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              This run is paused until the tool call is resolved. Any connected client may decide; the first decision wins.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => track(approval.interactionId, () => client.resolveToolApproval(approval, "approved"))}
          >
            <Check size={14} data-icon="inline-start" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => track(approval.interactionId, () => client.resolveToolApproval(approval, "denied"))}
          >
            <X size={14} data-icon="inline-start" />
            Deny
          </Button>
        </div>
      </div>
    </section>
  )
}

function AskUserCard({
  client,
  ask,
  capable,
  deciding,
  track,
}: {
  client: BrowserClient
  ask: PublicAskUserInteraction
  capable: boolean
  deciding: ReadonlySet<string>
  track: Tracker
}) {
  const [selected, setSelected] = useState<Record<string, readonly string[]>>({})
  const busy = deciding.has(ask.interactionId)
  // A read-only placeholder keeps already-listed data visible when the
  // connection lacks the askUser capability; the entry points are hidden.
  if (!capable)
    return (
      <section className="rounded-xl border bg-card p-4 shadow-xs" aria-label="Unsupported question">
        <div className="flex min-w-0 items-start gap-2.5">
          <HelpCircle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium">A question is waiting</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              This App Server cannot answer questions from the web client. Resolve it from a client that supports ask_user.
            </p>
          </div>
        </div>
      </section>
    )
  function toggle(questionId: string, optionId: string, multiSelect: boolean): void {
    setSelected((current) => {
      const existing = current[questionId] ?? []
      if (!multiSelect) return { ...current, [questionId]: existing.includes(optionId) ? [] : [optionId] }
      return {
        ...current,
        [questionId]: existing.includes(optionId) ? existing.filter((id) => id !== optionId) : [...existing, optionId],
      }
    })
  }
  const complete = ask.questions.every((question) => (selected[question.questionId] ?? []).length > 0)
  function resolve(answer: PublicAskUserAnswer): void {
    track(ask.interactionId, () => client.resolveAskUser(ask, answer))
  }
  return (
    <section className="rounded-xl border bg-card p-4 shadow-xs" aria-label="Answer questions">
      <div className="flex min-w-0 items-start gap-2.5">
        <HelpCircle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">Answer questions</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The run is paused until you answer. Any connected client may answer; the first answer wins.
          </p>
          <div className="mt-3 space-y-3">
            {ask.questions.map((question) => (
              <fieldset key={question.questionId} className="min-w-0">
                <legend className="text-xs font-medium">
                  {question.question}
                  {question.multiSelect ? " (choose several)" : ""}
                </legend>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {question.options.map((option) => {
                    const active = (selected[question.questionId] ?? []).includes(option.optionId)
                    return (
                      <Button
                        key={option.optionId}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        aria-pressed={active}
                        disabled={busy}
                        title={option.description}
                        onClick={() => toggle(question.questionId, option.optionId, question.multiSelect)}
                      >
                        {option.label}
                      </Button>
                    )
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button
            size="sm"
            disabled={busy || !complete}
            onClick={() =>
              resolve({
                outcome: "answered",
                answers: ask.questions.map((question) => ({
                  questionId: question.questionId,
                  selectedOptionIds: [...(selected[question.questionId] ?? [])],
                })),
              })
            }
          >
            <Check size={14} data-icon="inline-start" />
            Answer
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve({ outcome: "chat" })}>
            <MessageSquare size={14} data-icon="inline-start" />
            Continue in chat
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve({ outcome: "declined" })}>
            <X size={14} data-icon="inline-start" />
            Decline
          </Button>
        </div>
      </div>
    </section>
  )
}
