/** Validate a local meeting trim range. Return millisecond precision to match the Mac UI. */
export function normalizeTrimRange(start, end, duration) {
  if (typeof start !== 'number' || typeof end !== 'number' || typeof duration !== 'number'
    || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration)
    || duration <= 0 || start < 0 || end > duration) return null;
  const s = Math.round(start * 1000) / 1000, e = Math.round(end * 1000) / 1000;
  if (e - s < 0.5 || (s < 0.05 && duration - e < 0.05)) return null;
  return { start: s, end: e };
}
