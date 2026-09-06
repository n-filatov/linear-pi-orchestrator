# Launch action

Starts one worker through a configured host harness. Reading saved prompt files
is injected at creation time so this package does not own repository I/O.

Input requires `harness` and accepts one of `prompt` or `promptFile`; output is
the host worker-launch result with its worker identity.
