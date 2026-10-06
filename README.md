# opencode-jev-plugin

Expose [Jev](https://docs.typesafe.ai/) — a System One decision model — as a single tool in OpenCode V2.

Jev does not generate text. It evaluates a piece of text against **typed questions** and returns typed values with calibrated probabilities and confidence. This plugin is a thin, deliberately dumb wrapper around that endpoint: it knows nothing about categories, and leaves all labeling and interpretation to the calling agent.

## Why a plugin and not an agent or skill

Jev is not a text-generating model. It emits typed values and probability distributions, never assistant messages or tool calls, so it cannot be used as an OpenCode agent's `model` — an agent loop needs a chat model. It is also absent from the OpenCode model registry (`/models` returns nothing for `jev`), and the Console catalog lists it with no AI SDK package because it is served from a dedicated `/v1/systemone` endpoint rather than a chat-completions route.

That leaves two options: a plugin that makes the HTTP call, or nothing. This is the plugin.

## Requirements

- OpenCode **v2.0.0+** (developed against 2.0.18)
- An OpenCode Console API key — see below. Free and paid models are both available.

## Install

Clone into your global plugins directory, which OpenCode discovers automatically:

```sh
git clone https://github.com/matthewpetela/opencode-jev-plugin.git \
  ~/.opencode/plugins/jev
```

Restart the OpenCode service (`opencode service restart`) and the tool appears as `jev_evaluate`.

For project-local or configured use, add it to `opencode.jsonc` instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-jev-plugin"]
}
```

## Credentials

Resolved in this order, first hit wins:

1. `options.apiKey` in `opencode.jsonc`
2. `OPENCODE_API_KEY` (or `OPENCODE_CONSOLE_API_KEY`) in the environment
3. The `opencode` or `opencode-go` key already stored in `~/.local/share/opencode/auth.json`
4. A connected Console integration

Option 3 means that if you have already run `/connect` in the TUI and added the
OpenCode pay-as-you-go provider, **there is nothing to configure** — the plugin
picks up the key you already have.

No credential is ever bundled, logged, or written into this repository.

## Usage

The tool takes one `state` (the text to evaluate) and a map of questions. Ask
every question you need in a single call: Jev evaluates them in parallel and in
isolation, so adding questions barely changes latency and never causes
interference between questions.

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

Returns `choice`, a full `probabilities` map, and `confidence`:

```json
{
  "department": {
    "type": "choice",
    "choice": "returns",
    "confidence": 0.38,
    "probabilities": { "returns": 0.59, "shipping": 0.03, "billing": 0.38 }
  }
}
```

Note `confidence` is 0.38, not 1.0 — the double charge genuinely splits
probability between two teams, and the confidence drop is the signal that this
needs a human.

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

Mixing question types in one call is encouraged. An independent `noul` often
disambiguates what a `choice` distribution leaves open — for example, a short
polite request to redirect a payment reads as `personal_correspondence` at 0.33,
while `is_legitimate` independently scores 0.18 and correctly identifies business
email compromise.

## Models and cost

| Model | Cost (input) | Notes |
| --- | --- | --- |
| `jev-1.13-free` | Free | Limited-time free tier |
| `jev-1.13` | $0.042 / 1M tokens | Output is free |

Jev does not use cached reads or writes. A typical single-message evaluation is
a few hundred input tokens, so cost is negligible either way.

## Options

Configure via the object form in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-jev-plugin",
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
| `apiKey` | — | Override credential resolution |
| `endpoint` | `https://opencode.ai/zen/v1/systemone` | Point at a proxy or a self-hosted gateway |
| `model` | `jev-1.13` | Default model when a call omits `model` |
| `timeoutMs` | `60000` | Request timeout |

A `model` argument on an individual call overrides the configured default.

## Multi-label behaviour

Read this before relying on `probabilities` for multi-label work. From testing
against two unrelated domains (technical docs and email triage):

- **Similar labels split honestly.** A document that is both a diagnosis and a
  port analysis came back `0.66 / 0.34` with confidence `0.59`.
- **A dominant label absorbs the mass.** An email that is both phishing *and*
  heavy on urgency/authority got `phishing_credential 1.0` and dropped the
  orthogonal dimension below `0.15`. The probabilities still sum to 1 and look
  well-formed, so a naive threshold can silently miss real co-membership.

For orthogonal dimensions, ask separate atomic questions rather than expecting
one `choice` question to discover co-membership. Treat probabilities as a
ranking, not a hard cut, and keep the full distribution.

## Notes for contributors

`@opencode-ai/plugin`'s published types lag the running V2 server. In 1.18.32 the
`PluginContext` exposes a `catalog` domain that no longer exists and offers no
tool API at all, while the 2.0.18 server actually provides `tool`, `session`,
`storage`, `model`, `provider`, `websearch`, `worktree`, and others. Writing
against those types produces a plugin that appears impossible to build. Verify
against the running server, not the installed package.

`Plugin.define()` is an identity function in that package, so a plain
`export default { id, setup(ctx) }` works and avoids the import entirely. OpenCode
also resolves `index.js` by directory convention, so `package.json` `main` is
optional — if you set it, make sure it points at a file that exists.

## License

MIT
