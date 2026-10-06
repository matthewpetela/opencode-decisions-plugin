// jev - thin OpenCode tool for Jev (System One) structured decisions.
//
// Design note: this plugin deliberately knows nothing about categories,
// taxonomies, or labels. It exposes Jev's typed primitives (noul / choice /
// score) as a single tool and returns the raw answer payload. The calling
// agent is responsible for proposing labels and interpreting results.
//
// Endpoint: OpenCode Console, pay-as-you-go. Requires the Console API key.
//
// Optional plugin options via opencode.jsonc:
//   { "package": "./plugins/jev", "options": { "model": "jev-1.13-free" } }
// Supported: apiKey, endpoint, model, timeoutMs.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/systemone"
const DEFAULT_MODEL = "jev-1.13"
const VALID_MODELS = ["jev-1.13", "jev-1.13-free"]
const DEFAULT_TIMEOUT_MS = 60_000

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    state: {
      type: "string",
      description:
        "The text to evaluate. This is the single 'state' that every question is judged against, so keep it to one document, message, or passage.",
    },
    questions: {
      type: "object",
      description:
        "Map of question ID to a typed question. IDs are yours to choose and are NOT shown to the model. Ask all questions you need in one call: they are evaluated in parallel and in isolation, so adding questions barely changes latency and never causes context-rot between questions.",
      additionalProperties: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["noul", "choice", "score"],
            description:
              "noul = true/false (returns 0-1). choice = pick one option from criteria (returns choice, probabilities, confidence). score = position on an ordered rubric (returns score, legend, probabilities, confidence).",
          },
          instructions: {
            type: ["string", "object"],
            description:
              "The question, phrased as one specific, well-scoped determination a knowledgeable person could make in seconds. Use a string to start; use an object like {question, focus} when you need more structure.",
          },
          criteria: {
            type: ["object", "array"],
            description:
              "Required for choice and score. choice: object of optionName -> description (up to 255 options; include an 'other' or 'none of the above' option when the list may not cover every input). score: ordered array of rubric labels.",
          },
        },
        required: ["type", "instructions"],
        additionalProperties: false,
      },
    },
    model: {
      type: "string",
      enum: VALID_MODELS,
      description:
        "jev-1.13 is billed per input token ($0.042/1M, output free). jev-1.13-free is a limited-time free tier.",
    },
  },
  required: ["state", "questions"],
  additionalProperties: false,
}

// Reads a key OpenCode already has, so no extra setup is needed.
// `opencode` is the pay-as-you-go Console provider; `opencode-go` is the
// subscription provider. Both store a plain `key` in auth.json.
// This reaches into OpenCode's credential store, so options.apiKey and
// OPENCODE_API_KEY both take precedence when you want to override it.
function readStoredKey() {
  const dataDir = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const paths = [join(dataDir, "opencode", "auth.json")]
  const providers = ["opencode", "opencode-go"]

  for (const path of paths) {
    let raw
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(raw)
      for (const id of providers) {
        const entry = parsed?.[id]
        const key = typeof entry === "string" ? entry : entry?.key
        if (typeof key === "string" && key.trim()) return key.trim()
      }
    } catch {
      // malformed auth.json - fall through
    }
  }
  return undefined
}

async function resolveApiKey(ctx, options) {
  if (typeof options.apiKey === "string" && options.apiKey.trim()) return options.apiKey.trim()

  const env = process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_CONSOLE_API_KEY
  if (typeof env === "string" && env.trim()) return env.trim()

  const stored = readStoredKey()
  if (stored) return stored

  // Last resort: a connected Console integration.
  try {
    const integrations = await ctx.integration.list()
    for (const entry of integrations ?? []) {
      const id = entry?.id ?? entry?.integrationID ?? entry
      if (typeof id !== "string" || !/opencode|console|zen/i.test(id)) continue
      const connection = await ctx.integration.connection.active(id)
      if (!connection) continue
      const credential = await ctx.integration.connection.resolve(connection)
      const value =
        typeof credential === "string"
          ? credential
          : credential?.key ?? credential?.token ?? credential?.apiKey ?? credential?.value
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  } catch {
    // ignore
  }

  throw new Error(
    "No OpenCode Console API key found. The plugin looks at options.apiKey, OPENCODE_API_KEY, " +
      "and ~/.local/share/opencode/auth.json in that order. Run /connect in the TUI and choose the " +
      "OpenCode pay-as-you-go provider, or set OPENCODE_API_KEY. Keys: https://opencode.ai/console",
  )
}

export default {
  id: "jev",

  async setup(ctx) {
    const options = ctx.options ?? {}
    const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    const defaultModel = VALID_MODELS.includes(options.model) ? options.model : DEFAULT_MODEL
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS

    const apiKey = await resolveApiKey(ctx, options).catch((err) => err)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "jev_evaluate",
        description:
          "Evaluate text against typed questions using Jev, a System One decision model. Use it for " +
          "categorization, classification, routing, triage, and scoring where you need calibrated " +
          "probabilities and confidence rather than generated prose. Supports boolean (noul), " +
          "multiple-choice (choice, up to 255 options), and rubric (score) questions, all answered in " +
          "one call with a full probability distribution per question. You supply the taxonomy and " +
          "interpret the results; this tool does no labeling itself. Requires an OpenCode Console key.",
        input: INPUT_SCHEMA,
        options: { namespace: "jev" },

        execute: async (input, context) => {
          if (apiKey instanceof Error) return { content: `Jev is not configured: ${apiKey.message}` }

          const { state, questions } = input ?? {}
          if (typeof state !== "string" || !state.trim())
            return { content: "Invalid input: `state` must be a non-empty string." }
          if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0)
            return { content: "Invalid input: `questions` must be a non-empty object." }

          const model = VALID_MODELS.includes(input.model) ? input.model : defaultModel

          for (const [id, q] of Object.entries(questions)) {
            if (!q?.type) return { content: `Invalid input: question "${id}" is missing \`type\`.` }
            if ((q.type === "choice" || q.type === "score") && q.criteria == null)
              return { content: `Invalid input: question "${id}" of type "${q.type}" requires \`criteria\`.` }
          }

          await context.progress?.({ status: `jev: evaluating ${Object.keys(questions).length} question(s)` })

          const controller = new AbortController()
          const onAbort = () => controller.abort()
          context.signal?.addEventListener?.("abort", onAbort, { once: true })
          const timer = setTimeout(() => controller.abort(), timeoutMs)

          try {
            const response = await fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ model, state, questions }),
              signal: controller.signal,
            })

            const text = await response.text()
            if (!response.ok) {
              return {
                content: `Jev request failed: HTTP ${response.status} ${response.statusText}\n${text.slice(0, 2000)}`,
              }
            }

            let payload
            try {
              payload = JSON.parse(text)
            } catch {
              return { content: `Jev returned a non-JSON response:\n${text.slice(0, 2000)}` }
            }

            return {
              content: JSON.stringify({ model: payload.model ?? model, answers: payload.answers, usage: payload.usage }, null, 2),
            }
          } catch (err) {
            if (controller.signal.aborted) return { content: "Jev request aborted or timed out." }
            return { content: `Jev request error: ${err?.message ?? String(err)}` }
          } finally {
            clearTimeout(timer)
            context.signal?.removeEventListener?.("abort", onAbort)
          }
        },
      })
    })
  },
}
