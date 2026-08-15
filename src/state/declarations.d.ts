declare module "proper-lockfile" {
  type LockOptions = { retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number }; stale?: number };
  const lockfile: { lock(path: string, options?: LockOptions): Promise<() => Promise<void>> };
  export default lockfile;
}

declare module "write-file-atomic" {
  interface WriteFileAtomic {
    (filename: string, data: string): Promise<void>;
    sync(filename: string, data: string): void;
  }
  const writeFileAtomic: WriteFileAtomic;
  export default writeFileAtomic;
}
