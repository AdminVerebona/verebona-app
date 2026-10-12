/**
 * Matrice de traçabilité de la recette Opérations V1 (lot 48, O10).
 *
 *   npm run recette:matrice            → régénère docs/recette/operations-v1-matrice.md
 *   npm run recette:matrice -- --check → contrôle seulement (code 1 si la matrice est incomplète ou le rendu périmé)
 *
 * Source : docs/recette/operations-v1-matrice.json. Même contrôle que le test
 * `src/test/recette/__tests__/o10-matrice.test.ts` (ACC-021).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  MATRIX_JSON_PATH, MATRIX_MD_PATH, checkMatrix, renderMatrixMarkdown, summarizeMatrix, type MatrixDocument,
} from '@/test/recette/operations-v1-matrix';

const ROOT = process.cwd();
const doc = JSON.parse(readFileSync(join(ROOT, MATRIX_JSON_PATH), 'utf8')) as MatrixDocument;
const problemes = checkMatrix(doc, { exists: (p) => existsSync(join(ROOT, p)), read: (p) => readFileSync(join(ROOT, p), 'utf8') });
const md = renderMatrixMarkdown(doc);
const s = summarizeMatrix(doc);
console.log(`[recette] ${s.total} entrées : ${JSON.stringify(s.byStatus)}`);
for (const p of problemes) console.error(`[recette] ${p}`);
if (process.argv.includes('--check')) {
  const actuel = existsSync(join(ROOT, MATRIX_MD_PATH)) ? readFileSync(join(ROOT, MATRIX_MD_PATH), 'utf8') : '';
  if (actuel !== md) console.error(`[recette] ${MATRIX_MD_PATH} périmé : lancer « npm run recette:matrice ».`);
  process.exit(problemes.length || actuel !== md ? 1 : 0);
}
writeFileSync(join(ROOT, MATRIX_MD_PATH), md);
console.log(`[recette] ${MATRIX_MD_PATH} régénéré.`);
process.exit(problemes.length ? 1 : 0);
