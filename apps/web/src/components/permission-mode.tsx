import type { PublicPermissionModeValue } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { SessionSecurity } from "../lib/session-mirrors"

const MODE_LABELS: Record<PublicPermissionModeValue, string> = {
  manual: "Manual approval",
  "accept-edits": "Accept edits",
  plan: "Plan mode",
  "full-access": "Full access",
  auto: "Auto",
}

/** Header mode selector; choices come from the server's selectableModes, and
 * a current mode outside that list still renders so the selection is honest. */
export function PermissionModeSelector({
  security,
  disabled,
  onChange,
}: {
  security: SessionSecurity
  disabled: boolean
  onChange: (mode: PublicPermissionModeValue) => void
}) {
  const modes = security.selectableModes.includes(security.permissionMode)
    ? security.selectableModes
    : [security.permissionMode, ...security.selectableModes]
  return (
    <select
      aria-label="Permission mode"
      className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      value={security.permissionMode}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as PublicPermissionModeValue)}
    >
      {modes.map((mode) => (
        <option key={mode} value={mode}>
          {MODE_LABELS[mode]}
        </option>
      ))}
    </select>
  )
}
