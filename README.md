# OpenCode Decisions plugin

Evaluate text with [Jev](https://docs.typesafe.ai/) or text and images with [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) from an OpenCode V2 agent.

Both APIs answer **typed questions** with probabilities rather than generating prose. The plugin forwards provider-native questions to [OpenCode Console Jev](https://opencode.ai/v2/docs/console/models/#jev) or OpenAI's `/v1/decisions` endpoint; the calling agent chooses categories and interprets the answers. `decisions_evaluate` defaults to Jev; select `provider: "openai"` for image inputs or OpenAI's `predicate`/`choice`/`score` API. The existing `jev_jev_evaluate` tool remains available for compatibility.

## Why a tool?

Decision models return answers rather than assistant messages or tool calls, so they cannot serve as an OpenCode agent's conversational model. The agent uses the tool while keeping responsibility for the taxonomy and final labels.

No separate Jev subagent or skill is required.

## Requirements

- OpenCode **v2.0.0+** (developed against 2.0.18)
- An [OpenCode Console API key](https://opencode.ai/console) for Jev, or an [OpenAI API key](https://platform.openai.com/api-keys) for OpenAI Decisions — see [Credentials](#credentials).

## Install

**Recommended:** install directly from GitHub with OpenCode's plugin manager:

```sh
opencode plugin add github:matthewpetela/opencode-decisions-plugin
opencode plugin list
```

The new tool ID is `decisions_evaluate`; the original `jev_jev_evaluate` is retained for existing agents. OpenCode manages the global plugin entry and Git-backed updates. Never embed an access token in the repository URL. If you installed the old Git package, remove its configured entry before adding the renamed package to avoid loading both copies.

For a project-specific install, put a Git package spec in the project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:matthewpetela/opencode-decisions-plugin"]
}
```

Or clone for local development into a documented auto-discovery location:

```sh
git clone https://github.com/matthewpetela/opencode-decisions-plugin.git \
  ~/.config/opencode/plugins/decisions
```

Do **not** both clone into an auto-discovered plugin directory and add the Git package entry; choose one installation method. If a new tool does not appear, run `opencode plugin check` or `opencode service restart`.

## Credentials

**Jev** credentials are resolved in this order, first hit wins:

1. `options.apiKey` (supported, but **do not** put a literal key in a checked-in config)
2. `OPENCODE_API_KEY` (or `OPENCODE_CONSOLE_API_KEY`) in the OpenCode **server process** environment
3. A locally stored `opencode` or `opencode-go` key in `$XDG_DATA_HOME/opencode/auth.json` (or `~/.local/share/opencode/auth.json`)
4. A connected Console integration, if available

If you have already run `/connect` in the TUI and added the OpenCode pay-as-you-go provider, the plugin can reuse that key on systems using the standard local auth file. The file format is an OpenCode implementation detail; if automatic discovery does not work, set `OPENCODE_API_KEY` for the server instead. Credentials are resolved when the plugin loads; restart/reload it after rotating a key.

**OpenAI Decisions** uses `options.openaiApiKey` or `OPENAI_API_KEY` in the OpenCode server process. An OpenCode Console key is **not** an OpenAI key. Set only the credential for the provider you use; an absent Jev credential does not prevent OpenAI calls. No credential is bundled or written into this repository. The input and questions go to the selected provider; review the [Console privacy terms](https://opencode.ai/v2/docs/console/models/#privacy) and [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) before sending sensitive material.

## Usage: Decisions tool

`decisions_evaluate` accepts `provider` (`jev` by default), `input`, `questions`, and optional `model`. It returns the selected provider's answers without changing the answer shape: Jev uses a question-ID map; OpenAI uses an array of named questions. Use one provider's native question format per call.

### Jev text (default)

```jsonc
{
  "input": "I was charged twice for my order.",
  "questions": {
    "billing": { "type": "noul", "instructions": "Does this request concern a billing error?" }
  }
}
```

Jev supports `noul`, `choice` (with a criteria map), and `score` (with a rubric array). Models: `jev-1.13` (default) or `jev-1.13-free`.

### OpenAI text or image

```jsonc
{
  "provider": "openai",
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "Inspect the product in this photo." },
      { "type": "input_image", "image_url": "data:image/png;base64,<BASE64_IMAGE_BYTES>" }
    ]
  }],
  "questions": [
    { "type": "predicate", "name": "visible_damage", "instructions": "Is the product visibly damaged?" },
    { "type": "choice", "name": "category", "instructions": "What kind of product is this?", "choices": [
      { "value": "electronics", "description": "An electronic device." },
      { "value": "other", "description": "Anything else." }
    ] },
    { "type": "score", "name": "severity", "instructions": "How severe is the damage?", "levels": [
      { "label": "None", "description": "No visible damage." },
      { "label": "Minor", "description": "Cosmetic damage only." },
      { "label": "Major", "description": "Product appears unusable." }
    ] }
  ]
}
```

Replace the placeholder with an actual inline base64 image data URL. The Decisions API does **not** accept hosted image URLs or file IDs. For text-only calls, `input` may simply be a string. OpenAI currently supports only `gpt-6-luna`; its `predicate` probability corresponds to Jev's `noul`, but the schemas and answer shapes differ. Image input with the default Jev provider is rejected; explicitly select OpenAI.

## Legacy Jev tool

`jev_jev_evaluate` keeps its original `state` and question-map format. It takes one `state` (the text to evaluate) and a map of questions. Ask
every question you need in a single call: Jev evaluates them in parallel and in
isolation, so adding questions barely changes latency and never causes
interference between questions.

For example, ask your OpenCode agent: “Use Jev to classify this support request
as returns, shipping, or billing, and tell me if it expresses urgency.” The
agent supplies the criteria and interprets the result. For direct tool calls,
the payload below shows the expected shape.

### Multiple choice

```jsonc
{
  "state": "Shoes arrived two weeks late and in the wrong size. Also I see two charges of $120 on my card.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "returns": "Exchanges, wrong or damaged items",
        "shipping": "Delivery status, delays, lost packages",
        "billing": "Charges, invoices, payment problems"
      }
    }
  }
}
```

The tool returns the model name, answers keyed by question ID, and usage. A `choice` answer includes the selected option, a full `probabilities` map, and `confidence` (illustrative response):

```json
{
  "model": "jev-1.13",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "returns",
      "confidence": 0.38,
      "probabilities": { "returns": 0.59, "shipping": 0.03, "billing": 0.38 }
    }
  },
  "usage": { "input_tokens": 425, "output_tokens": 98 }
}
```

The double charge may split the probability between two teams. Treat low confidence as a cue to inspect the case, not a guarantee that the answer is wrong.

### Boolean (noul) and rubric (score)

```jsonc
{
  "state": "Your order has shipped. Track: https://tracking.example.com/B-88213",
  "questions": {
    "is_legitimate": {
      "type": "noul",
      "instructions": "Is this message legitimate, with no intent to deceive?"
    },
    "urgency": {
      "type": "score",
      "instructions": "How time-sensitive is this?",
      "criteria": ["No deadline", "This week", "Today", "Minutes"]
    }
  }
}
```

`noul` returns a single 0–1 value. `score` returns a position, a `legend` mapping positions to labels, `probabilities`, and `confidence`.

Mixing question types in one call is encouraged. An independent `noul` can help
when a `choice` distribution is split, but neither result should be treated as
a definitive security or fraud verdict.

## Models and cost

| Provider/model | Cost (input) | Notes |
| --- | --- | --- |
| Jev `jev-1.13-free` | Free | Limited-time free tier |
| Jev `jev-1.13` | $0.042 / 1M tokens | Output is free |
| OpenAI `gpt-6-luna` | $0.10 / 1M tokens | Decisions API public beta; input-only pricing, with regional/long-context adjustments |

Pricing and availability may change. Check [Console pricing](https://opencode.ai/v2/docs/console/models/#pricing) and the [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability) before relying on these figures.

## Options

Configure via the object form in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:matthewpetela/opencode-decisions-plugin",
      "options": {
        "model": "jev-1.13-free",
        "timeoutMs": 60000
      }
    }
  ]
}
```

| Option | Default | Purpose |
| --- | --- | --- |
| `apiKey` | — | Override Jev credential resolution; avoid literals in shared config |
| `openaiApiKey` | `OPENAI_API_KEY` | OpenAI credential; avoid literals in shared config |
| `endpoint` | `https://opencode.ai/zen/v1/systemone` | Jev endpoint |
| `openaiEndpoint` | `https://api.openai.com/v1/decisions` | OpenAI Decisions endpoint |
| `model` | `jev-1.13` | Default Jev model when a call omits `model` |
| `timeoutMs` | `60000` | Request timeout |

A `model` argument on an individual Jev call overrides the configured default.
The default Jev model is the paid tier. Set `model` to `jev-1.13-free` to use the
currently available free tier. OpenAI calls use `gpt-6-luna`. Only change an
endpoint to a service you trust: the plugin sends its provider's bearer key
and the input being evaluated to that URL.

## Multi-label behavior

Read this before relying on `probabilities` for multi-label work. In small informal tests across technical docs and email triage:

- A document that was both a diagnosis and a port analysis split `0.66 / 0.34`.
- An email that was both phishing *and* heavy on urgency/authority produced a
  dominant phishing choice. A threshold over one choice distribution missed the
  other dimension.

For orthogonal dimensions, ask separate atomic questions rather than expecting
one `choice` question to discover co-membership. Choice probabilities compete
within that question; they are not independent probabilities of each label.

## Development

This is a dependency-free JavaScript plugin for OpenCode V2. Its entry point is
`index.js`, as declared in `package.json`. Run `node --test` for mocked request tests. See the [V2 plugin API](https://opencode.ai/v2/docs/build/plugins/) for the tool registration contract. OpenCode reloads watched local plugins automatically; restart the service if changes do not appear.

## License

MIT
