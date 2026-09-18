/**
 * Traitements T1 à T5 — CDC BO IA §1.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX VOCABULAIRES POUR CINQ CHOSES
 *
 * Le BO parle de T1 à T5 ; le référentiel IA parle de `SOURCE_ANALYSIS`,
 * `DATA_RECONCILIATION` et consorts. Ce sont les mêmes cinq traitements, vus
 * par deux documents écrits à deux mois d'intervalle.
 *
 * La correspondance vit ici, en un seul endroit, et nulle part en base. Une
 * correspondance dupliquée finit par diverger, et le jour où elle diverge,
 * c'est une configuration qui s'applique au mauvais traitement.
 *
 * Elle est bijective, et un test le vérifie : aucun usage sans traitement,
 * aucun traitement sans usage. C'est ce qui garantit qu'une version couvre
 * réellement tout le périmètre IA.
 */
import { AI_USE_CASE_CODES, type AiUseCaseCode } from '../registry/use-cases';

export const TREATMENTS = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export type Treatment = (typeof TREATMENTS)[number];

export interface TreatmentDefinition {
  code: Treatment;
  useCaseCode: AiUseCaseCode;
  label: string;
  /**
   * Passe par la file globale et possède donc des déclencheurs (GEN-004).
   *
   * T2 et T5 sont synchrones et hors file : leurs lignes de configuration
   * n'ont pas de déclencheurs, et l'écran ne doit pas en proposer.
   */
  batch: boolean;
}

export const TREATMENT_DEFINITIONS: Readonly<Record<Treatment, TreatmentDefinition>> = {
  T1: { code: 'T1', useCaseCode: 'SOURCE_ANALYSIS', label: 'Sources', batch: true },
  T2: { code: 'T2', useCaseCode: 'INTELLIGENT_ASSISTANT', label: 'Assistant', batch: false },
  T3: { code: 'T3', useCaseCode: 'DATA_RECONCILIATION', label: 'Rationalisation', batch: true },
  T4: { code: 'T4', useCaseCode: 'AGENDA_INTELLIGENCE', label: 'Échéances', batch: true },
  T5: { code: 'T5', useCaseCode: 'AI_GOVERNANCE', label: 'Prompt Control', batch: false },
};

export function getTreatment(code: Treatment): TreatmentDefinition {
  return TREATMENT_DEFINITIONS[code];
}

export function isTreatment(value: string): value is Treatment {
  return (TREATMENTS as readonly string[]).includes(value);
}

/** Traitement correspondant à un usage du référentiel. */
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
  const manquants = AI_USE_CASE_CODES.filter((u) => !couverts.has(u));
  if (manquants.length > 0) {
    throw new Error(
      `[traitements] Usages sans traitement BO : ${manquants.join(', ')}. ` +
      'Une version de configuration ne couvrirait pas tout le périmètre IA.',
    );
  }
  if (couverts.size !== TREATMENTS.length) {
    throw new Error('[traitements] Deux traitements pointent vers le même usage.');
  }
}
