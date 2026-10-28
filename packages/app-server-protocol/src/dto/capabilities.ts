import { z } from "zod"
import { nonEmptyStringSchema } from "./primitives.js"

// Structured server capabilities: what the server can provide, independent
// of authorization (scopes + policy + leases decide that). Optional bits are
// reserved future capabilities a server may already report.

export const appServerCapabilitiesSchema = z.object({
  session: z.object({
    methods: z.array(nonEmptyStringSchema("capabilities.session.methods")),
    eventTypes: z.array(nonEmptyStringSchema("capabilities.session.eventTypes")),
  }),
  interactions: z.object({
    approval: z.boolean(),
    askUser: z.boolean(),
    elicitationForms: z.boolean().optional(),
  }),
  workspace: z.object({
    diff: z.boolean(),
    readFile: z.boolean(),
    searchFiles: z.boolean().optional(),
  }),
  security: z.object({
    permissionModes: z.array(nonEmptyStringSchema("capabilities.security.permissionModes")),
    editableRules: z.boolean(),
  }),
  execution: z.object({
    explicitShell: z.boolean(),
    terminalDisplay: z.boolean().optional(),
  }),
})
export type AppServerCapabilities = z.infer<typeof appServerCapabilitiesSchema>
