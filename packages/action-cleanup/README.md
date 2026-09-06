# Cleanup action

Stops a selected worker and cleans its Relay-owned workspace. Input accepts
`{ "activeWorker": "stop|skip", "ownedTmuxOnly": true }`; output is the
host worker cleanup result or a terminal `skipped` outcome.
