/**
 * « Tester avec le corpus » depuis le BO — ticket BO-IA-PROMPTS-01 (AC12,
 * AC13). Contrôle qualité FACULTATIF : son résultat n'autorise ni n'empêche
 * aucune activation.
 *
 * Exécution : le corpus REJOUÉ des prompts maîtres (`master-corpus/runner`),
 * sur le texte EXACT de la version testée — rendu de chaque branche, sortie
 * enregistrée validée par le contrat, contrôles serveur de la branche.
 * Aucun appel modèle : coût nul, quelques centaines de millisecondes ; le
 * passage réel (`ai:corpus --live`, appels facturés) reste un outil de
 * diagnostic en ligne de commande, jamais déclenché depuis le BO.
 *
 * Résultat présenté par scénario : identifiant, description, branche,
 * résultat attendu, résultat obtenu.
 */
import type { Treatment } from '../config/treatments';
import { masterPromptForTreatment } from '../config/prompt-architecture';
import type { TestFailure } from './master-prompt.repository';

export interface CorpusTestOutcome {
  total: number;
  passed: number;
  failed: number;
  failures: TestFailure[];
  /** Branches et nombre de scénarios par branche (détails techniques). */
  details: { masterPromptCode: string; branches: Record<string, number>; schemaOnly: number };
}

const court = (s: string, max = 600) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Résultat attendu d'un scénario, lisible. */
export function describeExpected(expected: Record<string, unknown> | null): string {
  if (!expected || Object.keys(expected).length === 0) {
    return 'Branche préparée sans erreur et réponse conforme au format attendu.';
  }
  return court(Object.entries(expected).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(' ; '));
}

/** Rejoue le corpus d'un traitement sur un texte donné. */
export async function runCorpusOnText(treatment: Treatment, text: string): Promise<CorpusTestOutcome> {
  const master = masterPromptForTreatment(treatment);
  if (!master) throw new Error(`Aucun prompt maître pour ${treatment}.`);
  const [{ runMasterCorpus }, { readMasterFileFromRepo, loadMasterCorpusCases }] = await Promise.all([
    import('../governance/master-corpus/runner'), import('../governance/master-corpus/cases'),
  ]);
  const cases = loadMasterCorpusCases(readMasterFileFromRepo);
  const [r] = await runMasterCorpus({
    readMasterFile: readMasterFileFromRepo, cases, treatments: [treatment],
    texts: { [master.masterPromptCode]: { text, source: 'config' } },
  });
  if (!r) throw new Error(`Corpus introuvable pour ${master.masterPromptCode}.`);
  const parId = new Map(cases.filter((c) => c.masterPromptCode === master.masterPromptCode).map((c) => [c.id, c]));

  const failures: TestFailure[] = r.cases.filter((c) => !c.passed).map((c) => ({
    scenario: c.id,
    description: parId.get(c.id)?.description ?? '',
    branch: c.task,
    expected: describeExpected(parId.get(c.id)?.expected ?? null),
    obtained: court(c.errors.join(' ; ') || 'Écart non détaillé.'),
  }));
  // Une branche sans scénario n'est jamais « réussie par défaut ».
  const sansScenario = r.branchesRequired.filter((b) => !r.cases.some((c) => c.task === b));
  for (const b of sansScenario) {
    failures.push({
      scenario: `branche-${b}`, description: `Couverture de la branche ${b}`, branch: b,
      expected: 'Au moins un scénario pour cette branche.', obtained: 'Aucun scénario dans le corpus.',
    });
  }
  const branches: Record<string, number> = {};
  for (const c of r.cases) branches[c.task] = (branches[c.task] ?? 0) + 1;
  const total = r.casesTotal + sansScenario.length;
  return {
    total, passed: r.casesPassed, failed: total - r.casesPassed, failures,
    details: { masterPromptCode: master.masterPromptCode, branches, schemaOnly: r.cases.filter((c) => c.level === 'schema').length },
  };
}
