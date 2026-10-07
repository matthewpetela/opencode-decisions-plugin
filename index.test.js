import { afterEach, describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import plugin from "./index.js"

const originalFetch = globalThis.fetch
const originalOpenAIKey = process.env.OPENAI_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalOpenAIKey
})

async function tools(options = { apiKey: "test-jev-key", openaiApiKey: "test-openai-key" }) {
  const registered = new Map()
  await plugin.setup({
    options,
    tool: { transform: async (callback) => callback({ add: (tool) => registered.set(`${tool.options.namespace}_${tool.name}`, tool) }) },
  })
  return registered
}

describe("decisions plugin", () => {
  it("registers a new tool and retains the Jev tool ID", async () => {
    const registered = await tools()
    assert.equal(plugin.id, "decisions")
    assert.deepEqual([...registered.keys()], ["decisions_evaluate", "jev_jev_evaluate"])
  })

  it("defaults the new tool to Jev and preserves the legacy request", async () => {
    const calls = []
    globalThis.fetch = mock.fn(async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ answers: { relevant: { type: "noul", probability: 0.9 } } }))
    })
    const registered = await tools()
    const questions = { relevant: { type: "noul", instructions: "Is this relevant?" } }
    await registered.get("decisions_evaluate").execute({ input: "Example", questions }, {})
    await registered.get("jev_jev_evaluate").execute({ state: "Example", questions }, {})
    assert.equal(calls.length, 2)
    for (const { url, init } of calls) {
      assert.equal(url, "https://opencode.ai/zen/v1/systemone")
      assert.equal(init.headers.Authorization, "Bearer test-jev-key")
      assert.deepEqual(JSON.parse(init.body), { model: "jev-1.13", state: "Example", questions })
    }
  })

  it("sends OpenAI text and inline image parts with native question arrays", async () => {
    const calls = []
    globalThis.fetch = mock.fn(async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ model: "gpt-6-luna", answers: [{ name: "damage", type: "predicate", probability: 0.92 }] }))
    })
    const registered = await tools()
    const input = [{ role: "user", content: [
      { type: "input_text", text: "Inspect this photo" },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    ] }]
    const questions = [{ type: "predicate", name: "damage", instructions: "Is it damaged?" }]
    const result = await registered.get("decisions_evaluate").execute({ provider: "openai", input, questions }, {})
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://api.openai.com/v1/decisions")
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-openai-key")
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "gpt-6-luna", input, questions })
    assert.equal(JSON.parse(result.content).answers[0].probability, 0.92)
  })

  it("passes choice and score definitions through to the OpenAI endpoint", async () => {
    let body
    globalThis.fetch = mock.fn(async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ answers: [
        { type: "choice", name: "team", choice: "billing", probabilities: [{ value: "billing", probability: 1 }] },
        { type: "score", name: "severity", score: 0.5, probabilities: [{ value: 0, label: "Low", probability: 0.5 }] },
      ] }))
    })
    const questions = [
      { type: "choice", name: "team", instructions: "Which team?", choices: [{ value: "billing", description: "Payments" }] },
      { type: "score", name: "severity", instructions: "How severe?", levels: [{ label: "Low", description: "Minor" }, { label: "High", description: "Major" }] },
    ]
    const registered = await tools()
    const result = await registered.get("decisions_evaluate").execute({ provider: "openai", input: "Charged twice", questions }, {})
    assert.deepEqual(body, { model: "gpt-6-luna", input: "Charged twice", questions })
    assert.equal(JSON.parse(result.content).answers[1].score, 0.5)
  })

  it("rejects unsupported image URLs, wrong model, and missing OpenAI credentials without fetching", async () => {
    globalThis.fetch = mock.fn(() => { throw new Error("unexpected fetch") })
    const registered = await tools({ apiKey: "test-jev-key" })
    delete process.env.OPENAI_API_KEY
    const evaluate = registered.get("decisions_evaluate").execute
    const questions = [{ type: "predicate", name: "damage", instructions: "Is it damaged?" }]
    assert.match((await evaluate({ provider: "openai", input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/photo.png" }] }], questions }, {})).content, /inline base64/)
    assert.match((await evaluate({ provider: "openai", input: "text", questions, model: "jev-1.13" }, {})).content, /only gpt-6-luna/)
    assert.match((await evaluate({ provider: "openai", input: "text", questions }, {})).content, /OPENAI_API_KEY/)
    assert.equal(globalThis.fetch.mock.calls.length, 0)
  })
})
