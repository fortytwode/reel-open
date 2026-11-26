export const MIN_RECORDED_TONE_DB = -48;

export function recordedToneWindowIsPresent(signalDb, referenceDb) {
  return Number.isFinite(signalDb) && Number.isFinite(referenceDb) &&
    signalDb >= MIN_RECORDED_TONE_DB && signalDb >= referenceDb - 8;
}
