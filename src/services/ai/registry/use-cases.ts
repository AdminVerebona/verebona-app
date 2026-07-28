/**
 * Référentiel des cinq usages IA — CDC §5.1.
 *
 * ⚠️ EXIGENCE STRUCTURANTE (CDC §1.1) : cette union est FERMÉE. Ajouter une
 * sixième valeur constitue une violation du cahier des charges et fait échouer
 * `npm run ai:inventory`. Les anciennes fonctions ne peuvent subsister que
 * comme OPÉRATIONS INTERNES d'un de ces cinq usages (cf. `operations.ts`).
 */

export const AI_USE_CASE_CODES = [
  'SOURCE_ANALYSIS',
  'DATA_RECONCILIATION',
  'INTELLIGENT_ASSISTANT',
  'AGENDA_INTELLIGENCE',
  'AI_GOVERNANCE',
] as const;

export type AiUseCaseCode = (typeof AI_USE_CASE_CODES)[number];

export interface AiUseCaseDefinition {
  code: AiUseCaseCode;
  /** Libellé affiché en administration et dans l'outil de conformité. */
  label: string;
  /** Finalité produit — une finalité = un usage (CDC §2.3). */
  purpose: string;
  /** Usages historiques absorbés — trace de migration uniquement (CDC §3.4). */
  replacesLegacyUsages: number[];
  active: boolean;
}

export const AI_USE_CASES: Record<AiUseCaseCode, AiUseCaseDefinition> = {
  SOURCE_ANALYSIS: {
    code: 'SOURCE_ANALYSIS',
    label: 'Analyse unifiée des sources',
    purpose: 'Traiter tous les contenus ajoutés à Verebona dans un pipeline commun.',
    replacesLegacyUsages: [1, 2, 9, 10],
    active: true,
  },
  DATA_RECONCILIATION: {
    code: 'DATA_RECONCILIATION',
    label: 'Réconciliation et enrichissement continu',
    purpose: 'Fiabiliser champs, liaisons et contradictions à partir des preuves.',
    replacesLegacyUsages: [3, 4, 5, 10],
    active: true,
  },
  INTELLIGENT_ASSISTANT: {
    code: 'INTELLIGENT_ASSISTANT',
    label: 'Assistant intelligent Verebona',
    purpose: 'Rechercher et répondre en langage naturel avec des sources vérifiées.',
    replacesLegacyUsages: [6, 7],
    active: true,
  },
  AGENDA_INTELLIGENCE: {
    code: 'AGENDA_INTELLIGENCE',
    label: "Intelligence de l'agenda",
    purpose: 'Créer et maintenir un agenda fiable à partir des sources.',
    replacesLegacyUsages: [8],
    active: true,
  },
  AI_GOVERNANCE: {
    code: 'AI_GOVERNANCE',
    label: 'Administration et gouvernance IA',
    purpose: 'Versionner, tester, valider et restaurer les prompts et modèles.',
    replacesLegacyUsages: [11],
    active: true,
  },
};

export function isAiUseCaseCode(v: unknown): v is AiUseCaseCode {
  return typeof v === 'string' && (AI_USE_CASE_CODES as readonly string[]).includes(v);
}

/** Liste des usages actifs — source de l'inventaire d'exécution (CDC §12, critère 1). */
export function listActiveUseCases(): AiUseCaseDefinition[] {
  return Object.values(AI_USE_CASES).filter((u) => u.active);
}
