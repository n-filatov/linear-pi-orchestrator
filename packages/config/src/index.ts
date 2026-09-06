/** Shared, side-effect-free configuration normalization utilities. */
export function mergeConfigDocuments(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override === undefined ? base : override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = key in result ? mergeConfigDocuments(result[key], value) : value;
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
