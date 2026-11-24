import { execFileSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const themePackage = fileURLToPath(
  import.meta.resolve("@peerpedia/theme/package.json"),
);
execFileSync("npm", ["run", "build"], {
  cwd: dirname(themePackage),
  stdio: "inherit",
});
const themeStylesheet = fileURLToPath(
  import.meta.resolve("@peerpedia/theme/style.css"),
);
// Keep the TikZ font URLs already stored in published reading copies.
const destination = new URL("../static/vendor/bananamark/", import.meta.url);
await cp(dirname(themeStylesheet), destination, { recursive: true });
