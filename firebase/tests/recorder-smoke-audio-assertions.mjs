export const MIN_RECORDED_TONE_DB = -48;

export function activeClockTimeToOutputTime(clockTime, beginClockTime, endClockTime) {
  if (![clockTime, beginClockTime, endClockTime].every(Number.isFinite) ||
      clockTime < beginClockTime || clockTime >= endClockTime) return null;
  return clockTime - beginClockTime;
}

export function recordedToneWindowIsPresent(signalDb, referenceDb) {
  return Number.isFinite(signalDb) && Number.isFinite(referenceDb) &&
    signalDb >= MIN_RECORDED_TONE_DB && signalDb >= referenceDb - 8;
}
