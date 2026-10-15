import { Check, Hourglass, X } from "lucide-react"
import { useState } from "react"
import type { BrowserClient } from "../lib/browser-client"
import type { PendingApproval } from "../lib/conversation"
import { Button } from "./ui/button"

export function ApprovalCards({ client, approvals }: { client: BrowserClient; approvals: readonly PendingApproval[] }) {
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set())
  if (approvals.length === 0) return null
  function decide(approval: PendingApproval, decision: "approved" | "denied"): void {
    setDeciding((current) => new Set(current).add(approval.key))
    void client.resolveApproval(approval, decision).finally(() => {
      setDeciding((current) => {
        const next = new Set(current)
        next.delete(approval.key)
        return next
      })
    })
  }
  return (
    <div className="w-full max-w-3xl shrink-0 space-y-2 self-center px-4 md:px-7" aria-label="Pending approvals">
      {approvals.map((approval) => (
        <section
          key={approval.key}
          className="rounded-xl border bg-card p-4 shadow-xs"
          aria-label={approval.ownedBy === "guardian" ? "Guardian approval pending" : `Approve ${approval.name}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <Hourglass size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h2 className="text-sm font-medium">
                  {approval.ownedBy === "guardian" ? "Waiting for the Guardian reviewer" : `Approve ${approval.name}`}
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {approval.ownedBy === "guardian"
                    ? "This ask is reserved for the Guardian reviewer and cannot be resolved from this client."
                    : "This run is paused until the tool call is resolved. Any connected client may decide; the first decision wins."}
                </p>
              </div>
            </div>
            {approval.ownedBy === "guardian" ? null : (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" disabled={deciding.has(approval.key)} onClick={() => decide(approval, "approved")}>
                  <Check size={14} data-icon="inline-start" />
                  Approve
                </Button>
                <Button size="sm" variant="outline" disabled={deciding.has(approval.key)} onClick={() => decide(approval, "denied")}>
                  <X size={14} data-icon="inline-start" />
                  Deny
                </Button>
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  )
}
