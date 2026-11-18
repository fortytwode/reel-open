import assert from "node:assert/strict";
import { test } from "node:test";
import { selectOwnedSource } from "./source-selection.mjs";

test("selects the exact HWND even when another source has the same title", () => {
  const sources = [
    { id: "window:100:0", name: "Reel fixture" },
    { id: "screen:1:0", name: "Entire Screen" },
    { id: "window:200:1", name: "Reel fixture" },
  ];
  assert.equal(selectOwnedSource(sources, 200n), sources[2]);
});

test("an unknown HWND is rejected instead of falling back to another window", () => {
  assert.throws(() => selectOwnedSource([{ id: "window:200:1", name: "Reel fixture" }], 201n), /found 0/);
});

test("ambiguous or malformed source IDs are rejected", () => {
  assert.throws(() => selectOwnedSource([{ id: "window:200:1" }, { id: "window:200:0" }], 200n), /found 2/);
  assert.throws(() => selectOwnedSource([{ id: "screen:200:0" }], 200n), /found 0/);
});
