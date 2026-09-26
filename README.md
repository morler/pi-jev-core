# pi-jev-core

English | [简体中文](./README.zh-CN.md)

A minimal, standalone Pi extension: it connects to a Jev API and registers a `jev_evaluate` tool supporting three structured judgment types — `noul`, `choice`, and `score`. It contains no tool routing, auto mode, skill discovery, or context compaction.

## Install

Install from a local checkout, or straight from GitHub:

```bash
pi install /path/to/pi-jev-core                # local checkout
pi install git:github.com/morler/pi-jev-core   # from GitHub
```

Once published to npm:

```bash
pi install npm:pi-jev-core
```

This package ships pure TypeScript source, loaded by pi's extension loader (jiti). For programmatic use (via a loader such as tsx/jiti), import the entry point directly: `import { JevClient } from "pi-jev-core"`. Deep imports (e.g. `pi-jev-core/src/jev.ts`) remain available when you only need one layer.

## Platforms

TypeSafe is the default. Set `JEV_PLATFORM` and provide the matching credential; credentials may also live in the secret files listed below under `~/.pi/agent/secrets/`.

| `JEV_PLATFORM` | Credential env var | Pi secret file | Default model |
|---|---|---|---|
| `typesafe` (default) | `TYPESAFE_API_KEY` | `typesafe_api_key` | `jev-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter_api_key` | `typesafe/jev-1.13` |
| `cloudflare` | `CLOUDFLARE_API_TOKEN` | `cloudflare_api_token` | `typesafe/jev` |
| `vercel` | `AI_GATEWAY_API_KEY` | `ai_gateway_api_key` | `typesafe-ai/jev` |

Cloudflare additionally requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID`. Use `JEV_MODEL` to override the model; the TypeSafe platform also honors `TYPESAFE_DEFAULT_MODEL`. Never commit API keys or send them to the model.

Switch the active platform at runtime with the `/jev-platform` command: with no argument it lists every platform with its credential origin and marks the active one; `/jev-platform <name>` switches and persists the choice to `~/.pi/agent/pi-jev-core.json` (path overridable via `JEV_CONFIG_FILE`). Resolution order: `JEV_PLATFORM` env, then the persisted choice, then `typesafe`.

## Local JevK5 platform (llama-server)

`JEV_PLATFORM=jevk5` routes evaluations to a local llama-server serving a JevK5 GGUF — no API key, no egress.

| Env | Default | Meaning |
|---|---|---|
| `JEV_PLATFORM` | `typesafe` | Set to `jevk5` for the local model. |
| `JEVK5_BASE_URL` | `http://127.0.0.1:8008` | llama-server base URL. |
| `JEVK5_TEMP` | `1.532` | Calibration temperature (1.532 = 4B, 1.42 = 2B). |
| `JEV_MODEL` | `jevk5-4b-v0.2` | Model label reported with the answers. |

Each question runs one forward pass: the prompt is tokenized server-side, the answer letters' logprobs come back from `n_probs`, and they are softmaxed at `JEVK5_TEMP` — the JevK5 reference recipe. Start the server with the model repo's `start_JevK5_4B.sh`.

## Local Decider platform (llama-server)

`JEV_PLATFORM=decider` routes evaluations to a local llama-server serving a decider GGUF (decider-4b v2.1). It renders decider-ai's plain layout and calibrates with the per-type temperatures from `decider_config.json` (choice 1.110, noul 1.560, score 1.287); `DECIDER_TEMPERATURE` overrides the map with one temperature. Score questions follow decider's isolated levels: one yes/no row per level, normalized into the level distribution whose expectation is the score.

| Environment variable | Default | Meaning |
|---|---|---|
| `JEV_PLATFORM` | `typesafe` | Set to `decider` for the local model. |
| `DECIDER_BASE_URL` | `http://127.0.0.1:8008` | llama-server base URL. |
| `DECIDER_TEMPERATURE` | per-type map | One temperature for every type, switching the map off. |
| `JEV_MODEL` | `decider-4b-v2.1` | Model label reported with the answers. |

Each scoring row is one forward pass: the row is tokenized server-side, the answer letters' logprobs come back from `n_probs`, and they are softmaxed at the row type's temperature — the decider-ai reference recipe. Serve the repo's `decider-4b-q6_k.gguf` with llama-server.

## The `jev_evaluate` tool

The tool sends a `state` plus multiple named questions to the active Jev platform and returns answers, the model, usage, elapsed time, and each provider's raw answer. Question types:

- `noul`: a yes/no judgment; returns the probability of yes.
- `choice`: picks from candidates in the `criteria` object; keys are option IDs, values are descriptions.
- `score`: rates along the `criteria` array, listed from lowest to highest level; at least two levels (the array index is the score, starting at 0 — the response's `legend` field mirrors this mapping).

Example request:

```json
{
  "state": {
    "change": "Added a required field to the public request type"
  },
  "questions": {
    "breaking": {
      "type": "noul",
      "instructions": "Does this change break an existing caller?"
    },
    "kind": {
      "type": "choice",
      "instructions": "What best describes the change?",
      "criteria": {
        "api": "Public API change",
        "bug": "Bug fix",
        "other": "Other"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "Rate the impact of this change",
      "criteria": ["Critical", "High", "Medium", "Low"]
    }
  }
}
```

`state` may be a string or a JSON object; one request can carry multiple independent questions. `noul` needs no `criteria`. Whatever you pass as `state` is transmitted to the configured platform — submit only what the judgment needs.

## Skill: building-with-jev

The repo ships the `building-with-jev` agent skill at [`skills/building-with-jev/SKILL.md`](./skills/building-with-jev/SKILL.md), adapted from [`dbreunig/building-with-jev-skill`](https://github.com/dbreunig/building-with-jev-skill) (which targets the Python `typesafe_sdk`) to this package's API. It covers question design for `noul`/`choice`/`score`, minimal-state construction, confidence-gated composition patterns, and a symptom → cause → fix table for wrong or low-confidence answers.

Adaptations from upstream:

- All examples use `JevClient.evaluate` / `jev_evaluate`; answers are read uniformly via `.value` (the choice label, or the score/noul number), with `.distribution` for the full probability spread.
- `instructions` accepts a string only — the upstream object/array form (`question`/`focus`/`inspect` keys) is inlined as sentences; extending `src/types.ts` and `src/jev.ts` is the documented upgrade path.
- Noul `true`/`false` criteria are not passed through (`noul(instructions)` takes the question only); when the boundary is subtle, state both sides inside the instruction.
- Optional-field guard pattern: `value`/`confidence` can be `undefined` when the provider gave no answer — route missing answers to a fallback instead of coercing them to `0`, and use the exported `noulProbability(raw)` to tell "no answer" apart from "answered 0".

All three adaptations were verified against live responses (model `jev-1.13.0`): choice/score carry `confidence` while noul does not, and a score's value is the probability-weighted mean of the level indexes.

Install the skill for your agent:

```bash
cp -r skills/building-with-jev ~/.pi/agent/skills/
```

## Development checks

```bash
npm install
npm test
npm run typecheck
```

The API client and platform adapters are extracted and trimmed from the MIT-licensed [`pi-jev`](https://github.com/TheoOliveira/pi-jev); see `LICENSE` for the original notice.
