/**
 * Contrôles TECHNIQUES d'un prompt maître avant activation — ticket
 * BO-IA-PROMPTS-01 (AC09).
 *
 * Seuls les défauts qui empêchent RÉELLEMENT le prompt de fonctionner
 * bloquent l'activation : chacun ferait échouer les appels du traitement
 * (`renderMasterPrompt` refuse le rendu, la passerelle rend
 * `MASTER_PROMPT_INVALID`). Le corpus, lui, n'intervient JAMAIS ici : il
 * reste un contrôle qualité facultatif.
 *
 * Bloquants : prompt vide, contenu invalide (caractères de contrôle),
 * dépassement de la taille maximale, emplacement de branche absent, section
 * de branche absente, emplacement `{{X}}` inconnu du code, donnée fournie
 * par le code sans emplacement, rendu impossible d'une branche.
 * Non bloquant : emplacement optionnel absent (la donnée n'est pas transmise,
 * la règle reste appliquée par le serveur).
 *
 * Fonctions pures (registre et texte seulement) : instantanées, testées sans
 * base. Messages en français, sans référence technique interne.
 *
 * Lot 34D — prompt en mode CONTEXTE STRUCTURÉ (T4) : le texte est LIBRE. Plus
 * aucun contrôle d'emplacement `{{X}}` ni de titre « BRANCHE TASK = … » (le
 * serveur transmet les données lui-même). Bloquants : prompt vide ou
 * invalide, contrat d'entrée absent ou invalide, TASK non configurées ou
 * inconnues, contrat de sortie absent ou invalide, configuration modèle
 * incomplète. La QUALITÉ fonctionnelle (une branche mal décrite) relève des
 * tests et du corpus, jamais d'une recherche de chaînes dans le texte.
 */
import {
  inspectMasterTemplate, isOptionalMasterVariable, masterBranchMarker, renderMasterPrompt, MasterPromptError,
} from '../prompts/prompt-loader';
import { declaredMasterVariables, masterPromptForTreatment } from '../config/prompt-architecture';
import type { Treatment } from '../config/treatments';
import { AI_OPERATIONS } from '../registry/operations';
import { contractVersionsOf } from '../gateway/output-resolution/runtime-contract';
import { checkExecutionConfig, structuredSpecFor, type MasterExecutionConfig } from './structured-context';

/**
 * Taille maximale d'un prompt maître (caractères). Les masters du dépôt font
 * 10 à 40 k caractères ; au-delà de 100 k (≈ 25 k jetons), le prompt seul
 * consommerait une part déraisonnable de la fenêtre et du coût de CHAQUE
 * appel — limite technique réelle, pas une préférence éditoriale.
 */
export const MASTER_PROMPT_MAX_CHARS = 100_000;

export type MasterPromptIssueCode =
  | 'NO_MASTER'
  | 'PROMPT_EMPTY'
  | 'INVALID_CONTENT'
  | 'TOO_LONG'
  | 'BRANCH_PLACEHOLDER_MISSING'
  | 'BRANCH_SECTION_MISSING'
  | 'UNKNOWN_PLACEHOLDER'
  | 'REQUIRED_PLACEHOLDER_MISSING'
  | 'RENDER_FAILED'
  | 'OPTIONAL_PLACEHOLDER_MISSING'
  // Lot 34D — mode contexte structuré (T4).
  | 'EXECUTION_MODE_UNSUPPORTED'
  | 'INPUT_CONTRACT_INVALID'
  | 'OUTPUT_CONTRACT_INVALID'
  | 'TASKS_INVALID'
  | 'MODEL_CONFIG_INVALID'
  | 'STRUCTURED_PLACEHOLDER_PRESENT';

export interface MasterPromptIssue {
  code: MasterPromptIssueCode;
  message: string;
  blocking: boolean;
}

export interface MasterPromptCheckResult {
  ok: boolean;
  blocking: MasterPromptIssue[];
  warnings: MasterPromptIssue[];
}

// Caractères de contrôle hors tabulation et fins de ligne : un texte collé
// depuis un binaire ou un éditeur défaillant, jamais une consigne.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const bloquant = (code: MasterPromptIssueCode, message: string): MasterPromptIssue => ({ code, message, blocking: true });

/**
 * Contrôle complet d'un texte de prompt maître pour un traitement.
 * `execution` (lot 34D) : configuration d'exécution de la version ; absente
 * ou LEGACY_TEMPLATE : contrôles historiques des emplacements.
 */
export function checkMasterPromptContent(
  treatment: Treatment, content: string, execution?: MasterExecutionConfig | null,
): MasterPromptCheckResult {
  const blocking: MasterPromptIssue[] = [];
  const warnings: MasterPromptIssue[] = [];
  const fin = () => ({ ok: blocking.length === 0, blocking, warnings });

  const master = masterPromptForTreatment(treatment);
  if (!master) {
    blocking.push(bloquant('NO_MASTER', `Aucun prompt maître n’existe pour ${treatment} : rien ne peut être activé.`));
    return fin();
  }
  if (typeof content !== 'string' || content.trim() === '') {
    blocking.push(bloquant('PROMPT_EMPTY', 'Le prompt est vide.'));
    return fin();
  }
  if (content.length > MASTER_PROMPT_MAX_CHARS) {
    blocking.push(bloquant('TOO_LONG',
      `Le prompt dépasse la taille maximale (${content.length.toLocaleString('fr-FR')} caractères pour ${MASTER_PROMPT_MAX_CHARS.toLocaleString('fr-FR')} au plus).`));
  }
  if (CONTROL_CHARS.test(content)) {
    blocking.push(bloquant('INVALID_CONTENT', 'Le texte contient des caractères invalides (caractères de contrôle invisibles) : recollez-le depuis un éditeur de texte.'));
  }

  const spec = structuredSpecFor(master.masterPromptCode);
  if (execution?.mode === 'STRUCTURED_CONTEXT') {
    if (!spec) {
      blocking.push(bloquant('EXECUTION_MODE_UNSUPPORTED',
        `Le mode « contexte structuré » n’est pas disponible pour ${treatment} : ce prompt garde ses emplacements {{…}}.`));
      return fin();
    }
    checkStructured(spec, execution, content, blocking, warnings);
    return fin();
  }

  const info = inspectMasterTemplate(content);
  const cle = info.discriminant ?? 'TASK';
  if (!info.hasTaskPlaceholder) {
    blocking.push(bloquant('BRANCH_PLACEHOLDER_MISSING',
      'L’emplacement de branche {{TASK}} (ou {{MODE}}) est absent : le serveur ne pourrait pas indiquer la branche à exécuter.'));
  }
  // T5 (§27, lot 32B) : ses modes ne sont pas des sections « BRANCHE MODE =
  // X » mais la ligne « Valeurs autorisées : ANALYZE | MODIFY » qui suit
  // « MODE = {{MODE}} » — le message nomme ce que l'administrateur doit
  // rétablir dans CE texte.
  const sections = /BRANCHE\s+(?:TASK|MODE)\s*=/.test(content);
  for (const t of master.tasks) {
    if (!info.branches.includes(t)) {
      blocking.push(bloquant('BRANCH_SECTION_MISSING', sections
        ? `La section « ${masterBranchMarker(t, cle)} » est absente : les appels de cette branche échoueraient.`
        : `Le mode ${t} est absent : rétablissez la ligne « Valeurs autorisées : ${master.tasks.join(' | ')} » juste après `
          + `« ${cle} = {{${cle}}} » (ou une section « ${masterBranchMarker(t, cle)} ») — sinon les appels de ce mode échoueraient.`));
    }
  }

  const declares = declaredMasterVariables(master.masterPromptCode);
  if (declares.length > 0) {
    const presents = info.placeholders.filter((p) => p !== info.discriminant);
    for (const v of presents.filter((p) => !declares.includes(p))) {
      blocking.push(bloquant('UNKNOWN_PLACEHOLDER',
        `L’emplacement {{${v}}} est inconnu : aucune donnée n’est fournie pour lui, chaque appel échouerait.`));
    }
    for (const v of declares.filter((d) => !presents.includes(d))) {
      if (isOptionalMasterVariable(master.masterPromptCode, v)) {
        warnings.push({
          code: 'OPTIONAL_PLACEHOLDER_MISSING', blocking: false,
          message: `L’emplacement facultatif {{${v}}} est absent : cette donnée ne sera pas transmise au modèle (la règle correspondante reste appliquée par le serveur).`,
        });
      } else {
        blocking.push(bloquant('REQUIRED_PLACEHOLDER_MISSING',
          `L’emplacement obligatoire {{${v}}} a été supprimé : la donnée fournie par l’application n’aurait plus de place, chaque appel échouerait.`));
      }
    }
  }

  // Filet : rendu réel de chaque branche (mêmes règles que la passerelle),
  // seulement si rien n'a été détecté — sinon le message serait redondant.
  if (blocking.length === 0) {
    const variables = Object.fromEntries(declares.map((v) => [v, null]));
    for (const task of master.tasks) {
      try {
        renderMasterPrompt(content, { masterPromptCode: master.masterPromptCode, task, allowedTasks: master.tasks, variables });
      } catch (e) {
        const detail = e instanceof MasterPromptError ? e.message.replace(/^\[prompt-loader\] [^:]+ : /, '') : (e as Error).message;
        blocking.push(bloquant('RENDER_FAILED', `La branche ${task} ne peut pas être préparée : ${detail}`));
      }
    }
  }
  return fin();
}

const CODE_PAR_CHAMP: Record<string, MasterPromptIssueCode> = {
  inputContractVersion: 'INPUT_CONTRACT_INVALID',
  outputContractVersion: 'OUTPUT_CONTRACT_INVALID',
  allowedTasks: 'TASKS_INVALID',
  mode: 'EXECUTION_MODE_UNSUPPORTED',
};

/**
 * Contrôles TECHNIQUES d'un prompt en contexte structuré (lot 34D, T4) : la
 * configuration d'exécution et le registre, jamais la formulation du texte.
 */
function checkStructured(
  spec: NonNullable<ReturnType<typeof structuredSpecFor>>, execution: MasterExecutionConfig, content: string,
  blocking: MasterPromptIssue[], warnings: MasterPromptIssue[],
): void {
  for (const i of checkExecutionConfig(spec, execution, (name, v) => contractVersionsOf(name).includes(v))) {
    blocking.push(bloquant(CODE_PAR_CHAMP[i.field] ?? 'INPUT_CONTRACT_INVALID', i.message));
  }
  // Configuration modèle : chaque TASK autorisée a une opération active avec un modèle principal.
  for (const t of (execution.allowedTasks ?? [...spec.knownTasks]).filter((x) => spec.knownTasks.includes(x))) {
    const op = Object.values(AI_OPERATIONS).find((o) => o.active && o.masterPromptCode === spec.masterPromptCode && o.task === t);
    if (!op || !op.primaryModel) {
      blocking.push(bloquant('MODEL_CONFIG_INVALID', `Aucune opération active avec un modèle configuré pour la TASK ${t}.`));
    }
  }
  // Emplacements historiques restés dans le texte : ils ne seraient plus
  // remplacés (les données passent par EXECUTION_CONTEXT). Signalé, jamais bloquant.
  const restes = inspectMasterTemplate(content).placeholders;
  if (restes.length > 0) {
    warnings.push({
      code: 'STRUCTURED_PLACEHOLDER_PRESENT', blocking: false,
      message: `En contexte structuré, ${restes.map((p) => `{{${p}}}`).join(', ')} ne sont plus remplacés : les données sont transmises `
        + 'automatiquement au modèle (bloc EXECUTION_CONTEXT). Vous pouvez retirer ces emplacements du texte.',
    });
  }
}
