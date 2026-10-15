import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type { RuntimeConfig } from "../config/runtime.js"
import { computeWorkspaceScopeDigest } from "../capabilities/security/workspace.js"

export interface AgentServerHostIdentity {
  readonly configurationFingerprint: string
  readonly securityFingerprint: string
  readonly workspaceFingerprint?: string
}

export interface AgentServerHostIdentityOptions {
  readonly profile: "durable" | "ephemeral"
  readonly runtimeProfile: "headless" | "interactive"
  readonly runtimeConfig: RuntimeConfig
  readonly enableInteractiveShell: boolean
  readonly strictCapabilities: boolean
  readonly loadProjectInstructions: boolean
  readonly workspaceRoot?: string
  readonly additionalDirectories?: readonly string[]
}

/**
 * Build stable, non-secret identity facts for one composed Host.
 *
 * The values are for compatibility checks and diagnostics, not authentication.
 * Provider credentials, server tokens and TLS passphrases are deliberately
 * excluded; a client must never be able to recover them from the wire.
 */
export function createAgentServerHostIdentity(options: AgentServerHostIdentityOptions): AgentServerHostIdentity {
  const configuration = {
    schemaVersion: 1,
    applicationHome: options.runtimeConfig.applicationHome,
    profile: options.profile,
    runtimeProfile: options.runtimeProfile,
    provider: {
      protocol: options.runtimeConfig.provider.protocol,
      compatibility: options.runtimeConfig.provider.compatibility,
      thinking: options.runtimeConfig.provider.thinking,
      reasoningEffort: options.runtimeConfig.provider.reasoningEffort,
      baseURL: options.runtimeConfig.provider.baseURL,
      model: options.runtimeConfig.provider.model,
      contextWindow: options.runtimeConfig.provider.contextWindow,
      maxTokens: options.runtimeConfig.provider.maxTokens,
      openaiBaseURL: options.runtimeConfig.provider.openaiBaseURL,
      openaiModel: options.runtimeConfig.provider.openaiModel,
    },
    compact: options.runtimeConfig.compact,
    maxTurns: options.runtimeConfig.maxTurns,
    responseLanguage: options.runtimeConfig.responseLanguage,
    paths: options.runtimeConfig.paths,
    features: options.runtimeConfig.features,
    composition: {
      strictCapabilities: options.strictCapabilities,
      loadProjectInstructions: options.loadProjectInstructions,
    },
  }
  const security = {
    schemaVersion: 1,
    profile: options.profile,
    runtimeProfile: options.runtimeProfile,
    enableInteractiveShell: options.enableInteractiveShell,
    strictCapabilities: options.strictCapabilities,
    loadProjectInstructions: options.loadProjectInstructions,
  }
  return {
    configurationFingerprint: fingerprint(configuration),
    securityFingerprint: fingerprint(security),
    ...(options.workspaceRoot === undefined
      ? {}
      : {
          workspaceFingerprint: computeWorkspaceScopeDigest(
            resolve(options.workspaceRoot),
            (options.additionalDirectories ?? []).map((directory) => resolve(directory)),
          ),
        }),
  }
}

/** Identity of a composed runtime; serve clients use it for fingerprint checks. */
export function createDefaultServeHostIdentity(runtimeConfig: RuntimeConfig): AgentServerHostIdentity {
  return createAgentServerHostIdentity({
    profile: "durable",
    runtimeProfile: "headless",
    runtimeConfig,
    enableInteractiveShell: true,
    strictCapabilities: false,
    loadProjectInstructions: false,
  })
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
}
