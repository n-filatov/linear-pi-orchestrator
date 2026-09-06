# Codex send-prompt action

Delivers a prompt to the Codex worker made by `{ "codex": { "action": "start" } }`.
Exactly one of `prompt` and `promptFile` is required. Output records targeted
worker, thread, turn, and delivery mode.
