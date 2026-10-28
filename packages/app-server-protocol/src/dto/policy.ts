import { z } from "zod"
import { publicPermissionModeSchema } from "./snapshot.js"
import { nonEmptyStringSchema, nonNegativeIntegerSchema, positiveIntegerSchema } from "./primitives.js"

// Permission policy surface (contract §13). Writes require `session:policy`
// plus the session-control lease and `expectedPolicyRevision` CAS; mode
// choices outside `selectableModes` are rejected by the handler, stale
// revisions as `policy_revision_conflict`.

export const publicPermissionRuleBehaviorSchema = z.enum(["allow", "ask", "deny"])
export type PublicPermissionRuleBehavior = z.infer<typeof publicPermissionRuleBehaviorSchema>

export const publicPermissionRuleSchema = z
  .object({
    name: nonEmptyStringSchema("policy.rule.name"),
    behavior: publicPermissionRuleBehaviorSchema,
  })
  .strict()
export type PublicPermissionRule = z.infer<typeof publicPermissionRuleSchema>

export const publicPermissionPolicySchema = z
  .object({
    sessionId: nonEmptyStringSchema("policy.sessionId"),
    mode: publicPermissionModeSchema,
    policyRevision: nonNegativeIntegerSchema("policy.policyRevision"),
    rules: z.array(publicPermissionRuleSchema),
    selectableModes: z.array(publicPermissionModeSchema),
  })
  .strict()
export type PublicPermissionPolicy = z.infer<typeof publicPermissionPolicySchema>

export const sessionControlLeaseSchema = z
  .object({
    scope: z.literal("session-control"),
    generation: positiveIntegerSchema("policy.lease.generation"),
  })
  .strict()
export type SessionControlLease = z.infer<typeof sessionControlLeaseSchema>

export const sessionGetPermissionPolicyParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("getPermissionPolicy.sessionId"),
  })
  .strict()
export type SessionGetPermissionPolicyParams = z.infer<typeof sessionGetPermissionPolicyParamsSchema>

export const sessionSetPermissionModeParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("setPermissionMode.sessionId"),
    mode: publicPermissionModeSchema,
    expectedPolicyRevision: nonNegativeIntegerSchema("setPermissionMode.expectedPolicyRevision"),
    lease: sessionControlLeaseSchema,
  })
  .strict()
export type SessionSetPermissionModeParams = z.infer<typeof sessionSetPermissionModeParamsSchema>

export const sessionSetPermissionRulesParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("setPermissionRules.sessionId"),
    rules: z.array(publicPermissionRuleSchema),
    expectedPolicyRevision: nonNegativeIntegerSchema("setPermissionRules.expectedPolicyRevision"),
    lease: sessionControlLeaseSchema,
  })
  .strict()
export type SessionSetPermissionRulesParams = z.infer<typeof sessionSetPermissionRulesParamsSchema>

/** Reads and writes share one result: the full policy document, so a writer
 * sees the new `policyRevision` it must carry into its next CAS. */
export const sessionGetPermissionPolicyResultSchema = z
  .object({
    policy: publicPermissionPolicySchema,
  })
  .strict()
export type SessionGetPermissionPolicyResult = z.infer<typeof sessionGetPermissionPolicyResultSchema>

export const sessionSetPermissionModeResultSchema = sessionGetPermissionPolicyResultSchema
export type SessionSetPermissionModeResult = SessionGetPermissionPolicyResult

export const sessionSetPermissionRulesResultSchema = sessionGetPermissionPolicyResultSchema
export type SessionSetPermissionRulesResult = SessionGetPermissionPolicyResult
