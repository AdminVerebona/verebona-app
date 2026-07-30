/**
 * Vérification à blanc du harnais — aucun appel modèle.
 *
 *   npm run corpus:dry
 *
 * Le runner rend exactement le résultat attendu : la campagne passe donc à
 * 100 %. Ce n'est pas une mesure du moteur, c'est une vérification de la
 * CHAÎNE — lecture des fixtures, comparaison, rapport, verdict — avant de
 * dépenser le moindre appel.
 *
 * Un harnais qu'on découvre cassé au milieu d'une campagne payante est un
 * harnais inutile.
 */
import { runCorpus, formatReport } from '@/services/ai/governance/corpus/corpus-runner';
import { createDryRunner } from '@/services/ai/governance/corpus/analysis-runner';
import '@/services/ai/governance/corpus/corpus-cases';

runCorpus(createDryRunner(), { label: 'vérification à blanc' })
  .then((run) => {
    console.log(formatReport(run));
    const complet = run.summary.passed === run.summary.total && run.errors.length === 0;
    console.log(
      complet
        ? '[corpus] ✓ Chaîne opérationnelle : lecture, comparaison et rapport fonctionnent.\n'
        : '[corpus] ✗ La chaîne elle-même est défaillante — à corriger avant toute campagne.\n',
    );
    process.exit(complet ? 0 : 1);
  })
  .catch((e) => {
    console.error('[corpus] échec :', e.message);
    process.exit(1);
  });
