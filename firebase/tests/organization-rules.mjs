import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function renderedRules(name, overrides = {}) {
  const out = mkdtempSync(join(tmpdir(), "reel-rules-"));
  try {
    const config = JSON.parse(readFileSync(new URL("../../organization.example.json", import.meta.url)));
    const source = join(out, "organization.json");
    writeFileSync(source, JSON.stringify({ ...config, ...overrides }));
    execFileSync("python3", ["scripts/configure-organization.py", source, "--output-dir", out],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
    return readFileSync(join(out, ".reel/firebase", name), "utf8");
  } finally { rmSync(out, { recursive: true, force: true }); }
}
