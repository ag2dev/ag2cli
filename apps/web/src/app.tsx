import { AlertCircle, Code2, Compass, Folder, Monitor, Moon, PlugZap, Sparkles, Sun, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { BrowserClient } from "./lib/browser-client"
import { pendingApprovals, projectChat } from "./lib/conversation"
import { createBrowserDeviceIdentityStore } from "./lib/device-identity"
import { browserDeviceStorageKey } from "./lib/pairing"
import { browserClientId, readPreference, writePreference } from "./lib/storage"
import { isDarkTheme, nextThemeMode, parseThemeMode, type ThemeMode } from "./lib/theme"
import { ApprovalCards } from "./components/approval-card"
import { AppSidebar, workspaceName } from "./components/sidebar"
import { Composer } from "./components/composer"
import { Conversation } from "./components/conversation"
import { ConnectionSettings } from "./components/connection-settings"
import { Alert, AlertAction, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar"
import { Spinner } from "./components/ui/spinner"

const suggestions = [
  {
    icon: Compass,
    title: "Explore this codebase",
    description: "Understand how everything fits together",
    prompt: "Explore this codebase and explain its architecture and main entry points.",
  },
  {
    icon: Code2,
    title: "Build something new",
    description: "Turn an idea into a working feature",
    prompt: "Help me implement a new feature. First, inspect the project and suggest a small, useful improvement.",
  },
  {
    icon: Sparkles,
    title: "Review my changes",
    description: "Find bugs before they become problems",
    prompt: "Review my current changes for correctness, regressions, and missing tests.",
  },
]

export function App({ client: injectedClient, demo = false }: { client?: BrowserClient; demo?: boolean } = {}) {
  const [client] = useState(() => injectedClient ?? new BrowserClient(browserClientId()))
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<ThemeMode>(() => parseThemeMode(readPreference("theme")))
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  const entries = useMemo(() => projectChat(state.events, state.transientEvents), [state.events, state.transientEvents])
  const approvals = useMemo(() => pendingApprovals(state.events), [state.events])
  const workspace = state.workspaces.find((item) => item.workspaceId === state.selectedWorkspaceId)
  const session = state.sessions.find((item) => item.sessionId === state.activeSessionId)
  const draftKey = state.activeSessionId ?? `workspace:${state.selectedWorkspaceId ?? "none"}`
  const draft = drafts[draftKey] ?? ""
  const connected = state.status === "connected"
  const running = state.pendingCommands.length > 0
  const empty = !state.loadingSession && entries.length === 0
  const dark = isDarkTheme(mode, systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    writePreference("theme", mode)
  }, [dark, mode])
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const update = (): void => setSystemDark(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  useEffect(() => {
    if (demo) {
      void client.connect("ws://127.0.0.1:8787/app-server")
      return () => client.disconnect()
    }
    const address = readPreference("endpoint")
    if (!address || readPreference("auto-connect") !== "1") return
    let cancelled = false
    void createBrowserDeviceIdentityStore()
      .load(browserDeviceStorageKey(address))
      .then((identity) => {
        // A manual connect through settings wins over the remembered endpoint.
        if (cancelled || client.getSnapshot().status !== "disconnected") return
        void client.connect(address, identity ? { deviceIdentity: identity } : {})
      })
    return () => {
      cancelled = true
      client.disconnect()
    }
  }, [client, demo])
  function changeDraft(value: string): void {
    setDrafts((current) => ({ ...current, [draftKey]: value }))
  }
  async function submit(): Promise<void> {
    const key = draftKey
    const value = draft
    const accepted = await client.send(value)
    setDrafts((current) => {
      if (!accepted || current[key] !== value) return current
      return { ...current, [key]: "" }
    })
  }
  const composer = (
    <Composer
      draft={draft}
      onChange={changeDraft}
      onSubmit={() => void submit()}
      onCancel={() => void client.cancel()}
      workspaceName={workspace ? workspaceName(workspace.workspaceRoot) : undefined}
      disabled={!connected || workspace?.availability !== "available" || state.loadingSession}
      sending={state.sending}
      running={running}
    />
  )
  return (
    <SidebarProvider>
      <AppSidebar
        state={state}
        approvals={approvals}
        onNew={(workspaceId) => {
          client.newConversation(workspaceId)
          setSettingsOpen(false)
        }}
        onSelect={(sessionId) => {
          void client.selectSession(sessionId)
          setSettingsOpen(false)
        }}
        onConnection={() => setSettingsOpen(true)}
      />
      <SidebarInset className="min-w-0">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <SidebarTrigger aria-label="Toggle sidebar" />
            <div className="min-w-0">
              <strong className="block truncate text-sm font-medium">{session?.title ?? "New conversation"}</strong>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                {workspace ? (
                  <>
                    <Folder size={12} />
                    {workspaceName(workspace.workspaceRoot)}
                  </>
                ) : (
                  "Your coding workspace"
                )}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {demo ? (
              <Badge variant="outline" className="text-[10px]">
                Demo
              </Badge>
            ) : null}
            {state.presence.length > 1 ? (
              <Badge variant="secondary" className="text-[10px]" title="Connected clients">
                {state.presence.length} clients
              </Badge>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Theme is ${mode}. Switch to ${nextThemeMode(mode)}`}
              onClick={() => setMode(nextThemeMode(mode))}
            >
              {mode === "light" ? <Sun size={17} /> : mode === "dark" ? <Moon size={17} /> : <Monitor size={17} />}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Connection settings" onClick={() => setSettingsOpen(!settingsOpen)}>
              <PlugZap size={17} />
            </Button>
            {state.activeSessionId ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete conversation"
                disabled={running || state.sending}
                onClick={() => {
                  if (window.confirm("Delete this conversation? This cannot be undone.")) void client.deleteSession(state.activeSessionId!)
                }}
              >
                <Trash2 size={16} />
              </Button>
            ) : null}
          </div>
        </header>
        {state.status === "reconnecting" && !settingsOpen ? (
          <Alert role="status" className="mx-4 mt-3 md:mx-7">
            <Spinner className="size-4" />
            <AlertTitle>Reconnecting to your workspace…</AlertTitle>
          </Alert>
        ) : null}
        {state.error && !settingsOpen ? (
          <Alert variant="destructive" className="mx-4 mt-3 md:mx-7">
            <AlertCircle size={16} />
            <AlertTitle>{state.error}</AlertTitle>
            <AlertAction>
              <Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => client.dismissError()}>
                <X size={15} />
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        {settingsOpen ? (
          <ConnectionSettings client={client} connected={connected} onClose={() => setSettingsOpen(false)} />
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col">
            {empty ? (
              <Empty className="mx-auto w-full max-w-3xl flex-1">
                {connected ? (
                  <>
                    <EmptyHeader>
                      <EmptyMedia variant="icon" className="mb-5 size-11 rounded-xl border bg-card">
                        <Sparkles size={20} strokeWidth={1.5} />
                      </EmptyMedia>
                      <p className="text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
                        Your ideas. Your code. Your workspace.
                      </p>
                      <EmptyTitle className="text-2xl font-medium tracking-tight md:text-3xl">What are we building?</EmptyTitle>
                      <EmptyDescription>A little clarity, a new feature, or the next big thing.</EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent className="mt-2 max-w-2xl">
                      {composer}
                      <div className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-3">
                        {suggestions.map(({ icon: Icon, title, description, prompt }) => (
                          <button
                            key={title}
                            type="button"
                            className="flex flex-col gap-1 rounded-lg border bg-background p-4 text-left transition-colors hover:border-muted-foreground/60 hover:bg-accent"
                            onClick={() => changeDraft(prompt)}
                          >
                            <Icon size={18} strokeWidth={1.6} className="mb-1.5 text-muted-foreground" />
                            <span className="text-xs font-medium">{title}</span>
                            <span className="text-[11px] leading-relaxed text-muted-foreground">{description}</span>
                          </button>
                        ))}
                      </div>
                    </EmptyContent>
                  </>
                ) : (
                  <>
                    <EmptyHeader>
                      <EmptyMedia variant="icon" className="mb-4 size-11 rounded-xl border bg-card">
                        <PlugZap size={20} strokeWidth={1.5} />
                      </EmptyMedia>
                      <EmptyTitle className="text-2xl font-medium tracking-tight md:text-3xl">Connect your workspace</EmptyTitle>
                      <EmptyDescription>
                        Bring your code and conversations together. Connect to an ag2cli App Server to get started.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button onClick={() => setSettingsOpen(true)}>
                        <PlugZap size={16} />
                        {state.status === "connecting" || state.status === "reconnecting"
                          ? "Connecting to workspace…"
                          : "Connect a workspace"}
                      </Button>
                    </EmptyContent>
                  </>
                )}
              </Empty>
            ) : (
              <>
                <Conversation entries={entries} sessionId={state.activeSessionId} loading={state.loadingSession} running={running} />
                <ApprovalCards client={client} approvals={approvals} />
                <div className="w-full max-w-3xl shrink-0 self-center px-4 pb-4 md:px-7">
                  {composer}
                  <p className="mt-2.5 text-center text-[10px] text-muted-foreground">Review generated changes before applying them.</p>
                </div>
              </>
            )}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}
