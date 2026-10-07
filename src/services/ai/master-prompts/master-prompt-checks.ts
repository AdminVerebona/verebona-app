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
 */
import {
  inspectMasterTemplate, isOptionalMasterVariable, masterBranchMarker, renderMasterPrompt, MasterPromptError,
} from '../prompts/prompt-loader';
import { declaredMasterVariables, masterPromptForTreatment } from '../config/prompt-architecture';
import type { Treatment } from '../config/treatments';

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
  | 'OPTIONAL_PLACEHOLDER_MISSING';

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

/** Contrôle complet d'un texte de prompt maître pour un traitement. */
export function checkMasterPromptContent(treatment: Treatment, content: string): MasterPromptCheckResult {
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
