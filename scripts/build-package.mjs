import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputName = "game-library-plugin-steam-import-node.zip";
const outputPath = path.join(pluginRoot, outputName);
const packageEntries = [
  "manifest.json",
  "logo.svg",
  "package.json",
  "README.md",
  "runtime/provider.mjs",
  "src",
];

for (const entry of packageEntries) {
  if (!existsSync(path.join(pluginRoot, entry))) {
    throw new Error(`package entry is missing: ${entry}`);
  }
}

if (existsSync(outputPath)) {
  rmSync(outputPath, { force: true });
}

const result = spawnSync("tar", ["-a", "-cf", outputName, ...packageEntries], {
  cwd: pluginRoot,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Wrote ${outputName}`);
