import test from "node:test";
import assert from "node:assert/strict";
import { activeClockTimeToOutputTime, MIN_RECORDED_TONE_DB, recordedToneWindowIsPresent } from "./recorder-smoke-audio-assertions.mjs";

test("recorded tone needs an absolute floor and must match same-capture references", () => {
  assert.equal(MIN_RECORDED_TONE_DB, -48);
  assert.equal(recordedToneWindowIsPresent(-37, -36), true, "observed Windows-level tone is accepted");
  assert.equal(recordedToneWindowIsPresent(-Infinity, -Infinity), false, "all-silent windows cannot pass");
  assert.equal(recordedToneWindowIsPresent(-60, -60), false, "equally quiet windows below the floor cannot pass");
  assert.equal(recordedToneWindowIsPresent(-49, -36), false, "weak signal below floor cannot pass");
  assert.equal(recordedToneWindowIsPresent(-37, -20), false, "signal must remain close to the recorded tone reference");
});

test("capture-clock audio boundaries map directly to active output time", () => {
  assert.equal(activeClockTimeToOutputTime(102.25, 100, 103), 2.25);
  assert.equal(activeClockTimeToOutputTime(103, 100, 103), null, "the pause boundary is excluded");
  assert.equal(activeClockTimeToOutputTime(99.99, 100, 103), null, "pre-begin samples are excluded");
  assert.equal(activeClockTimeToOutputTime(NaN, 100, 103), null);
});
