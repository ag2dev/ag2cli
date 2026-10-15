import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { BrowserClient } from "./lib/browser-client"
import { browserClientId } from "./lib/storage"
import "./styles.css"

async function start(): Promise<void> {
  const demo = import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "1"
  const mock = demo ? (await import("./lib/mock-app-server")).createMockAppServer() : undefined
  const client = new BrowserClient(browserClientId(), mock?.connector)
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App client={client} demo={demo} />
    </StrictMode>,
  )
}

void start()
