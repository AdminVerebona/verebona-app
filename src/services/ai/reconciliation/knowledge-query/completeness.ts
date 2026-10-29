/**
 * Lot 98A (P0-A) — COMPLÉTUDE d'une réponse KNOWLEDGE_QUERY, pour la recette
 * du prompt T3 RÉELLEMENT actif (cas de référence du corpus, rôle « answer »,
 * rejoués par « Tester ce couple » au BO) et pour les tests.
 *
 * Une réponse techniquement VALIDE peut être INCOMPLÈTE : sur « La durée est
 * égale à 22 ans » d'une offre de financement, T3 rend la durée mais pas
 * l'indice de remboursement (`repayment`) ; le code ne peut alors pas conclure
 * que la date de fin, inconnue, n'est nécessaire à aucune démarche, et la
 * carte « À traiter » reste ouverte.
 *
 * Ce module ne lit AUCUN mot du document : il compare les constats VALIDÉS
 * par le serveur (`validate.ts`) à l'attendu déclaré du cas de référence
 * (cibles requises, valeurs normalisées, cibles interdites), puis rejoue la
 * chaîne déterministe EXISTANTE (constituants → échéancier → besoin d'une date
 * de fin, lot 76 I) pour dire quelle décision la réponse permet.
 */
import { FIELD_TARGET, type KnowledgeElement } from './contract';
import type { ValidatedFinding } from './validate';

/** Attendu de complétude d'un cas de référence (champs facultatifs). */
export interface CompletenessExpectation {
  /** Cibles qui doivent figurer parmi les constats retenus (ex. `duration`, `repayment`). */
  required?: readonly string[];
  /** Cible → valeur normalisée attendue (au moins un constat de cette cible porte cette valeur ; autres cibles admises). */
  values?: Readonly<Record<string, string>>;
  /** Cibles qui ne doivent JAMAIS figurer (`FIELD` : date de fin non écrite = date inventée). */
  forbidden?: readonly string[];
}

export interface CompletenessVerdict {
  complete: boolean;
  /** Cibles requises absentes (réponse incomplète). */
  missing: string[];
  /** Cibles interdites présentes. */
  forbiddenPresent: string[];
  /** Valeurs attendues non retrouvées. */
  valueMismatches: Array<{ target: string; expected: string; obtained: string[] }>;
}

/** Complétude des constats retenus au regard de l'attendu (pure). */
export function knowledgeCompleteness(findings: readonly ValidatedFinding[], e: CompletenessExpectation): CompletenessVerdict {
  const cibles = new Set(findings.map((f) => f.target));
  const missing = [...new Set(e.required ?? [])].filter((t) => !cibles.has(t)).sort();
  const forbiddenPresent = [...new Set(e.forbidden ?? [])].filter((t) => cibles.has(t)).sort();
  const valueMismatches: CompletenessVerdict['valueMismatches'] = [];
  for (const [target, expected] of Object.entries(e.values ?? {})) {
    const obtenues = findings.filter((f) => f.target === target).map((f) => f.normalized ?? f.rawValue);
    if (!obtenues.includes(expected)) valueMismatches.push({ target, expected, obtained: obtenues });
  }
  return { complete: missing.length === 0 && forbiddenPresent.length === 0 && valueMismatches.length === 0, missing, forbiddenPresent, valueMismatches };
}

/** Décision que la réponse permet pour une date de fin inconnue (chaîne existante, sans IA). */
export type EndDateDecision =
  /** Une date de fin est écrite (cible FIELD) : règle commune (proposition, arbitrage). */
  | 'DATE_FOUND'
  /** Remboursement identifié, aucune démarche de fin : NO_ACTION / UNDATED_NOT_NEEDED, carte fermée. */
  | 'NO_ACTION_UNDATED_NOT_NEEDED'
  /** Le code ne peut pas conclure : la question de la date reste posée (ou part à T4). */
  | 'DATE_STILL_NEEDED';

export interface EndDateNeedOutcome {
  repaymentSchedule: boolean;
  endActions: string[];
  decision: EndDateDecision;
}

const texteElement = (e: Pick<KnowledgeElement, 'label' | 'value' | 'text'>) => [e.label, e.value, e.text].filter((x): x is string => !!x).join(' ');

/**
 * Besoin d'une date de fin d'après les constats retenus (lot 76 I) : mêmes
 * fonctions que le moteur « À traiter » — constituants sémantiques
 * (`semanticConstituents`), échéancier (`computeScheduleDerivation`), démarche
 * attachée à la fin (`endDateNeed`, sur les textes transmis). Reproduit la
 * condition d'entrée de `assessDeadlinePertinence` quand aucune date n'est lue :
 * échéancier lu et aucune démarche de fin → NO_ACTION / UNDATED_NOT_NEEDED.
 */
export async function endDateNeedOf(findings: readonly ValidatedFinding[], elements: ReadonlyArray<Pick<KnowledgeElement, 'label' | 'value' | 'text'>>): Promise<EndDateNeedOutcome> {
  const [sem, dv] = await Promise.all([
    import('@/services/to-process/document-semantic-knowledge'),
    import('@/services/to-process/document-derivations'),
  ]);
  const extra = sem.semanticConstituents({
    status: 'ANSWERED', findings: [...findings], rejected: [], contradictions: [], aiCalled: true, calls: 1, cached: false, traceIds: [],
    promptVersion: null, questionFingerprint: 'recette', contextFingerprint: null, summary: null, queryId: null,
  });
  const s = extra?.schedule ?? {};
  const schedule = dv.computeScheduleDerivation({
    firstInstalment: s.firstInstalment ?? [], lastInstalment: s.lastInstalment ?? [], count: s.count ?? [],
    periodicity: s.periodicity ?? [], disbursement: s.disbursement ?? [], repayment: s.repayment ?? [],
  });
  const besoin = dv.endDateNeed({ repaymentSchedule: schedule.evidenced, textes: elements.map(texteElement) });
  const dateLue = findings.some((f) => f.target === FIELD_TARGET && f.normalized);
  return {
    repaymentSchedule: besoin.repaymentSchedule, endActions: besoin.endActions,
    decision: dateLue ? 'DATE_FOUND' : besoin.notNeeded ? 'NO_ACTION_UNDATED_NOT_NEEDED' : 'DATE_STILL_NEEDED',
  };
}
