import { ChevronRight, Folder, MessageSquare, Search, SquarePen, Terminal } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "../lib/utils"
import type { BrowserClientState } from "../lib/browser-client"
import type { PendingApproval } from "../lib/conversation"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar"
import { Kbd } from "./ui/kbd"

export function workspaceName(root: string): string {
  return root.replace(/\/$/u, "").split(/[/\\]/u).at(-1) || root
}

interface AppSidebarProps {
  state: BrowserClientState
  approvals: readonly PendingApproval[]
  onNew: (workspaceId?: string) => void
  onSelect: (sessionId: string) => void
  onConnection: () => void
}

export function AppSidebar({ state, approvals, onNew, onSelect, onConnection }: AppSidebarProps) {
  const [search, setSearch] = useState("")
  // Fold state lives outside the search-swapped subtree so it survives body swaps.
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const input = useRef<HTMLInputElement>(null)
  const { setOpenMobile } = useSidebar()
  const query = search.trim().toLowerCase()
  const matches = query ? state.sessions.filter((session) => (session.title ?? "Untitled conversation").toLowerCase().includes(query)) : []
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [])
  function select(sessionId: string): void {
    onSelect(sessionId)
    setOpenMobile(false)
  }
  return (
    <Sidebar collapsible="icon" aria-label="Navigation">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Terminal size={15} />
          </div>
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">ag2cli</span>
          <span className="ml-auto rounded-sm border border-sidebar-border px-1 py-px text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            Workspace
          </span>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="New conversation" onClick={() => onNew()}>
              <SquarePen />
              <span>New conversation</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="relative group-data-[collapsible=icon]:hidden">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <SidebarInput
            ref={input}
            aria-label="Search conversations"
            placeholder="Search conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 pl-8 text-xs"
          />
          <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">⌘K</Kbd>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {query ? (
          <nav aria-label="Search results">
            <SidebarGroup>
              <SidebarGroupLabel>Search results ({matches.length})</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {matches.length ? (
                    matches.map((session) => {
                      const workspace = state.workspaces.find((item) => item.workspaceId === session.workspaceId)
                      return (
                        <SidebarMenuItem key={session.sessionId}>
                          <SidebarMenuButton
                            isActive={state.activeSessionId === session.sessionId}
                            onClick={() => select(session.sessionId)}
                            aria-current={state.activeSessionId === session.sessionId ? "page" : undefined}
                          >
                            <MessageSquare />
                            <span>{session.title ?? "Untitled conversation"}</span>
                            {workspace ? (
                              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                {workspaceName(workspace.workspaceRoot)}
                              </span>
                            ) : null}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })
                  ) : (
                    <li className="px-2 py-1 text-xs text-muted-foreground">No conversations found.</li>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </nav>
        ) : (
          <nav aria-label="Conversations">
            {state.workspaces.length ? (
              state.workspaces.map((workspace) => {
                const name = workspaceName(workspace.workspaceRoot)
                const sessions = state.sessions.filter((session) => session.workspaceId === workspace.workspaceId)
                const isFolded = folded[workspace.workspaceId] ?? false
                return (
                  <SidebarGroup key={workspace.workspaceId}>
                    <SidebarGroupLabel
                      render={<button type="button" aria-expanded={!isFolded} className="text-left" />}
                      title={workspace.workspaceRoot}
                      onClick={() => setFolded((current) => ({ ...current, [workspace.workspaceId]: !isFolded }))}
                    >
                      <ChevronRight className={cn("transition-transform", !isFolded && "rotate-90")} />
                      <Folder />
                      <span className="truncate">{name}</span>
                      {workspace.availability === "unavailable" ? (
                        <span
                          className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-600 dark:bg-amber-500"
                          title="Workspace unavailable"
                        />
                      ) : null}
                    </SidebarGroupLabel>
                    <SidebarGroupAction
                      aria-label={`New conversation in ${name}`}
                      title={`New conversation in ${name}`}
                      onClick={() => onNew(workspace.workspaceId)}
                    >
                      <SquarePen />
                    </SidebarGroupAction>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {isFolded ? null : sessions.length ? (
                          sessions.map((session) => (
                            <SidebarMenuItem key={session.sessionId}>
                              <SidebarMenuButton
                                isActive={state.activeSessionId === session.sessionId}
                                tooltip={session.title ?? "Untitled conversation"}
                                onClick={() => select(session.sessionId)}
                                aria-current={state.activeSessionId === session.sessionId ? "page" : undefined}
                              >
                                <MessageSquare />
                                <span>{session.title ?? "Untitled conversation"}</span>
                                {state.activeSessionId === session.sessionId && approvals.length > 0 ? (
                                  <span className="ml-auto size-1.5 shrink-0 rounded-full bg-destructive" title="Waiting for approval" />
                                ) : null}
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          ))
                        ) : (
                          <li className="px-2 py-1 text-xs text-muted-foreground">No conversations yet.</li>
                        )}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                )
              })
            ) : (
              <SidebarGroup>
                <SidebarGroupContent>
                  <p className="px-2 py-1 text-xs text-muted-foreground">Connect to see your workspaces.</p>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </nav>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Connection settings"
              onClick={() => {
                onConnection()
                setOpenMobile(false)
              }}
            >
              <Terminal />
              <span>App Server</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                <i
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    state.status === "connected" ? "bg-emerald-600 dark:bg-emerald-500" : "bg-muted-foreground",
                  )}
                />
                {state.status === "connected" ? "Connected" : "Offline"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
