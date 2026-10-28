import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, FileText, RefreshCw, X } from "lucide-react"
import type { BrowserClient, BrowserWorkspaceDiff, BrowserWorkspaceFileView } from "../lib/browser-client"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"
import { Spinner } from "./ui/spinner"

const OPERATION_LABELS = { add: "Add", delete: "Delete", modify: "Modify", move: "Move", copy: "Copy" } as const

/** Read-only workspace browsing (ruling G): the diff list doubles as the file
 * selector — entries open the viewer, there is no manual path input, and the
 * patch text renders as display data only. */
export function WorkspaceBrowser({
  client,
  diff,
  file,
  readFileCapable,
}: {
  client: BrowserClient
  diff?: BrowserWorkspaceDiff
  file?: BrowserWorkspaceFileView
  readFileCapable: boolean
}) {
  const [open, setOpen] = useState(false)
  // First open loads page one; later refreshes are explicit.
  useEffect(() => {
    if (open && diff === undefined) void client.loadWorkspaceDiff()
  }, [open, diff, client])
  return (
    <section className="w-full max-w-3xl shrink-0 space-y-2 self-center px-4 md:px-7" aria-label="Workspace changes">
      {open ? (
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label="Hide workspace changes"
              onClick={() => setOpen(false)}
            >
              <ChevronDown size={14} />
            </Button>
            <span className="text-xs font-medium">Workspace changes</span>
            {diff && !diff.loading ? <span className="text-[10px] text-muted-foreground">{diff.changes.length} files</span> : null}
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto size-6 shrink-0"
              aria-label="Refresh workspace changes"
              disabled={diff?.loading}
              onClick={() => void client.loadWorkspaceDiff()}
            >
              <RefreshCw size={13} />
            </Button>
          </div>
          {diff?.loading ? (
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading workspace changes…
            </div>
          ) : null}
          {diff?.error ? <p className="px-1 py-2 text-xs text-destructive">{diff.error}</p> : null}
          {diff && !diff.loading && !diff.error ? (
            <ul className="mt-2 space-y-1.5">
              {diff.changes.map((change) => (
                <li
                  key={`${change.operation}:${change.path}`}
                  className="flex min-w-0 items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5"
                  aria-label={`Changed file ${change.path}`}
                >
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {OPERATION_LABELS[change.operation]}
                  </Badge>
                  {readFileCapable ? (
                    <button
                      type="button"
                      className="min-w-0 truncate text-left text-xs hover:underline"
                      aria-label={`View ${change.path}`}
                      title={change.path}
                      onClick={() => void client.openWorkspaceFile(change.path)}
                    >
                      {change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate text-xs" title={change.path}>
                      {change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
                    </span>
                  )}
                  {change.fileKind === "binary" ? <span className="shrink-0 text-[10px] text-muted-foreground">binary</span> : null}
                  {change.additions !== undefined ? (
                    <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">+{change.additions}</span>
                  ) : null}
                  {change.deletions !== undefined ? (
                    <span className="shrink-0 text-[10px] text-red-600 dark:text-red-400">−{change.deletions}</span>
                  ) : null}
                  {change.gitPatch !== undefined ? (
                    <details className="ml-auto shrink-0">
                      <summary className="cursor-pointer text-[10px] text-muted-foreground">Patch</summary>
                      <pre
                        className="mt-1 max-h-48 overflow-auto rounded-lg bg-muted p-2 text-[10px] leading-relaxed"
                        aria-label={`Patch for ${change.path}`}
                      >
                        {change.gitPatch}
                      </pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {diff?.nextCursor !== undefined && !diff.loading ? (
            <Button variant="outline" size="sm" className="mt-2 h-7 text-[11px]" onClick={() => void client.loadMoreWorkspaceDiff()}>
              Load more changes
            </Button>
          ) : null}
          {file ? (
            <FileViewer file={file} onLoadMore={() => void client.readMoreWorkspaceFile()} onClose={() => client.closeWorkspaceFile()} />
          ) : null}
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] text-muted-foreground"
          aria-label="Show workspace changes"
          onClick={() => setOpen(true)}
        >
          <ChevronRight size={13} />
          Workspace changes
        </Button>
      )}
    </section>
  )
}

function FileViewer({ file, onLoadMore, onClose }: { file: BrowserWorkspaceFileView; onLoadMore: () => void; onClose: () => void }) {
  const lines = (file.content ?? "").split("\n")
  const from = file.startLine ?? 1
  const through = from + lines.length - 1
  return (
    <div className="mt-3 rounded-xl border bg-background p-3" aria-label={`File viewer ${file.path}`}>
      <div className="flex items-center gap-2">
        <FileText size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs font-medium" title={file.path}>
          {file.path}
        </span>
        <Button variant="ghost" size="icon" className="ml-auto size-6 shrink-0" aria-label="Close file viewer" onClick={onClose}>
          <X size={13} />
        </Button>
      </div>
      {file.loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Reading file…
        </div>
      ) : null}
      {file.error ? <p className="py-2 text-xs text-destructive">{file.error}</p> : null}
      {!file.loading && !file.error && file.kind === "binary" ? (
        <p className="py-2 text-xs text-muted-foreground">Binary file · {file.sizeBytes ?? 0} bytes</p>
      ) : null}
      {!file.loading && !file.error && file.kind === "text" && file.content !== undefined ? (
        <>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Lines {from}–{through}
            {file.totalLines !== undefined ? ` of ${file.totalLines}` : ""}
          </p>
          <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-muted p-2.5 text-[11px] leading-relaxed" aria-label="File content">
            {file.content}
          </pre>
        </>
      ) : null}
      {file.nextStartLine !== undefined && !file.loading && !file.error ? (
        <Button variant="outline" size="sm" className="mt-2 h-7 text-[11px]" onClick={onLoadMore}>
          Load more lines
        </Button>
      ) : null}
    </div>
  )
}
