# Worker send action

Sends rendered text into a selected live worker terminal.

Input is `{ "worker": { "action": "launch" }, "text": "…" }`; output is
the host delivery result. When `inputsResolved` is set, text is passed through
unchanged so centrally resolved expressions are never rendered a second time.
