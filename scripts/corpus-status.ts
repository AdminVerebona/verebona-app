/**
 * État du corpus de référence — CDC §11.1, critère d'acceptation n°22.
 *
 *   npm run corpus:status
 *
 * Répond à une seule question : le corpus permet-il d'affirmer qu'une
 * modification de prompt n'a rien dégradé ?
 *
 * Sort en code 1 si une famille est vide. Le critère 22 exige un corpus
 * COUVRANT, pas seulement l'existence d'un mécanisme de test — un corpus
 * incomplet donne l'illusion d'une non-régression vérifiée.
 */
import '@/lib/load-env';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  CORPUS_CATEGORIES,
  listCorpusCases,
  listEmptyCategories,
} from '@/services/ai/governance/corpus/corpus-registry';
import '@/services/ai/governance/corpus/corpus-cases';

const FIXTURES = 'src/services/ai/governance/corpus/fixtures';

function main() {
  const cases = listCorpusCases();
  const empty = listEmptyCategories();
  const missing = cases.filter((c) => !existsSync(join(process.cwd(), FIXTURES, c.fixturePath)));

  console.log(`\n[corpus] ${cases.length} cas répartis sur ${CORPUS_CATEGORIES.length} familles.\n`);

  for (const category of CORPUS_CATEGORIES) {
    const n = listCorpusCases(category).length;
    const mark = n === 0 ? '✗' : n < 2 ? '~' : '✓';
    console.log(`  ${mark} ${category.padEnd(32)} ${n} cas`);
  }

  if (missing.length > 0) {
    console.error(`\n[corpus] ✗ ${missing.length} fichier(s) introuvable(s) :`);
    for (const c of missing) console.error(`    ${c.caseId} → ${c.fixturePath}`);
  }

  console.log(
    '\n[corpus] ⚠️ Corpus SYNTHÉTIQUE. Il valide la logique — extraction,\n' +
    '         arbitrage entre sources, rattachement, refus d\'inventer — mais\n' +
    '         pas la robustesse à la numérisation. Trois à cinq documents réels\n' +
    '         anonymisés par famille restent nécessaires avant la validation\n' +
    '         finale du lot 7.',
  );

  if (empty.length > 0 || missing.length > 0) {
    console.error(`\n[corpus] ✗ Corpus non probant.`);
    process.exit(1);
  }
  console.log('\n[corpus] ✓ Toutes les familles sont couvertes.\n');
  process.exit(0);
}

main();
