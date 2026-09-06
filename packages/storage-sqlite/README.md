# SQLite execution ledger

The package owns the per-checkout SQLite execution ledger: run and action
claims, workflow attempts and leases, trigger checkpoints, and projection
outbox records. Its JSON importer is an explicit, validated cutover step that
keeps an untouched backup; it is not a live production migration mechanism.

`RepositoryStateStore` remains available from `src/state/store.ts` as a
compatibility re-export while consumers move to this package.
