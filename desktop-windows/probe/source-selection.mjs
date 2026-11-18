/** Return a single capturer source for an HWND, never a title/first-source guess. */
export function selectOwnedSource(sources, hwnd) {
  if (typeof hwnd !== "bigint" || hwnd <= 0n) throw new Error("Invalid owned HWND");
  const matches = sources.filter((source) => {
    const match = /^window:(\d+):([01])$/.exec(source?.id || "");
    return match && BigInt(match[1]) === hwnd;
  });
  if (matches.length !== 1) throw new Error(`Expected one exact owned window source; found ${matches.length}`);
  return matches[0];
}
