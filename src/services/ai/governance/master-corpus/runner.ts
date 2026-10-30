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
 * Lot 34D — prompt en CONTEXTE STRUCTURÉ (T4) : l'étape 1 ne rend plus
 * d'emplacements ; elle construit et VALIDE le contexte d'exécution du cas
 * (contrat d'entrée de la configuration, mêmes variables que les appelants
 * réels — `liveVariablesFor`), exactement comme la passerelle.
 * Aucun appel modèle, aucune écriture métier : exécutable en CI, en
 * préproduction ou en production (seul le résultat est enregistré, par
 * `recordCorpusRun`).
 *
 * Règle de recette §30 : le master est VERT seulement si tous ses cas
 * passent ET si chacune de ses branches (opérations actives) a au moins un
 * cas qui passe. Une branche sans cas est rouge — jamais « non testée donc
 * acceptée ».
 */
import { inspectMasterTemplate, isOptionalMasterTask, renderMasterPrompt, masterTextFingerprint } from '../../prompts/prompt-loader';
import { validateOutput } from '../../gateway/output-validator';
import { masterOutputSchemaFor } from '../../gateway/master-output-schemas';
import { listMasterPrompts } from '../../registry/operations';
import { declaredMasterVariables } from '../../config/prompt-architecture';
import { treatmentForUseCase, type Treatment } from '../../config/treatments';
import { loadMasterCorpusCases, type MasterCorpusCase, type MasterFileReader } from './cases';
import { MASTER_CORPUS_EVALUATORS } from './evaluators';
import {
  buildExecutionContext, checkExecutionConfig, executionConfigFor, structuredSpecFor, structuredTaskSupport, type MasterExecutionConfig,
} from '../../master-prompts/structured-context';
import { contractVersionsOf } from '../../gateway/output-resolution/runtime-contract';

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

interface RunMasterCorpusOptions {
  /**
   * Texte à évaluer par master (sinon fichier du dépôt). `execution` (lot
   * 34D) : mode de la version évaluée ; absent : LEGACY_TEMPLATE pour un
   * texte de configuration, mode déclaré pour le fichier du dépôt.
   */
  texts?: Record<string, { text: string; source: 'file' | 'config'; execution?: MasterExecutionConfig | null }>;
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
  live?: RunMasterCorpusOptions['live'], execution?: MasterExecutionConfig,
): Promise<CorpusCaseOutcome | null> {
  const base = { id: c.id, task: c.task, file: c.file, level: c.operationCode in MASTER_CORPUS_EVALUATORS ? 'full' as const : 'schema' as const };
  const spec = structuredSpecFor(c.masterPromptCode);
  if (spec && execution?.mode === 'STRUCTURED_CONTEXT') {
    // 1 (lot 34D). Contexte structuré : configuration, puis contexte du cas.
    const reelles = live ? live.variablesFor(c) : null;
    if (live && !reelles) return null;
    try {
      const issues = checkExecutionConfig(spec, execution, (name, v) => contractVersionsOf(name).includes(v));
      if (issues.length) return { ...base, passed: false, errors: issues.map((i) => `configuration : ${i.message}`) };
      const { liveVariablesFor } = await import('./live');
      const variables = reelles ?? await liveVariablesFor(c) ?? (c.context.variables as Record<string, unknown> | undefined) ?? {};
      buildExecutionContext(spec, execution, c.task, variables);
      if (live) {
        let sortie: unknown;
        try { sortie = await live.call(c, variables); } catch (e) { return { ...base, passed: false, errors: [`appel réel : ${(e as Error).message}`] }; }
        return finish(c, sortie, base, text, readMasterFile, schemaNameFor(c, execution));
      }
    } catch (e) {
      return { ...base, passed: false, errors: [`contexte : ${(e as Error).message}`] };
    }
    return finish(c, c.output, base, text, readMasterFile, schemaNameFor(c, execution));
  }
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

/**
 * Lot 54 — schéma de sortie de la branche d'un cas pour la version évaluée :
 * contrat de sortie configuré (contexte structuré), sinon schéma historique
 * de l'opération (LEGACY_TEMPLATE).
 */
export function schemaNameFor(c: Pick<MasterCorpusCase, 'masterPromptCode' | 'task' | 'outputSchema'>, execution?: MasterExecutionConfig | null): string {
  const spec = structuredSpecFor(c.masterPromptCode);
  if (!spec || execution?.mode !== 'STRUCTURED_CONTEXT' || !execution.outputContractVersion) return c.outputSchema;
  return spec.outputContracts[execution.outputContractVersion]?.byTask[c.task]?.schemaName ?? c.outputSchema;
}

/** Lot 54 — la sortie enregistrée du cas relève-t-elle du contrat de sortie de la version évaluée ? */
export function caseMatchesExecution(c: MasterCorpusCase, execution?: MasterExecutionConfig | null): boolean {
  return caseSchemaName(c) === schemaNameFor(c, execution);
}

/** Schéma de sortie propre à la sortie enregistrée d'un cas (`outputContract`, sinon historique). */
function caseSchemaName(c: MasterCorpusCase): string {
  const spec = structuredSpecFor(c.masterPromptCode);
  if (!spec || !c.outputContract) return c.outputSchema;
  return spec.outputContracts[c.outputContract]?.byTask[c.task]?.schemaName ?? c.outputSchema;
}

/**
 * Lot 86A (P5) : contrôle d'une sortie de cas — validation discriminée puis
 * contrôle serveur de la branche — réutilisé tel quel par la qualification
 * par couple (`qualification/cases.ts`) : une seule définition du jugement.
 */
export async function evaluateCorpusOutput(
  c: MasterCorpusCase, output: unknown, text: string, readMasterFile: MasterFileReader, schemaName: string = c.outputSchema,
): Promise<CorpusCaseOutcome> {
  const base = { id: c.id, task: c.task, file: c.file, level: c.operationCode in MASTER_CORPUS_EVALUATORS ? 'full' as const : 'schema' as const };
  return finish(c, output, base, text, readMasterFile, schemaName);
}

async function finish(
  c: MasterCorpusCase, output: unknown, base: Omit<CorpusCaseOutcome, 'passed' | 'errors'>, text: string, readMasterFile: MasterFileReader,
  schemaName: string = c.outputSchema,
): Promise<CorpusCaseOutcome> {
  const errors: string[] = [];
  const evaluator = MASTER_CORPUS_EVALUATORS[c.operationCode] as (typeof MASTER_CORPUS_EVALUATORS)[string] | undefined;
  // 2. Validation discriminée (même contrôle que la passerelle).
  const schema = masterOutputSchemaFor(schemaName);
  if (!schema) return { ...base, passed: false, errors: [`schéma ${schemaName} inconnu`] };
  let data: unknown;
  try {
    // Lot 33D : même résolution déterministe que la passerelle (adaptateurs,
    // normalisation, validation champ par champ) — sans réparation IA.
    data = validateOutput(JSON.stringify(output), schema, c.operationCode, 'json', { expectedTask: c.task, taskField: c.taskField, schemaName });
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
    const execution = given?.execution
      ?? executionConfigFor({ masterPromptCode: m.masterPromptCode, source: given ? (given.source === 'file' ? 'file' : 'config') : 'file' });
    // Lot 42 : branche OPTIONNELLE absente du texte évalué (version BO
    // antérieure) — ses cas sont ignorés et la branche n'est pas exigée.
    // Lot 97A : en contexte structuré, une TASK FACULTATIVE (T4 AGENDA_REPRESENTATION) est absente quand la
    // configuration d'exécution évaluée ne la rend pas exécutable (non cochée, contrats qui ne la décrivent pas).
    const spec = structuredSpecFor(m.masterPromptCode);
    const absentes = execution?.mode === 'STRUCTURED_CONTEXT'
      ? m.tasks.filter((t) => spec && (spec.optionalTasks ?? []).includes(t) && !structuredTaskSupport(spec, execution, t).supported)
      : m.tasks.filter((t) => isOptionalMasterTask(m.masterPromptCode, t) && !inspectMasterTemplate(text).branches.includes(t));
    const exigees = m.tasks.filter((t) => !absentes.includes(t));
    for (const c of mine) {
      if (absentes.includes(c.task)) { ignores.push(c.id); continue; }
      // Lot 100B : cas du corpus #601 sans sortie enregistrée (spécification convertie, attendu = oracle) —
      // rien à REJOUER ; il n'est exécuté que sur appel réel (qualification par couple, passage réel).
      if (!o.live && c.output === undefined) { ignores.push(c.id); continue; }
      // Lot 54 : sortie enregistrée d'un autre contrat de sortie que celui de
      // la version évaluée (T4 CLASSIFY_EVENT v1 ↔ v2) — non rejouée ici.
      if (caseSchemaName(c) !== schemaNameFor(c, execution)) { ignores.push(c.id); continue; }
      const r = await runCase(c, text, o.readMasterFile, m.tasks, o.live, execution);
      if (r) outcomes.push(r); else ignores.push(c.id);
    }
    const branchesPassed = exigees.filter((t) => outcomes.some((x) => x.task === t && x.passed));
    const failures = [
      ...exigees.filter((t) => !outcomes.some((x) => x.task === t))
        .map((t) => `branche ${t} : aucun cas ${o.live ? 'exécutable en réel' : 'au corpus'}`),
      ...outcomes.filter((x) => !x.passed).map((x) => `${x.id} (${x.task}) : ${x.errors.join(' ; ')}`),
    ];
    out.push({
      treatment, masterPromptCode: m.masterPromptCode,
      textSha256: masterTextFingerprint(text), textSource: given?.source ?? 'file',
      branchesRequired: [...exigees], branchesPassed,
      casesTotal: outcomes.length, casesPassed: outcomes.filter((x) => x.passed).length,
      status: failures.length === 0 ? 'PASSED' : 'FAILED',
      cases: outcomes, failures, skipped: ignores,
    });
  }
  return out;
}
