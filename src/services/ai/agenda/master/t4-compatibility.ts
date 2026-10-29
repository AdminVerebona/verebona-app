/**
 * Lot 98A (P0-B) — COMPATIBILITÉ de la version T4 active avec le moteur
 * « À traiter ». Partie PURE (aucune base, aucun appel modèle).
 *
 * Le moteur de pertinence (`assessDeadlinePertinence`) ne demande à T4
 * l'évaluation STRUCTURÉE d'une intervention (`event_context.toProcessAssessment`
 * → `intervention`) que si la version T4 active déclare le contrat de sortie
 * `t4_output_v3` ou suivant, en contexte structuré (`t4AssessmentConfig` :
 * `interventionCapable`). Une version antérieure au lot 34D reste en mode
 * historique à emplacements (migration 0290, LEGACY_TEMPLATE explicite et
 * immuable) : toute décision « date inconnue » ou « échéance passée » devient
 * alors T4_INCOMPATIBLE (carte conservée, décision différée).
 *
 * « Configuration T4 active normale » = celle du texte livré avec
 * l'application (`t4_master_v1.txt`) : contexte structuré, `t4_input_v2`,
 * `t4_output_v3`, TASK CLASSIFY_EVENT, VERIFY_COMPLETION, TEMPORAL_AMBIGUITY
 * (`T4_EXECUTION_SPEC.defaults`) — ou une version suivante compatible
 * (`t4_input_v3` / `t4_output_v4` de l'étape 6 du guide du PO).
 *
 * Une version active est IMMUABLE : la mise en conformité passe toujours par
 * un BROUILLON (nouvelle version), que le PO vérifie puis active lui-même.
 * Aucune activation automatique.
 */
import type { MasterExecutionConfig, StructuredContextSpec } from '../../master-prompts/structured-context';

/** Contrat de sortie minimal pour l'évaluation structurée d'une intervention (lot 61). */
export const T4_INTERVENTION_OUTPUT_CONTRACT = 't4_output_v3';
/** Champ d'entrée par lequel le serveur demande l'évaluation (lu dans le texte : diagnostic seulement). */
const T4_INTERVENTION_INPUT_FIELD = 'toProcessAssessment';

/** Numéro d'un contrat versionné (`t4_output_v3` → 3 ; absent ou illisible → 0). Pure. */
const numero = (v: string | null | undefined): number => Number(/_v(\d+)$/.exec(v ?? '')?.[1] ?? 0);

/**
 * La configuration d'exécution donne-t-elle l'évaluation structurée d'une
 * intervention ? Même règle que `t4AssessmentConfig` (contrat de sortie ≥ v3,
 * mode structuré — le mode historique n'a pas de contrat de sortie). Pure.
 */
export function t4ExecutionInterventionCapable(e: MasterExecutionConfig | null | undefined): boolean {
  return !!e && e.mode === 'STRUCTURED_CONTEXT' && numero(e.outputContractVersion) >= numero(T4_INTERVENTION_OUTPUT_CONTRACT);
}

const normaliser = (t: string) => t.replace(/\r\n?/g, '\n').trim();

/**
 * Le TEXTE porte-t-il l'évaluation d'intervention ? Texte identique au texte
 * livré, ou texte qui décrit le champ d'entrée `toProcessAssessment` et la
 * sortie `intervention` (repère de diagnostic, jamais un contrôle bloquant :
 * la qualité d'un texte relève du corpus et de la recette). Pure.
 */
export function t4TextCarriesIntervention(content: string, referenceText: string | null): boolean {
  if (referenceText && normaliser(referenceText) === normaliser(content)) return true;
  return content.includes(T4_INTERVENTION_INPUT_FIELD) && content.includes('intervention');
}

/**
 * Configuration CONFORME proposée à partir de la configuration actuelle
 * (pure) : contexte structuré ; contrats d'entrée et de sortie au moins ceux
 * du texte livré (une version suivante déjà choisie est conservée) ; TASK de
 * la version si elle est déjà structurée (CLASSIFY_EVENT ajoutée au besoin),
 * sinon celles par défaut.
 */
export function conformingT4Execution(spec: Pick<StructuredContextSpec, 'defaults'>, current: MasterExecutionConfig | null): MasterExecutionConfig {
  const d = spec.defaults;
  const structure = current?.mode === 'STRUCTURED_CONTEXT';
  const plusRecent = (a: string | null | undefined, b: string | null): string | null => (a && numero(a) >= numero(b) ? a : b);
  // `null` : toutes les TASK du registre (CLASSIFY_EVENT comprise) — conservé tel quel.
  let taches: string[] | null = structure ? (current?.allowedTasks ? [...current.allowedTasks] : null) : (d.allowedTasks ? [...d.allowedTasks] : null);
  if (taches && !taches.includes('CLASSIFY_EVENT')) taches = ['CLASSIFY_EVENT', ...taches];
  return {
    mode: 'STRUCTURED_CONTEXT',
    inputContractVersion: plusRecent(structure ? current?.inputContractVersion : null, d.inputContractVersion),
    outputContractVersion: plusRecent(structure ? current?.outputContractVersion : null, d.outputContractVersion),
    allowedTasks: taches,
  };
}

export type T4CompatibilityIssueCode =
  | 'LEGACY_TEMPLATE'
  | 'OUTPUT_CONTRACT_TOO_OLD'
  | 'CLASSIFY_EVENT_NOT_ALLOWED'
  | 'TEXT_WITHOUT_INTERVENTION';

export interface T4Compatibility {
  /** Le moteur « À traiter » reçoit l'évaluation structurée (plus de T4_INCOMPATIBLE). */
  compatible: boolean;
  /** Le texte porte l'évaluation d'intervention. */
  textReady: boolean;
  /** Ce qui manque, en clair (vide si rien). */
  issues: Array<{ code: T4CompatibilityIssueCode; message: string }>;
  /**
   * Chemin de mise en conformité :
   *   · NONE — rien à faire ;
   *   · PREPARE_SAME_TEXT — brouillon avec le MÊME texte et la configuration conforme (bouton BO) ;
   *   · RESTART_FROM_REFERENCE — le texte ne porte pas l'évaluation : brouillon, « Repartir du texte de référence ».
   */
  remedy: 'NONE' | 'PREPARE_SAME_TEXT' | 'RESTART_FROM_REFERENCE';
  /** Configuration d'exécution conforme proposée. */
  target: MasterExecutionConfig;
}

/** Diagnostic de compatibilité d'une version T4 (active ou brouillon). Pure. */
export function assessT4Compatibility(p: {
  spec: Pick<StructuredContextSpec, 'defaults'>; execution: MasterExecutionConfig | null; content: string; referenceText: string | null;
}): T4Compatibility {
  const e = p.execution;
  const issues: T4Compatibility['issues'] = [];
  const structure = e?.mode === 'STRUCTURED_CONTEXT';
  if (!structure) {
    issues.push({ code: 'LEGACY_TEMPLATE', message: 'Mode historique à emplacements ({{…}}) : cette version ne déclare aucun contrat de sortie, le serveur ne peut pas lui demander d’évaluer une intervention « À traiter ».' });
  } else if (!t4ExecutionInterventionCapable(e)) {
    issues.push({ code: 'OUTPUT_CONTRACT_TOO_OLD', message: `Contrat de sortie ${e?.outputContractVersion ?? 'absent'} : l’évaluation structurée d’une intervention exige ${T4_INTERVENTION_OUTPUT_CONTRACT} ou suivant.` });
  }
  if (structure && e?.allowedTasks && !e.allowedTasks.includes('CLASSIFY_EVENT')) {
    issues.push({ code: 'CLASSIFY_EVENT_NOT_ALLOWED', message: 'La TASK CLASSIFY_EVENT n’est pas cochée : l’évaluation d’une intervention passe par elle.' });
  }
  const textReady = t4TextCarriesIntervention(p.content, p.referenceText);
  if (!textReady) {
    issues.push({ code: 'TEXT_WITHOUT_INTERVENTION', message: 'Le texte ne décrit pas l’évaluation d’une intervention « À traiter » (champ toProcessAssessment, réponse intervention) : il faut repartir du texte de référence livré avec l’application.' });
  }
  const compatible = t4ExecutionInterventionCapable(e) && !issues.some((i) => i.code === 'CLASSIFY_EVENT_NOT_ALLOWED');
  const remedy: T4Compatibility['remedy'] = compatible && textReady ? 'NONE' : textReady ? 'PREPARE_SAME_TEXT' : 'RESTART_FROM_REFERENCE';
  return { compatible, textReady, issues, remedy, target: conformingT4Execution(p.spec, e) };
}
