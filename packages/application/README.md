# Task Relay application

This package owns application orchestration use cases. Domain rules and plugin
implementations remain independent of the scheduler; the host binds concrete
discovery, workflow, and execution ports when it creates a Relay runtime.

`PollTriggers` is the first extracted use case. It performs one bounded poll,
reconciles durable work before new discovery, and isolates failures to a single
binding. The root `src/application` module re-exports it for compatibility.

`legacyPipelineToWorkflow` converts an ordered legacy `trigger.actions` value
to a linear `WorkflowDefinition`. The resulting jobs carry predecessor edges,
legacy continue-on-error traversal, trigger worker targets and a provenance
marker for preserving trigger-action idempotency while both configuration
forms use the same execution engine.
