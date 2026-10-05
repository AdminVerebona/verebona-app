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
                "Ancien SDK désinstallé (D-J5, lot 16b-3) et accès direct interdit (CDC §5.2). " +
                "Utilisez AiGateway.execute().",
            },
            {
              name: "@google/genai",
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
                // Lot 16b-3 : ancien moteur T1 supprimé (étapes, aiguillage, document-ai).
                "**/document-ai/analyze-document",
                "**/document-ai/unified-analysis-pipeline",
                "**/source-analysis/steps/group-sources.step",
                "**/source-analysis/steps/extract-source.step",
                "**/source-analysis/steps/classify-document.step",
                "**/source-analysis/steps/classify-rubric.step",
                "**/source-analysis/steps/identify-entities.step",
                "**/source-analysis/master/analysis-mode",
                "**/source-analysis/master/shadow",
                // Lot 16b-3b : T3 historique, D-H1, commutateurs et drapeaux supprimés.
                "**/document-ai/hourly-enrichment.service",
                "**/document-ai/asset-enrichment-trigger",
                "**/document-ai/ai-usage-tracker",
                "**/document-ai/commit-engine",
                "**/gateway/legacy-prompt",
                "**/reconciliation/shadow-report.service",
                "**/canonical/rollout",
                "**/exports/v12/data/source-diff",
                "**/ai/flags/ai-feature-flags",
                "**/ai/flags/use-case-flags",
                "**/ai/flags/flags-snapshot.service",
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

  // ─────────────────────────────────────────────────────────────────────────
  // CLIQUET DE DETTE — AJOUT DU LOT 0, VIDÉ AU LOT 16b-3
  //
  // Les moteurs historiques qui violaient la règle précédente étaient
  // exemptés ici, le temps du chantier. Lot 16b-3 : les derniers
  // (`ai-suggestions`, `apply-ai-suggestions`, `enrich-and-coherence`) sont
  // supprimés — la liste est vide et le bloc d'exemption disparaît : la règle
  // s'applique sans exception à tout `src/` hors adaptateur fournisseur.
  // ─────────────────────────────────────────────────────────────────────────

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
