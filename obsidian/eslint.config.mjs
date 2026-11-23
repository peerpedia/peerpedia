import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": ["error", {
        allowExpressions: false,
        allowHigherOrderFunctions: false,
        allowTypedFunctionExpressions: false,
        allowDirectConstAssertionInArrowFunctions: false,
      }],
      "@typescript-eslint/typedef": ["error", {
        arrowParameter: true,
        parameter: true,
      }],
    },
  },
];
