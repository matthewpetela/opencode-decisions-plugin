# opencode-jev-plugin

Use [Jev](https://docs.typesafe.ai/) — a System One decision model — from an OpenCode V2 agent via one tool.

Jev does not generate text. It evaluates a piece of text against **typed questions** and returns structured answers with probabilities and confidence. The plugin forwards questions to the [OpenCode Console Jev endpoint](https://opencode.ai/v2/docs/console/models/#jev) and returns the result; the calling agent chooses the questions and interprets the answers.

## Why a tool?

Jev returns decisions rather than assistant messages or tool calls, so it cannot serve as an OpenCode agent's conversational model. The agent uses this tool to ask Jev questions while keeping responsibility for the taxonomy and final labels.

No separate Jev subagent or skill is required.

## Requirements

- OpenCode **v2.0.0+** (developed against 2.0.18)
- An [OpenCode Console API key](https://opencode.ai/console) — see [Credentials](#credentials). Free and paid Jev models are currently listed in the [Console model catalog](https://opencode.ai/v2/docs/console/models/#jev).

## Install

**Recommended:** install directly from GitHub with OpenCode's plugin manager:

```sh
opencode plugin add github:matthewpetela/opencode-jev-plugin
opencode plugin list
```

This works while the repo is **private** if your Git credentials can access it; other people will need access until you make it public. Never embed an access token in the URL. The tool is registered under the `jev` namespace as `jev_evaluate` (effective tool ID `jev_jev_evaluate`). OpenCode manages the global plugin entry and Git-backed updates; no npm publication is necessary.

For a project-specific install, put a Git package spec in the project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:matthewpetela/opencode-jev-plugin"]
}
```

Or clone for local development into a documented auto-discovery location:

```sh
git clone https://github.com/matthewpetela/opencode-jev-plugin.git \
  ~/.config/opencode/plugins/jev
```

The Git clone also needs GitHub access while the repo is private. Do **not** both clone into an auto-discovered plugin directory and add the Git package entry; choose one installation method. If a new tool does not appear, run `opencode plugin check` or `opencode service restart`.

`"plugins": ["opencode-jev-plugin"]` is an **npm package name**, not a GitHub repository reference; don't use it unless this package is actually published to npm.

## Credentials

Resolved in this order, first hit wins:

1. `options.apiKey` (supported, but **do not** put a literal key in a checked-in config)
2. `OPENCODE_API_KEY` (or `OPENCODE_CONSOLE_API_KEY`) in the OpenCode **server process** environment
3. A locally stored `opencode` or `opencode-go` key in `$XDG_DATA_HOME/opencode/auth.json` (or `~/.local/share/opencode/auth.json`)
4. A connected Console integration, if available

If you have already run `/connect` in the TUI and added the OpenCode pay-as-you-go provider, the plugin can reuse that key on systems using the standard local auth file. The file format is an OpenCode implementation detail; if automatic discovery does not work, set `OPENCODE_API_KEY` for the server instead. Credentials are resolved when the plugin loads; restart/reload it after rotating a key.

No credential is bundled or written into this repository. The `state` and questions are sent to OpenCode Console; review its [privacy terms](https://opencode.ai/v2/docs/console/models/#privacy) before submitting sensitive material.

## Usage

The tool takes one `state` (the text to evaluate) and a map of questions. Ask
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

| Model | Cost (input) | Notes |
| --- | --- | --- |
| `jev-1.13-free` | Free | Limited-time free tier |
| `jev-1.13` | $0.042 / 1M tokens | Output is free |

Pricing and free-tier availability may change. Check the [current Console pricing](https://opencode.ai/v2/docs/console/models/#pricing) before relying on these figures.

## Options

Configure via the object form in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:matthewpetela/opencode-jev-plugin",
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
| `apiKey` | — | Override credential resolution; avoid literals in shared config |
| `endpoint` | `https://opencode.ai/zen/v1/systemone` | Point at a proxy or a self-hosted gateway |
| `model` | `jev-1.13` | Default model when a call omits `model` |
| `timeoutMs` | `60000` | Request timeout |

A `model` argument on an individual call overrides the configured default.
The default model is the paid tier. Set `model` to `jev-1.13-free` to use the
currently available free tier. Only change `endpoint` to a service you trust:
the plugin sends both your bearer key and the text being evaluated to that URL.

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
`index.js`, as declared in `package.json`. See the [V2 plugin API](https://opencode.ai/v2/docs/build/plugins/) for the tool registration contract. OpenCode reloads watched local plugins automatically; restart the service if changes do not appear.

## License

MIT
