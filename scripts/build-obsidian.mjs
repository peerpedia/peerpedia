import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** @param {string[]} args @returns {void} */
function npm(args) {
  execFileSync("npm", args, { cwd: root, stdio: "inherit" });
}

for (const directory of ["packages/peerpedia-renderer", "packages/peerpedia-theme", "editor", "obsidian"]) {
  npm(["ci", "--ignore-scripts", "--prefix", directory]);
}
npm(["run", "prepare:browser", "--prefix", "packages/peerpedia-renderer"]);
const temporary = mkdtempSync(join(tmpdir(), "peerpedia-release-"));
try {
  const output = join(temporary, "peerpedia");
  npm(["run", "package", "--prefix", "obsidian", "--", output]);
  for (const name of ["main.js", "styles.css"]) copyFileSync(join(output, name), join(root, name));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
