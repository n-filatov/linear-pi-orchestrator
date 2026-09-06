# Command action

Runs a configured executable without a shell. The host supplies the legacy
`ActionContext`; all template variables are resolved against that context.

Input: `{ "command": "git", "args": ["status"] }`. Output: `{ "stdout":
"…", "exitCode": 0 }`. The invocation receives `context.signal` so host
cancellation reaches the child process.
