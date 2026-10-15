import { useState, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "./ui/button"

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground [&_span]:text-[10px] [&_span]:whitespace-nowrap"
      aria-label={copied ? "Copied" : "Copy message"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setError(false)
        } catch {
          setError(true)
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {error ? <span role="status">Copy unavailable</span> : null}
    </Button>
  )
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/u).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={index} className="rounded-sm bg-accent px-1.5 py-0.5 font-mono text-xs">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  )
}

export function MessageContent({ text }: { text: string }) {
  const parts = text.split(/(^```[^\n]*\n[\s\S]*?(?:^```\s*$|(?![\s\S])))/mu)
  return (
    <div className="min-w-0">
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          const firstBreak = part.indexOf("\n")
          const language = part.slice(3, firstBreak).trim()
          const code = part.slice(firstBreak + 1).replace(/\n```\s*$/u, "")
          return (
            <div className="my-4 overflow-hidden rounded-lg border bg-card" key={index}>
              <div className="flex items-center justify-between border-b bg-accent px-3 py-1.5 text-[10px] text-muted-foreground">
                <span>{language || "Code"}</span>
                <CopyButton text={code} />
              </div>
              <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-relaxed">
                <code>{code}</code>
              </pre>
            </div>
          )
        }
        return part
          .split(/\n\s*\n/u)
          .filter((block) => block.trim())
          .map((block, blockIndex) => {
            const lines = block.trim().split("\n")
            if (lines.every((line) => /^[-*] /u.test(line)))
              return (
                <ul key={`${index}-${blockIndex}`} className="my-3.5 list-disc pl-[22px]">
                  {lines.map((line, lineIndex) => (
                    <li key={lineIndex} className="my-1 break-words">
                      {inline(line.slice(2))}
                    </li>
                  ))}
                </ul>
              )
            if (lines.every((line) => /^\d+\. /u.test(line)))
              return (
                <ol key={`${index}-${blockIndex}`} className="my-3.5 list-decimal pl-[22px]">
                  {lines.map((line, lineIndex) => (
                    <li key={lineIndex} className="my-1 break-words">
                      {inline(line.replace(/^\d+\. /u, ""))}
                    </li>
                  ))}
                </ol>
              )
            const heading = /^(#{1,3}) (.+)$/u.exec(block)
            if (heading)
              return (
                <h3 key={`${index}-${blockIndex}`} className="mt-5 mb-2.5 text-[15px] font-semibold">
                  {inline(heading[2] ?? "")}
                </h3>
              )
            return (
              <p key={`${index}-${blockIndex}`} className="mb-3.5 break-words whitespace-pre-wrap">
                {inline(block)}
              </p>
            )
          })
      })}
    </div>
  )
}
