// Check our JavaScript, not the bundled third-party runtimes. No npm install needed.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(join(root, "app/js")).filter((f) => f.endsWith(".js")).map((f) => `app/js/${f}`);
files.push("app/sw.js", "app/kokoro/neural-tts.js");
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error));
    process.exit(1);
  }
}
console.log(`${files.length} JavaScript files: syntax OK`);
