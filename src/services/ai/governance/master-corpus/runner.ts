/**
 * Exécution du corpus rejoué d'un prompt maître — CDC 15 §30, D-08, D-17.
 *
 * Pour CHAQUE cas du master, sur le TEXTE ÉVALUÉ (celui d'une version de
 * configuration, ou le fichier du dépôt) :
 *   1. rendu de la branche (`renderMasterPrompt`) — discriminant, section,
 *      emplacements : un master cassé échoue ici ;
 *   2. validation discriminée de la sortie enregistrée (branche + schéma du
 *      contrat), exactement comme la passerelle ;
 *   3. contrôle serveur de la branche (`evaluators.ts`) contre l'attendu.
 * Aucun appel modèle, aucune écriture métier : exécutable en CI, en
 * préproduction ou en production (seul le résultat est enregistré, par
 * `recordCorpusRun`).
 *
 * Règle de recette §30 : le master est VERT seulement si tous ses cas
 * passent ET si chacune de ses branches (opérations actives) a au moins un
 * cas qui passe. Une branche sans cas est rouge — jamais « non testée donc
 * acceptée ».
 */
import { renderMasterPrompt, masterTextFingerprint } from '../../prompts/prompt-loader';
import { validateOutput } from '../../gateway/output-validator';
import { masterOutputSchemaFor } from '../../gateway/master-output-schemas';
import { listMasterPrompts } from '../../registry/operations';
import { declaredMasterVariables } from '../../config/prompt-architecture';
import { treatmentForUseCase, type Treatment } from '../../config/treatments';
import { loadMasterCorpusCases, type MasterCorpusCase, type MasterFileReader } from './cases';
import { MASTER_CORPUS_EVALUATORS } from './evaluators';

export interface CorpusCaseOutcome {
  id: string;
  task: string;
  file: string;
  passed: boolean;
  /** `full` : contrôle serveur de la branche ; `schema` : rendu + schéma seulement. */
  level: 'full' | 'schema';
  errors: string[];
}

export interface MasterCorpusResult {
  treatment: Treatment;
  masterPromptCode: string;
  /** Empreinte SHA-256 du texte évalué (garde d'activation). */
  textSha256: string;
  textSource: 'file' | 'config';
  branchesRequired: string[];
  branchesPassed: string[];
  casesTotal: number;
  casesPassed: number;
  status: 'PASSED' | 'FAILED';
  cases: CorpusCaseOutcome[];
  /** Motifs d'échec lisibles (branche sans cas, cas en échec). */
  failures: string[];
  /** Passage réel : cas sans variables réelles possibles (non exécutés). */
  skipped?: string[];
}

export interface RunMasterCorpusOptions {
  /** Texte à évaluer par master (sinon fichier du dépôt). */
  texts?: Record<string, { text: string; source: 'file' | 'config' }>;
  /** Limiter aux masters de ces traitements. */
  treatments?: Treatment[];
  /** Lecture du fichier master (injectable) — aussi pour `@@MASTER_FILE@@`. */
  readMasterFile: MasterFileReader;
  cases?: MasterCorpusCase[];
  /**
   * Passage RÉEL (D-17) : la sortie de chaque cas vient du modèle, appelé
   * par la passerelle avec les variables du cas (`live.ts`). Un cas sans
   * variables réelles possibles (`variablesFor` rend null) est ignoré et
   * signalé ; une branche sans cas réel est rouge.
   */
  live?: {
    variablesFor(c: MasterCorpusCase): Record<string, unknown> | null;
    call(c: MasterCorpusCase, variables: Record<string, unknown>): Promise<unknown>;
  };
}

async function runCase(
  c: MasterCorpusCase, text: string, readMasterFile: MasterFileReader, tasks: string[],
  live?: RunMasterCorpusOptions['live'],
): Promise<CorpusCaseOutcome | null> {
  const base = { id: c.id, task: c.task, file: c.file, level: c.operationCode in MASTER_CORPUS_EVALUATORS ? 'full' as const : 'schema' as const };
  // 1. Rendu de la branche sur le texte évalué.
  try {
    // Tous les emplacements déclarés par le code (valeur nulle par défaut) ;
    // seules les variables du contexte qui en sont un sont reprises — les
    // autres (variables du chemin d'étapes) n'appartiennent pas au master.
    const declarees = declaredMasterVariables(c.masterPromptCode);
    const reelles = live ? live.variablesFor(c) : null;
    if (live && !reelles) return null;
    const fournies = (reelles ?? c.context.variables ?? {}) as Record<string, unknown>;
    const variables = Object.fromEntries(declarees.map((v) => [v, fournies[v] ?? null]));
    renderMasterPrompt(text, { masterPromptCode: c.masterPromptCode, task: c.task, allowedTasks: tasks, variables });
    if (live) {
      // 2 bis. Sortie RÉELLE : la passerelle valide schéma et branche.
      let sortie: unknown;
      try {
        sortie = await live.call(c, variables);
      } catch (e) {
        return { ...base, passed: false, errors: [`appel réel : ${(e as Error).message}`] };
      }
      return finish(c, sortie, base, text, readMasterFile);
    }
  } catch (e) {
    return { ...base, passed: false, errors: [`rendu : ${(e as Error).message}`] };
  }
  return finish(c, c.output, base, text, readMasterFile);
}

async function finish(
  c: MasterCorpusCase, output: unknown, base: Omit<CorpusCaseOutcome, 'passed' | 'errors'>, text: string, readMasterFile: MasterFileReader,
): Promise<CorpusCaseOutcome> {
  const errors: string[] = [];
  const evaluator = MASTER_CORPUS_EVALUATORS[c.operationCode] as (typeof MASTER_CORPUS_EVALUATORS)[string] | undefined;
  // 2. Validation discriminée (même contrôle que la passerelle).
  const schema = masterOutputSchemaFor(c.outputSchema);
  if (!schema) return { ...base, passed: false, errors: [`schéma ${c.outputSchema} inconnu`] };
  let data: unknown;
  try {
    // Lot 33D : même résolution déterministe que la passerelle (adaptateurs,
    // normalisation, validation champ par champ) — sans réparation IA.
    data = validateOutput(JSON.stringify(output), schema, c.operationCode, 'json', { expectedTask: c.task, taskField: c.taskField, schemaName: c.outputSchema });
  } catch (e) {
    return { ...base, passed: false, errors: [`sortie : ${(e as Error).message}`] };
  }
  // 3. Contrôle serveur de la branche.
  if (evaluator) {
    try {
      // Le texte ÉVALUÉ pour le master du cas (pas le fichier du dépôt).
      const masterText = (code: string) => (code === c.masterPromptCode ? text : readMasterFile(code));
      errors.push(...await evaluator(c, data, { masterText }));
    } catch (e) {
      errors.push(`contrôle : ${(e as Error).message}`);
    }
  }
  return { ...base, passed: errors.length === 0, errors };
}

/** Rejoue le corpus de chaque master déclaré (ou de ceux demandés). Pur hors lecture des fichiers. */
export async function runMasterCorpus(o: RunMasterCorpusOptions): Promise<MasterCorpusResult[]> {
  const cases = o.cases ?? loadMasterCorpusCases(o.readMasterFile);
  const out: MasterCorpusResult[] = [];
  for (const m of listMasterPrompts()) {
    const treatment = treatmentForUseCase(m.useCaseCode);
    if (o.treatments && !o.treatments.includes(treatment)) continue;
    const given = o.texts?.[m.masterPromptCode];
    const text = given?.text ?? o.readMasterFile(m.masterPromptCode);
    const mine = cases.filter((c) => c.masterPromptCode === m.masterPromptCode);
    const outcomes: CorpusCaseOutcome[] = [];
    const ignores: string[] = [];
    for (const c of mine) {
      const r = await runCase(c, text, o.readMasterFile, m.tasks, o.live);
      if (r) outcomes.push(r); else ignores.push(c.id);
    }
    const branchesPassed = m.tasks.filter((t) => outcomes.some((x) => x.task === t && x.passed));
    const failures = [
      ...m.tasks.filter((t) => !outcomes.some((x) => x.task === t))
        .map((t) => `branche ${t} : aucun cas ${o.live ? 'exécutable en réel' : 'au corpus'}`),
      ...outcomes.filter((x) => !x.passed).map((x) => `${x.id} (${x.task}) : ${x.errors.join(' ; ')}`),
    ];
    out.push({
      treatment, masterPromptCode: m.masterPromptCode,
      textSha256: masterTextFingerprint(text), textSource: given?.source ?? 'file',
      branchesRequired: [...m.tasks], branchesPassed,
      casesTotal: outcomes.length, casesPassed: outcomes.filter((x) => x.passed).length,
      status: failures.length === 0 ? 'PASSED' : 'FAILED',
      cases: outcomes, failures, skipped: ignores,
    });
  }
  return out;
}
