/**
 * Réconciliation de statut — CDC §4.4.4.
 *
 * « Le passage automatique au statut réalisé exige une preuve explicite et une
 *   confiance certain. »
 *
 * Règle appliquée strictement : une échéance dépassée n'est PAS une preuve de
 * réalisation. Beaucoup d'échéances sont simplement en retard, et marquer
 * « réalisé » un contrôle technique qui ne l'a pas été serait une erreur
 * silencieuse aux conséquences réelles pour l'utilisateur.
 */
import type { EvidenceConfidence } from '../evidence/evidence.types';
import type { ExistingAgendaItem } from './types';

export type StatusDecision = 'mark_done' | 'keep' | 'propose_done';

export interface StatusEvidence {
  /** Extrait littéral attestant la réalisation. */
  excerpt: string;
  confidence: EvidenceConfidence;
  documentType: string | null;
  documentDate: Date | null;
}

/** Types de documents attestant qu'une intervention a bien eu lieu. */
const COMPLETION_DOCUMENT_TYPES = new Set([
  'RAPPORT_ENTRETIEN', 'FACTURE', 'CERTIFICAT_GARANTIE', 'DIAGNOSTIC', 'DPE',
]);

/** Formulations attestant explicitement une réalisation. */
const COMPLETION_PATTERNS: RegExp[] = [
  /effectu[ée]/i, /réalis[ée]/i, /realis[ée]/i,
  /contrôle\s+favorable/i, /controle\s+favorable/i,
  /intervention\s+termin[ée]e/i,
  /travaux\s+achev[ée]s/i,
  /prestation\s+r[ée]alis[ée]e/i,
];

export function decideStatus(
  item: ExistingAgendaItem,
  evidence: StatusEvidence | null,
): { decision: StatusDecision; reason: string } {
  // Un événement créé manuellement n'est jamais modifié silencieusement (§4.4.4).
  if (item.manual) {
    return { decision: 'keep', reason: 'événement créé manuellement — jamais modifié automatiquement' };
  }

  if (item.status === 'done') {
    return { decision: 'keep', reason: 'déjà marqué réalisé' };
  }

  // Une échéance dépassée n'est pas une preuve de réalisation.
  if (!evidence) {
    return { decision: 'keep', reason: 'aucune preuve de réalisation' };
  }

  const hasAuthorizedType = evidence.documentType !== null
    && COMPLETION_DOCUMENT_TYPES.has(evidence.documentType.toUpperCase());
  const hasExplicitWording = COMPLETION_PATTERNS.some((p) => p.test(evidence.excerpt));

  if (!hasAuthorizedType || !hasExplicitWording) {
    return { decision: 'keep', reason: 'preuve non explicite ou type de document non probant' };
  }

  // Les deux conditions du §4.4.4 : preuve explicite ET confiance certaine.
  if (evidence.confidence !== 'certain') {
    return { decision: 'propose_done', reason: `preuve explicite mais confiance ${evidence.confidence}` };
  }

  return { decision: 'mark_done', reason: 'preuve explicite de réalisation, confiance certaine' };
}
