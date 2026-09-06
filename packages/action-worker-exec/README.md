# Worker exec action

Opens a pane or window beside a selected worker. The host exposes worker effects through `ActionContext`.

Input includes `worker`, `command`, optional args/environment, and `open`.
The returned output is the created worker-child handle from the host.
