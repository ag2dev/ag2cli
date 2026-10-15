const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export function validateHeadlessServerSecurity(input: {
  readonly host: string
  readonly bearerToken?: string
  readonly requireAuth: boolean
  readonly tlsConfigured?: boolean
}): void {
  const hasToken = input.bearerToken !== undefined && input.bearerToken.trim().length > 0
  if (input.requireAuth && !hasToken) {
    throw new Error("AG2CLI_SERVER_TOKEN must be set when AG2CLI_SERVER_REQUIRE_AUTH=1")
  }
  if (!LOOPBACK_HOSTS.has(input.host.toLowerCase()) && !hasToken) {
    throw new Error("AG2CLI_SERVER_TOKEN must be set for a non-loopback headless server")
  }
  if (!LOOPBACK_HOSTS.has(input.host.toLowerCase()) && input.tlsConfigured !== true) {
    throw new Error("A non-loopback headless server must configure TLS (server.tls or AG2CLI_SERVER_TLS_CERT_FILE/KEY_FILE)")
  }
}
