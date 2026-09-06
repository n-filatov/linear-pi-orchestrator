# Framework compatibility proof

The standalone Nest application context works under Node 22 and Bun 1.3.14
when Relay dependencies are supplied through explicit factories. The proof
accepts an absolute plugin path at runtime, dynamically loads that external
module, writes and reopens a SQLite file, prints the result, and closes the
Nest context before closing the database.

Run the source proof with `node --import tsx scripts/smoke-compiled.ts` and
`bun run scripts/smoke-compiled.ts`. A compiled Bun executable can be produced
with `bun build --compile scripts/smoke-compiled.ts --outfile relay-smoke`.

Observed in the temporary Nest 11 fixture on 2026-09-05:

- Node + tsx: passed; startup wall time about 0.36 s.
- Bun source: passed; startup wall time about 0.19 s.
- A temporary dependency-complete compiled Bun prototype passed external
  loading and SQLite persistence in about 0.60 s; binary size 71,058,146 bytes
  (68 MiB). This is a prototype measurement, not the repository CLI binary.
- Compiling the repository proof with optional Nest packages marked external
  succeeds, but the resulting binary requires the runtime package graph (and
  `tslib`) beside it. Package bundling should therefore be decided with the
  final release packaging workflow.
