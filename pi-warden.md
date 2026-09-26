# No hardcoded secrets
Source code must not contain passwords, API keys, tokens, or connection URLs with credentials. Read them from the environment, a function parameter, or the config module.

# Comments explain why, not what
A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment that restates what the next line plainly does is a violation.

# Errors are not swallowed
A `catch` block must handle the error, report it, or re-raise it. An empty catch block, or one whose body is only a comment, is a violation.

# No partial implementations
Implement features fully. A comment that says "for now", "simplified", or "later", or a stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead of stubbing it.

# Do not run destructive commands that erase uncommitted work
`git reset --hard`, `git checkout -- .`, `git clean -fd`, and similar commands that discard untracked or uncommitted changes are forbidden. These destroy work that has no backup. If a clean tree is needed, create a worktree instead or ask the user.

# pi-jev-core
Project type: TypeScript. Package name: `pi-jev-core`. This is a minimal, standalone Pi extension that connects to a Jev API and registers a `jev_evaluate` tool supporting `noul`, `choice`, and `score`. It contains no tool routing, auto mode, skill discovery, or context compaction.

# Install and package boundaries
The package ships pure TypeScript source loaded by Pi's extension loader. Keep the public package and exports aligned with `package.json`; preserve the programmatic entry point and supported deep imports. Do not add tool routing, auto mode, skill discovery, or context compaction.

# Platform credentials and configuration
TypeSafe is the default platform. Platform credentials come from the documented environment variables or Pi secret files under `~/.pi/agent/secrets/`; never commit or send API keys to the model. Preserve support for `JEV_PLATFORM`, `JEV_MODEL`, platform-specific credentials, Cloudflare account and gateway configuration, and the persisted platform selection in `~/.pi/agent/pi-jev-core.json` (path overridable via `JEV_CONFIG_FILE`). Environment configuration takes precedence over persisted configuration.

# Local JevK5 platform
When `JEV_PLATFORM=jevk5`, route to the local llama-server using `JEVK5_BASE_URL`, `JEVK5_TEMP`, and `JEV_MODEL`. Preserve the reference recipe: tokenize server-side, read answer-letter logprobs from `n_probs`, and softmax them at the calibration temperature. This mode must not require an API key or egress.

# Local Decider platform
When `JEV_PLATFORM=decider`, use the local decider llama-server and its documented base URL, model label, and per-type temperatures. Preserve `DECIDER_TEMPERATURE` as the global override and the isolated score-level rows, normalization, and expected score behavior.

# jev_evaluate contract
The tool sends a `state` plus multiple named questions to the active platform and returns answers, model, usage, elapsed time, and provider raw answers. Preserve `noul` as probability of yes, `choice` as a criteria-map selection, and `score` as a value over an array of at least two levels. Transmit only the state required for the judgment.

# Public question types
Keep `state` as a string or JSON object, `noul` without criteria, `choice` with option IDs mapped to descriptions, and `score` with levels ordered from lowest to highest. Validate malformed criteria locally before making a remote request.

# Optional answer fields
Treat `value` and `confidence` as optional. Missing answers must use an explicit fallback path and must not be coerced into a meaningful value such as zero. Use `noulProbability(raw)` when code must distinguish no answer from an answer of zero.

# Logging privacy and behavior
The `/jev log on|off` switch controls best-effort JSONL logging of Jev questions and answers. Keep log and state paths configurable through their environment variables, use the documented per-user defaults, and never log credentials. Logging failures must not break evaluation or command handling.

# building-with-jev skill
Preserve `skills/building-with-jev/SKILL.md` and its documented adaptations: use `JevClient.evaluate` or `jev_evaluate`, read answers through `.value` and `.distribution`, pass string instructions, do not pass Noul criteria through, and guard optional fields. Keep the skill installation instructions and upstream attribution accurate.

# Development checks
The supported checks are `npm install`, `npm test`, and `npm run typecheck`. Changes to behavior must leave a runnable test or equivalent direct check. Do not claim completion when targeted checks fail; report the failing check and cause.

# TypeScript rules
Do not use explicit `any` in `**/*.ts` or `**/*.tsx`. Exported functions in `src/**/*.ts` must declare return types. Keep the implementation compatible with the package's declared TypeScript, Node, and dependency versions.

# No stubs or placeholders
Do not add TODOs, placeholders, empty implementations, fake success responses, or deferred feature branches. Every registered command, tool, platform adapter, and exported API must perform its documented behavior.
