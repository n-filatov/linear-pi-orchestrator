# Claude open-in-app action

Hands the Claude Code session made by `{ "session": { "action": "start" } }`
off to the Claude desktop app for human review, via `workers.handoff`. Output
is the handoff result: `target`, `handedOffAt`, `chainStatus`, and, when
available, `link`, `appSessionId`, and `lastResult`.
