#!/usr/bin/env node
// Development-only CLI entry point: runs the current checkout's TypeScript source.
import "tsx/esm";
await import("../src/cli/main.ts");
