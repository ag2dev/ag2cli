#!/usr/bin/env bun
/**
 * Emits one JSON Schema document per App Server wire method (params) and notification (payload)
 * into `dist/schema/`, generated from the descriptive Zod schemas in `src/schema.ts` via
 * `zod-to-json-schema`. These files are a build artifact for non-TypeScript App Server clients;
 * nothing in this repository reads them back at runtime.
 */
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { zodToJsonSchema } from "zod-to-json-schema"
import { APP_SERVER_METHOD_PARAM_SCHEMAS, APP_SERVER_METHOD_RESULT_SCHEMAS, APP_SERVER_NOTIFICATION_SCHEMAS } from "../src/schema.js"

const outputDir = path.join(import.meta.dirname, "..", "dist", "schema")

async function main(): Promise<void> {
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(path.join(outputDir, "methods"), { recursive: true })
  await mkdir(path.join(outputDir, "notifications"), { recursive: true })

  for (const [method, schema] of Object.entries(APP_SERVER_METHOD_PARAM_SCHEMAS)) {
    const jsonSchema = zodToJsonSchema(schema, { name: `${method}.params`, target: "jsonSchema7" })
    await writeFile(path.join(outputDir, "methods", `${method}.params.json`), `${JSON.stringify(jsonSchema, null, 2)}\n`)
  }

  for (const [method, schema] of Object.entries(APP_SERVER_METHOD_RESULT_SCHEMAS)) {
    const jsonSchema = zodToJsonSchema(schema, { name: `${method}.result`, target: "jsonSchema7" })
    await writeFile(path.join(outputDir, "methods", `${method}.result.json`), `${JSON.stringify(jsonSchema, null, 2)}\n`)
  }

  for (const [method, schema] of Object.entries(APP_SERVER_NOTIFICATION_SCHEMAS)) {
    const jsonSchema = zodToJsonSchema(schema, { name: `${method}.params`, target: "jsonSchema7" })
    await writeFile(path.join(outputDir, "notifications", `${method}.params.json`), `${JSON.stringify(jsonSchema, null, 2)}\n`)
  }

  console.log(
    `Wrote ${Object.keys(APP_SERVER_METHOD_PARAM_SCHEMAS).length} method schemas, ${Object.keys(APP_SERVER_METHOD_RESULT_SCHEMAS).length} result schemas, and ${Object.keys(APP_SERVER_NOTIFICATION_SCHEMAS).length} notification schemas to ${outputDir}`,
  )
}

await main()
