/**
 * Contrôle des fichiers de prompts — CDC 15 §22.3, §29, ARCH-02, ARCH-03.
 *
 * Chaque opération du référentiel déclarant un `promptCode` ou un
 * `masterPromptCode` a son fichier ; chaque master contient `{{TASK}}` et une
 * section `BRANCHE TASK = X` par TASK déclarée. Logique :
 * `src/services/ai/prompts/prompt-files-check.ts`.
 *
 * Utilisation : npx tsx scripts/check-prompt-files.ts [--root=<dossier>]
 * Sortie 0 : conforme (avertissements affichés). Sortie 1 : erreur.
 */
import { join, resolve } from 'path';
import { AI_OPERATIONS } from '@/services/ai/registry/operations';
import { checkPromptFiles } from '@/services/ai/prompts/prompt-files-check';

const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length);
const root = rootArg ? resolve(rootArg) : join(process.cwd(), 'src/services/ai/prompts');

const report = checkPromptFiles({ operations: Object.values(AI_OPERATIONS), root });

for (const i of report.infos) console.log(`ℹ ${i}`);
for (const w of report.warnings) console.warn(`⚠ ${w}`);
for (const e of report.errors) console.error(`✗ ${e}`);
console.log(
  `[prompts:check] ${report.checkedFiles} fichier(s) contrôlé(s) — `
  + `${report.errors.length} erreur(s), ${report.warnings.length} avertissement(s).`,
);
process.exit(report.errors.length > 0 ? 1 : 0);
