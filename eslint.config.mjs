import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import unusedImports from "eslint-plugin-unused-imports";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals"),
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      // --- Objectif : code mort ---
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
      ],

      // --- Bruit préexistant : neutralisé pour ne pas bloquer le build ---
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "warn",
      "@next/next/no-img-element": "warn",
    },
  },
  {
    // Fichiers/dossiers a NE PAS linter
    ignores: [
      ".next/**",
      "node_modules/**",
      ".history/**",          // sauvegardes VS Code Local History
      "public/**",            // assets statiques + bundles vendor minifies (pdf.worker...)
      "src/db/migrations/**", // migrations generees par drizzle-kit
    ],
  },
];

export default eslintConfig;
