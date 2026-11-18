import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function renderedRules(name) {
  const out = mkdtempSync(join(tmpdir(), "reel-rules-"));
  try {
    execFileSync("python3", ["scripts/configure-organization.py", "organization.example.json", "--output-dir", out],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
    return readFileSync(join(out, ".reel/firebase", name), "utf8");
  } finally { rmSync(out, { recursive: true, force: true }); }
}
