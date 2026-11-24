import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("./obsidian/package.json", import.meta.url));
const obsidianmd = require("eslint-plugin-obsidianmd").default;

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "obsidian/prototype/**", "obsidian/bench/**", "**/scripts/**", "**/tests/**", "**/*.mjs", "**/docs/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["obsidian/src/**/*.ts", "obsidian/renderer/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: fileURLToPath(new URL("./obsidian", import.meta.url)) } },
    // The directory treats these code-quality findings as advisory. Keep them
    // visible; security rules retain the recommended error severity.
    // https://github.com/obsidianmd/eslint-plugin/blob/master/docs/configuration.md
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-this-alias": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "no-control-regex": "warn",
      "no-useless-escape": "warn",
    },
  },
];
