import { nativeFiles } from "./scripts/native-files.js";
import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  // Inline the diagram hook so its errors use the same BananaMark class as the handler.
  test: { server: { deps: { inline: [/bananamark-tikz/] } } },
  define: {
    __PEERPEDIA_ANCHORED__: JSON.stringify(
      process.platform === "darwin" ? nativeFiles() : "",
    ),
  },
  resolve: {
    alias: [
      { find: /^bananamark$/, replacement: require.resolve("bananamark") },
      {
        find: /^bananamark\/messages$/,
        replacement: require.resolve("bananamark/messages"),
      },
    ],
  },
});
