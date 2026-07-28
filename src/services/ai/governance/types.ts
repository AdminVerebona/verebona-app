/**
 * Gouvernance des prompts — USAGE IA n°5, CDC §4.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉFAUT CORRIGÉ — le plus grave de l'audit (CDC §2.2, défaut n°9)
 *
 * `admin/ai-instructions/apply/route.ts` envoyait l'instruction et les prompts
 * au modèle, parsait sa réponse et appliquait les patchs par `writeFileSync`
 * DANS LA MÊME REQUÊTE HTTP. Sans diff, sans validation, sans test, sans
 * conservation de la version antérieure. Aucun retour arrière n'était possible.
 *
 * De surcroît, sur Scalingo, le système de fichiers d'un conteneur est éphémère
 * et non partagé entre instances : ces écritures étaient perdues au
 * redéploiement suivant et invisibles des autres instances. La fonction était
 * donc à la fois dangereuse et non fiable.
 *
 * Ici, le modèle PROPOSE. Il n'écrit jamais.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Les neuf statuts du CDC §4.5.4. */
export type ChangeRequestStatus =
  /** Instruction saisie, pas encore analysée. */
  | 'DRAFT'
  /** Le modèle a produit une proposition ; le diff est consultable. */
  | 'PROPOSED'
  /** Un humain a validé la proposition ; les tests doivent être exécutés. */
  | 'TO_TEST'
  /** Au moins un contrôle bloquant a échoué. */
  | 'TEST_FAILED'
  /** Tous les contrôles passent ; validation finale attendue. */
  | 'READY_FOR_APPROVAL'
  /** Version en service. */
  | 'ACTIVE'
  /** Écartée par un administrateur. */
  | 'REJECTED'
  /** Version retirée au profit de la précédente. */
  | 'ROLLED_BACK'
  /** Version remplacée par une plus récente. */
  | 'SUPERSEDED';

export type PromptVersionStatus = 'CANDIDATE' | 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK';

export interface PromptVersion {
  id: number;
  promptCode: string;
  version: string;
  content: string;
  contentHash: string;
  status: PromptVersionStatus;
  createdBy: number | null;
  createdAt: Date;
  activatedAt: Date | null;
}

export interface ChangeRequest {
  id: number;
  promptCode: string;
  status: ChangeRequestStatus;
  /** Instruction en langage naturel saisie par l'administrateur. */
  instruction: string;
  /** Analyse d'impact produite par le modèle — jamais appliquée telle quelle. */
  impactAnalysis: string | null;
  baseVersionId: number | null;
  candidateVersionId: number | null;
  createdBy: number;
  approvedBy: number | null;
  activatedBy: number | null;
  createdAt: Date;
}

export interface CheckResult {
  checkCode: string;
  label: string;
  passed: boolean;
  /** Un contrôle non bloquant peut échouer sans interdire l'activation. */
  blocking: boolean;
  detail: string;
  /** Mesure comparée à la version active, lorsque le contrôle en produit une. */
  baselineValue?: number;
  candidateValue?: number;
}

export interface TestRunReport {
  runId: number;
  changeRequestId: number;
  checks: CheckResult[];
  passed: boolean;
  blockingFailures: string[];
  durationMs: number;
}
