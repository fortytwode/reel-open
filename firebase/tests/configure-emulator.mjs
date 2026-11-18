import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const fixture = ".reel/test-fixture";
const python = process.platform === "win32" ? "python" : "python3";
execFileSync(python, ["scripts/configure-organization.py", "organization.example.json", "--output-dir", fixture], {
  cwd: fileURLToPath(root), stdio: "inherit",
});

// Use the rendered rules for every local bucket without requiring deployment targets.
const configPath = new URL(`${fixture}/firebase.local.json`, root);
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.storage = { rules: config.storage[0].rules };
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
