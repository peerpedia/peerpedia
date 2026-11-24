import { nativeFiles } from "./scripts/native-files.js";
import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  define: { __PEERPEDIA_ANCHORED__: JSON.stringify(process.platform === "darwin" ? nativeFiles() : "") },
  resolve: {
    alias: [{ find: /^bananamark$/, replacement: require.resolve("bananamark") }],
  },
});
