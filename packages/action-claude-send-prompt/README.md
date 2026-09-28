# Claude send-prompt action

Starts a turn on the Claude Code session made by `{ "session": { "action": "start" } }`.
Exactly one of `prompt` and `promptFile` is required; the resolved text is
always rendered with Handlebars against `{ item, actions, repository }`.

This is a `VersionedActionPlugin` (`apiVersion: 1`): `execute` starts the turn
and returns `running` with an `{ workerId, turnId }` operation, `reconcile`
polls the turn until it succeeds or fails, and `cancel` stops the worker and
reports the turn as cancelled.
