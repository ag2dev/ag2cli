import { Link2, LoaderCircle, PlugZap, X } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"
import type { BrowserClient } from "../lib/browser-client"
import { browserClientId, readPreference, removePreference, writePreference } from "../lib/storage"
import { browserDeviceStorageKey, pairBrowserDevice, pairBrowserDeviceFromLink } from "../lib/pairing"
import { createBrowserDeviceIdentityStore } from "../lib/device-identity"
import { Alert, AlertDescription } from "./ui/alert"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Textarea } from "./ui/textarea"

const identities = createBrowserDeviceIdentityStore()

export function ConnectionSettings({ client, onClose, connected }: { client: BrowserClient; onClose: () => void; connected: boolean }) {
  const [endpoint, setEndpoint] = useState(readPreference("endpoint") ?? "ws://127.0.0.1:8787/app-server")
  const [token, setToken] = useState("")
  const [link, setLink] = useState("")
  const [busy, setBusy] = useState(false)
  const [awaitedEndpoint, setAwaitedEndpoint] = useState<string>()
  const [error, setError] = useState<string>()
  const status = useSyncExternalStore(client.subscribe, client.getSnapshot).status
  useEffect(() => {
    if (awaitedEndpoint === undefined || status !== "connected") return
    writePreference("endpoint", awaitedEndpoint)
    writePreference("auto-connect", "1")
    setAwaitedEndpoint(undefined)
    setBusy(false)
    onClose()
  }, [awaitedEndpoint, status, onClose])
  async function connect(): Promise<void> {
    setBusy(true)
    setError(undefined)
    let address = endpoint.trim()
    let identity
    try {
      if (link.trim()) {
        const paired = await pairBrowserDeviceFromLink(link.trim(), browserClientId())
        identity = paired.identity
        address = paired.link.endpoint
      } else {
        const url = new URL(address)
        if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Use a ws:// or wss:// App Server endpoint.")
        identity = await identities.load(browserDeviceStorageKey(address))
        if (token.trim()) identity = await pairBrowserDevice(address, browserClientId(), token.trim())
      }
      if (identity) await identities.save(browserDeviceStorageKey(address), identity)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
      return
    }
    setToken("")
    setLink("")
    try {
      await client.connect(address, identity ? { deviceIdentity: identity } : {})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
      return
    }
    settle(address)
  }
  function settle(address: string): void {
    const state = client.getSnapshot()
    if (state.status === "connected") {
      writePreference("endpoint", address)
      writePreference("auto-connect", "1")
      setBusy(false)
      onClose()
      return
    }
    // A socket dropped mid-connect keeps retrying in the background; the effect settles it.
    if (state.status === "reconnecting") {
      setAwaitedEndpoint(address)
      return
    }
    setError(state.error ?? "Could not connect to App Server.")
    setBusy(false)
  }
  return (
    <section className="grid min-h-0 flex-1 place-items-center overflow-y-auto bg-muted/40 p-6" aria-label="Connection settings">
      <div className="w-full max-w-md rounded-2xl border bg-background p-8 shadow-xs">
        <div className="flex items-start justify-between">
          <div className="grid size-10 place-items-center rounded-[10px] bg-primary text-primary-foreground">
            <PlugZap size={24} />
          </div>
          <Button variant="ghost" size="icon" aria-label="Close connection settings" onClick={onClose}>
            <X size={18} />
          </Button>
        </div>
        <h1 className="mt-5 text-[23px] leading-snug font-semibold tracking-tight">Connect your workspace</h1>
        <p className="mt-3 mb-6 text-xs leading-relaxed text-muted-foreground">
          Bring your code and conversations together. Connect to an ag2cli App Server to get started.
        </p>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            App Server endpoint
            <Input
              required={!link.trim()}
              type="url"
              autoComplete="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="ws://127.0.0.1:8787/app-server"
              className="h-9 text-xs"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            Pairing token{" "}
            <span className="text-[10px] font-normal leading-relaxed text-muted-foreground">
              Optional when this browser is already paired.
            </span>
            <Input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste a token to pair this browser"
              className="h-9 text-xs"
            />
          </label>
          <details className="mt-1 text-[11px] text-muted-foreground">
            <summary className="inline-flex cursor-pointer items-center gap-1.5 underline underline-offset-3">
              <Link2 size={15} />
              Use a connection link
            </summary>
            <label className="mt-2.5 flex flex-col gap-1.5 text-xs font-medium">
              Connection link
              <Textarea
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="Paste an ag2cli connection link"
                rows={3}
                className="min-h-20 bg-background text-xs"
              />
            </label>
          </details>
          {error ? (
            <Alert variant="destructive" className="text-xs">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-1.5 flex gap-2.5 [&>button]:flex-1">
            {connected ? (
              <Button
                variant="outline"
                onClick={() => {
                  removePreference("auto-connect")
                  client.disconnect()
                  onClose()
                }}
              >
                Disconnect
              </Button>
            ) : null}
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle size={16} className="animate-spin" /> : <PlugZap size={16} />}
              {busy ? "Connecting…" : "Connect workspace"}
            </Button>
          </div>
        </form>
        <p className="mt-6 border-t pt-5 text-[10px] leading-relaxed text-muted-foreground">
          Pairing tokens are never saved. Your device identity stays in this browser.
        </p>
      </div>
    </section>
  )
}
