/** Reads a Retry-After header, given as seconds or as an HTTP date, in seconds from now. Null when absent or
    unreadable. No imports: the unit tests run this file directly with Node. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, (at - nowMs) / 1000);
}
