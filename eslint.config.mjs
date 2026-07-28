/**
 * Configuration ESLint — VERSION MODIFIÉE pour la refonte IA 11 → 5.
 *
 * Ajout par rapport à l'existant : la règle `no-restricted-imports` qui
 * matérialise le critère d'acceptation n°4 du CDC §12 :
 *   « le code ne contient plus d'instanciation directe d'un client LLM
 *     hors adaptateur central ».
 *
 * Cette règle est activée dès le LOT 1, avant toute migration, afin d'empêcher
 * l'ajout de nouveaux appels directs pendant les mois que dure le chantier.
 */
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

  // ─────────────────────────────────────────────────────────────────────────
  // CDC §5.2 / §12 critère 4 — accès aux modèles centralisé
  // ─────────────────────────────────────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/services/ai/gateway/providers/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@google/generative-ai",
              message:
                "Accès direct au SDK interdit (CDC §5.2). Utilisez AiGateway.execute(). " +
                "Seul src/services/ai/gateway/providers/ peut importer ce paquet.",
            },
          ],
          patterns: [
            {
              group: [
                "**/lib/gemini-search",
                "**/lib/intelligent-search",
                "**/document-ai/apply-ai-suggestions",
                "**/document-ai/enrich-and-coherence.service",
                "**/document-ai/gemini-client",
                "**/document-ai/upload-to-gemini",
                "**/agenda/AgendaClassificationService",
              ],
              message:
                "Moteur IA historique en cours de suppression (CDC §3.4). " +
                "Utilisez le module correspondant sous src/services/ai/.",
            },
          ],
        },
      ],
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
