/**
 * Traitements T1, T2, T3, T4 et T6 — CDC BO IA §1.3 ; T6 : CDC Mascotte
 * d'accueil §19 ; T5 retiré au lot 49.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX VOCABULAIRES POUR LES MÊMES CHOSES
 *
 * Le BO parle de T1…T6 ; le référentiel IA parle de `SOURCE_ANALYSIS`,
 * `DATA_RECONCILIATION` et consorts. Ce sont les mêmes traitements, vus
 * par deux documents écrits à deux mois d'intervalle.
 *
 * La correspondance vit ici, en un seul endroit, et nulle part en base. Une
 * correspondance dupliquée finit par diverger, et le jour où elle diverge,
 * c'est une configuration qui s'applique au mauvais traitement.
 *
 * Elle est bijective sur les usages MÉTIER, et un test le vérifie : aucun
 * usage métier sans traitement, aucun traitement sans usage ; l'usage
 * technique `AI_GOVERNANCE` n'a pas de traitement. C'est ce qui garantit qu'une version couvre
 * réellement tout le périmètre IA.
 */
import { AI_USE_CASE_CODES, type AiUseCaseCode } from '../registry/use-cases';

/**
 * Lot 49 (ticket 12) — T5 « Prompt Control » est SUPPRIMÉ définitivement.
 *
 * Le référentiel OPÉRATIONNEL compte exactement cinq traitements : T1, T2,
 * T3, T4 et T6. Le code « T5 » n'existe plus que dans l'HISTORIQUE (anciennes
 * versions de configuration, packages, prompts maîtres, traces) : il est lu
 * en lecture seule et ignoré partout ailleurs (`RETIRED_TREATMENTS`).
 *
 * L'usage `AI_GOVERNANCE` reste au référentiel IA, mais comme USAGE
 * TECHNIQUE indépendant des traitements (sondes de modèles, test
 * fournisseur, évaluation de prompts — `TECHNICAL_USE_CASES`) : il n'a ni
 * ligne de configuration, ni état T1–T6, ni prompt maître.
 */
export const TREATMENTS = ['T1', 'T2', 'T3', 'T4', 'T6'] as const;
export type Treatment = (typeof TREATMENTS)[number];

/** Traitements retirés : présents dans l'historique seulement, jamais recréés. */
export const RETIRED_TREATMENTS = ['T5'] as const;
type RetiredTreatment = (typeof RETIRED_TREATMENTS)[number];

export function isRetiredTreatment(value: unknown): value is RetiredTreatment {
  return typeof value === 'string' && (RETIRED_TREATMENTS as readonly string[]).includes(value);
}

/**
 * Usages TECHNIQUES : rattachés à aucun traitement (pas de configuration
 * versionnée, pas d'état, pas de prompt maître). Leurs appels sont tracés
 * en coût technique, non facturable, et ne sont jamais des exécutions T1–T6.
 */
export const TECHNICAL_USE_CASES: readonly AiUseCaseCode[] = ['AI_GOVERNANCE'];

export function isTechnicalUseCase(useCaseCode: string): boolean {
  return (TECHNICAL_USE_CASES as readonly string[]).includes(useCaseCode);
}

interface TreatmentDefinition {
  code: Treatment;
  useCaseCode: AiUseCaseCode;
  label: string;
  /**
   * Passe par la file globale et possède donc des déclencheurs (GEN-004).
   *
   * T2 et T6 sont synchrones et hors file : leurs lignes de configuration
   * n'ont pas de déclencheurs, et l'écran ne doit pas en proposer.
   */
  batch: boolean;
}

export const TREATMENT_DEFINITIONS: Readonly<Record<Treatment, TreatmentDefinition>> = {
  T1: { code: 'T1', useCaseCode: 'SOURCE_ANALYSIS', label: 'Sources', batch: true },
  T2: { code: 'T2', useCaseCode: 'INTELLIGENT_ASSISTANT', label: 'Assistant', batch: false },
  T3: { code: 'T3', useCaseCode: 'DATA_RECONCILIATION', label: 'Rationalisation', batch: true },
  T4: { code: 'T4', useCaseCode: 'AGENDA_INTELLIGENCE', label: 'Échéances', batch: true },
  // CDC Mascotte BO-003 : synchrone, hors file globale, comme T2.
  T6: { code: 'T6', useCaseCode: 'HOME_MASCOT', label: 'Mascotte', batch: false },
};

/**
 * Le prompt maître du traitement s'administre-t-il dans la section « Prompts
 * maîtres » du BO (versions brouillon → actif, BO-IA-PROMPTS-01) ? Tous les
 * traitements opérationnels ; jamais un traitement retiré.
 */
export function isMasterPromptAdministrable(code: string): code is Treatment {
  return (TREATMENTS as readonly string[]).includes(code);
}

/**
 * Traitements SANS architecture `steps` (lot 16b, retrait de l'ancien moteur) :
 * leur prompt maître est leur seul moteur — T6 (`t6_master_v1`) depuis
 * L16b-1 (migration 0231), T2 (`t2_master_v1`) et T4
 * (`t4_master_v1`) depuis L16b-2 (migration 0232), T1 (`t1_master_v1`) depuis
 * L16b-3a (migration 0233), T3 (`t3_master_v1`) depuis L16b-3b (migration
 * 0234). TOUS les traitements, désormais : une ligne de configuration est lue
 * `master` quelle que soit la valeur stockée, et une demande `steps` est
 * refusée (`checkPromptArchitectureChange`, `masterConfigIssues`).
 */
export const MASTER_ONLY_TREATMENTS: readonly Treatment[] = TREATMENTS;

export function isMasterOnlyTreatment(code: Treatment): boolean {
  return MASTER_ONLY_TREATMENTS.includes(code);
}

export function getTreatment(code: Treatment): TreatmentDefinition {
  return TREATMENT_DEFINITIONS[code];
}

export function isTreatment(value: string): value is Treatment {
  return (TREATMENTS as readonly string[]).includes(value);
}

/**
 * Traitement correspondant à un usage du référentiel, ou `null` pour un usage
 * TECHNIQUE (`AI_GOVERNANCE`, rattaché à aucun traitement depuis le lot 49).
 */
export function treatmentOfUseCase(useCaseCode: AiUseCaseCode): Treatment | null {
  if (isTechnicalUseCase(useCaseCode)) return null;
  return treatmentForUseCase(useCaseCode);
}

/** Traitement correspondant à un usage MÉTIER du référentiel (lève pour un usage technique). */
export function treatmentForUseCase(useCaseCode: AiUseCaseCode): Treatment {
  const found = TREATMENTS.find((t) => TREATMENT_DEFINITIONS[t].useCaseCode === useCaseCode);
  if (!found) {
    // Impossible tant que la bijection tient ; le test la vérifie. Lever plutôt
    // que renvoyer un défaut : un traitement deviné appliquerait la
    // configuration d'un autre.
    throw new Error(`[traitements] Aucun traitement pour l'usage « ${useCaseCode} ».`);
  }
  return found;
}

/** Traitements batch, dans l'ordre du CDC. */
export function listBatchTreatments(): Treatment[] {
  return TREATMENTS.filter((t) => TREATMENT_DEFINITIONS[t].batch);
}

/** Vérifie la bijection au démarrage, comme le référentiel vérifie la sienne. */
export function assertTreatmentMapping(): void {
  const couverts = new Set(TREATMENTS.map((t) => TREATMENT_DEFINITIONS[t].useCaseCode));
  const techniquesRattaches = TECHNICAL_USE_CASES.filter((u) => couverts.has(u));
  if (techniquesRattaches.length > 0) {
    throw new Error(
      `[traitements] Usage technique rattaché à un traitement : ${techniquesRattaches.join(', ')}. ` +
      'AI_GOVERNANCE est indépendant des traitements (lot 49, retrait de T5).',
    );
  }
  const manquants = AI_USE_CASE_CODES.filter((u) => !couverts.has(u) && !isTechnicalUseCase(u));
  if (manquants.length > 0) {
    throw new Error(
      `[traitements] Usages métier sans traitement BO : ${manquants.join(', ')}. ` +
      'Une version de configuration ne couvrirait pas tout le périmètre IA.',
    );
  }
  if (couverts.size !== TREATMENTS.length) {
    throw new Error('[traitements] Deux traitements pointent vers le même usage.');
  }
}
