# Linear issue-change trigger

This package owns the Linear MCP source adapter and its provider-specific
selector vocabulary. Configure it through the compatibility source alias:

```yaml
sources:
  linear: { use: linear, with: { mcp: { transport: stdio, command: linear-mcp } } }
```
