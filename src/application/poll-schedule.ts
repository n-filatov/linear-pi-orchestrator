/** Per-binding deadlines coalesce missed polls after sleep into one fresh poll. */
export class PollSchedule {
  private readonly deadlines = new Map<string, number>();

  due(binding: string, now: number, intervalMs?: number): boolean {
    if (intervalMs === undefined) return true;
    if (now < (this.deadlines.get(binding) ?? 0)) return false;
    this.deadlines.set(binding, now + Math.max(1, intervalMs));
    return true;
  }
}
