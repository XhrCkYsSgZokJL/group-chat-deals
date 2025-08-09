import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";


export default [
    pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['.build/']
  },
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];