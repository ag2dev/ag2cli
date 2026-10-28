import type { PublicPresenceClient } from "@ag2cli/app-server-protocol/dto/presence.js"
import type { BrowserLeases } from "../lib/browser-client"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"

const SCOPE_LABELS = { composer: "Composer", "session-control": "Control" } as const

/** Passive per-scope holder badges. Refusals stay in the error-banner family;
 * these only state who holds what, using the shared "held by" vocabulary. */
export function LeaseBadges({ leases, onTakeover }: { leases?: BrowserLeases; onTakeover: () => void }) {
  if (leases === undefined) return null
  return (
    <>
      {(Object.keys(SCOPE_LABELS) as Array<keyof BrowserLeases>).map((scope) => {
        const view = leases[scope]
        const label = SCOPE_LABELS[scope]
        const text =
          view.lease.status === "held"
            ? view.heldBySelf
              ? `You hold ${label.toLowerCase()}`
              : `${label} held by ${view.lease.holder?.name ?? "another client"}`
            : `${label} available`
        return (
          <span key={scope} className="flex items-center gap-1">
            <Badge variant="outline" className="text-[10px]" title={text}>
              {text}
            </Badge>
            {scope === "session-control" && view.lease.status === "held" && !view.heldBySelf ? (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                aria-label="Take control of this session"
                onClick={onTakeover}
              >
                Take control
              </Button>
            ) : null}
          </span>
        )
      })}
    </>
  )
}

/** Roster tooltip copy: every attached client with the local one marked. */
export function presenceRoster(presence: readonly PublicPresenceClient[], selfClientId: string): string {
  return presence.map((client) => `${client.name}${client.clientId === selfClientId ? " (you)" : ""}`).join(", ")
}
