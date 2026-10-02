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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CDC 15 T4-12 à T4-14 (lot 14, arbitrages lead validés)
 *
 * Quatre états : completed | not_completed | not_proven | unknown.
 * « Non prouvé » n'est jamais « non réalisé ».
 *
 * FENÊTRES D'OCCURRENCE (`matchOccurrence`) — une preuve ne clôt que
 * l'occurrence qu'elle couvre :
 *   · exacte     : preuve datée à ±7 jours de l'occurrence ;
 *   · récurrente : ± une demi-période de la série (annuelle : ±182 j) — la
 *                  preuve appartient à l'occurrence la plus proche ; une
 *                  facture 2025 ne clôt pas l'occurrence 2026 ;
 *   · ponctuelle : de 90 jours AVANT l'échéance à n'importe quand APRÈS
 *                  (réalisation anticipée ou en retard) ;
 *   · hors fenêtre : `none` (not_proven) ; preuve non datée : `ambiguous`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { EvidenceConfidence } from '../evidence/evidence.types';
import type { ExistingAgendaItem } from './types';
import { resolveDocumentType, type DocumentCatalogEntry } from '@/services/canonical/registry';

export type StatusDecision = 'mark_done' | 'keep' | 'propose_done';

export interface StatusEvidence {
  /** Extrait littéral attestant la réalisation. */
  excerpt: string;
  confidence: EvidenceConfidence;
  documentType: string | null;
  documentDate: Date | null;
}

// ══════════════════════════════════════════════════════════════════════════
// CDC 15 T4-12 à T4-14 (lot 14) — QUATRE ÉTATS, PREUVE PAR TYPE, OCCURRENCE
//
// `decideCompletion` est la seule décision depuis le lot 16b-2 (l'ancien
// `decideStatus` est retiré avec `AI_T4_EFFECTS`) : elle ne clôt jamais sur
// une facture simple ni sur une autre occurrence, et la branche
// VERIFY_COMPLETION du master T4 rend les quatre états qu'elle attend.
//
// Persistance (inchangée, aucune colonne) : `agenda_items.manual_status`
// ∈ {NULL, 'realise', 'annule'}. Correspondance :
//   · completed      → `mark_done` (→ 'realise') si confiance certaine et
//                      occurrence établie ; sinon `propose_done` (À traiter) ;
//   · not_completed  → `propose_not_done` : jamais écrit automatiquement,
//                      proposé à l'utilisateur (qui peut choisir « annulé ») ;
//   · not_proven     → `keep` : statut inchangé (NULL) ;
//   · unknown        → `keep` : statut inchangé (NULL).
// « Non prouvé » n'est jamais « non réalisé » : aucun des deux derniers
// états n'écrit quoi que ce soit.
// ══════════════════════════════════════════════════════════════════════════


export type CompletionStatus = 'completed' | 'not_completed' | 'not_proven' | 'unknown';
export type OccurrenceMatch = 'exact' | 'probable' | 'ambiguous' | 'none';
export type CompletionDecisionKind = StatusDecision | 'propose_not_done';

export interface CompletionEvidence extends StatusEvidence {
  /**
   * Forme de preuve identifiée (code de `completionProofs` du
   * DOCUMENT_CATALOG, ex. `FACTURE_ACQUITTEE_PRESTATION_DATEE`), si connue.
   */
  proofCode?: string | null;
  /** Date de réalisation lue dans la preuve ; à défaut, date du document. */
  occurrenceDate?: Date | null;
}

export interface CompletionDecision {
  status: CompletionStatus;
  decision: CompletionDecisionKind;
  occurrenceMatch: OccurrenceMatch;
  reasonCode:
    | 'MANUAL_ITEM_PROTECTED' | 'ALREADY_DONE' | 'NO_EVIDENCE' | 'DOCUMENT_TYPE_UNKNOWN'
    | 'DOCUMENT_TYPE_NOT_PROBATIVE' | 'PROOF_FORM_NOT_APPLICABLE' | 'PROOF_FORM_NOT_PROBATIVE'
    | 'PROOF_FORM_UNDETERMINED' | 'OCCURRENCE_UNDATED' | 'OCCURRENCE_MISMATCH'
    | 'COMPLETION_PROVEN' | 'MODEL_NOT_COMPLETED' | 'MODEL_INSUFFICIENT' | 'MODEL_CONFLICTUAL'
    | 'MODEL_OCCURRENCE_MISMATCH' | 'MODEL_OCCURRENCE_AMBIGUOUS';
  reason: string;
  /** Le déterminisme n'a pas pu conclure : la branche VERIFY_COMPLETION est utile. */
  needsModel: boolean;
  /** Formes de preuve applicables (transmises au modèle). */
  applicableProofs?: DocumentCatalogEntry['completionProofs'];
}

const DAY = 86_400_000;

/** Période d'une récurrence, en jours. */
function periodDays(r: NonNullable<ExistingAgendaItem['recurrence']>): number {
  const i = Math.max(1, r.interval);
  return r.frequency === 'yearly' ? 365 * i : r.frequency === 'monthly' ? 30 * i : r.frequency === 'weekly' ? 7 * i : i;
}

/**
 * FENÊTRE D'OCCURRENCE (T4-14), documentée :
 *   · `exact`    : preuve à ±7 jours de l'occurrence ;
 *   · récurrente (période P) : `probable` si la preuve tombe dans
 *     [date − P/2, date + P/2[ — elle appartient à l'occurrence la plus
 *     proche, jamais à la précédente ni à la suivante (une facture 2025 ne
 *     clôt pas l'occurrence 2026) ;
 *   · non récurrente : `probable` de 90 jours avant l'échéance à n'importe
 *     quand après (réalisation anticipée ou en retard) ;
 *   · sinon `none` ; preuve non datée : `ambiguous`.
 */
export const OCCURRENCE_EXACT_DAYS = 7;
export const NON_RECURRING_EARLY_DAYS = 90;

export function matchOccurrence(
  itemDate: string, proofDate: Date | null | undefined, recurrence?: ExistingAgendaItem['recurrence'],
): OccurrenceMatch {
  if (!proofDate || Number.isNaN(proofDate.getTime())) return 'ambiguous';
  const due = Date.parse(`${itemDate}T00:00:00Z`);
  if (Number.isNaN(due)) return 'ambiguous';
  const diff = (Date.UTC(proofDate.getUTCFullYear(), proofDate.getUTCMonth(), proofDate.getUTCDate()) - due) / DAY;
  if (Math.abs(diff) <= OCCURRENCE_EXACT_DAYS) return 'exact';
  if (recurrence) {
    const half = periodDays(recurrence) / 2;
    return diff >= -half && diff < half ? 'probable' : 'none';
  }
  return diff >= -NON_RECURRING_EARLY_DAYS ? 'probable' : 'none';
}

/** Formes de preuve du type documentaire applicables au type métier de l'échéance. */
export function applicableProofs(
  entry: DocumentCatalogEntry, businessType: string | null | undefined,
): DocumentCatalogEntry['completionProofs'] {
  if (!businessType) return entry.completionProofs;
  return entry.completionProofs.filter((p) =>
    (p.businessTypes ?? entry.businessTypes).includes(businessType as never));
}

const keep = (
  status: CompletionStatus, reasonCode: CompletionDecision['reasonCode'], reason: string,
  extra: Partial<CompletionDecision> = {},
): CompletionDecision => ({ status, decision: 'keep', occurrenceMatch: 'none', reasonCode, reason, needsModel: false, ...extra });

/**
 * Décision DÉTERMINISTE à quatre états (T4-12), par type documentaire
 * (T4-13, `completionProofs` du DOCUMENT_CATALOG — plus de liste globale ni
 * de motifs littéraux) et par occurrence (T4-14). Une date passée n'est
 * jamais une preuve (U2).
 */
export function decideCompletion(item: ExistingAgendaItem, evidence: CompletionEvidence | null): CompletionDecision {
  if (item.status === 'realise' || item.status === 'done') {
    return keep('completed', 'ALREADY_DONE', 'déjà marqué réalisé');
  }
  const verdict = evaluate(item, evidence);
  // Un événement manuel n'est jamais modifié automatiquement (§4.4.4) : le
  // verdict est calculé, la décision reste `keep`.
  if (item.manual && verdict.decision !== 'keep') {
    return { ...verdict, decision: 'keep', reasonCode: 'MANUAL_ITEM_PROTECTED', reason: `événement manuel protégé (${verdict.reason})` };
  }
  return verdict;
}

function evaluate(item: ExistingAgendaItem, evidence: CompletionEvidence | null): CompletionDecision {
  if (!evidence) return keep('not_proven', 'NO_EVIDENCE', 'aucune preuve de réalisation (une date passée ne prouve rien)');
  const entry = resolveDocumentType(evidence.documentType);
  if (!entry) return keep('not_proven', 'DOCUMENT_TYPE_UNKNOWN', 'type documentaire inconnu du catalogue');
  const proofs = applicableProofs(entry, item.businessType);
  if (proofs.length === 0) {
    return keep('not_proven', 'DOCUMENT_TYPE_NOT_PROBATIVE', `${entry.code} n'établit pas la réalisation de ce type d'événement`);
  }

  if (evidence.proofCode) {
    const shape = proofs.find((p) => p.code === evidence.proofCode);
    if (!shape) return keep('not_proven', 'PROOF_FORM_NOT_APPLICABLE', `forme ${evidence.proofCode} non applicable à ${entry.code}`, { applicableProofs: proofs });
    if (shape.establishes !== 'completed') {
      return keep('not_proven', 'PROOF_FORM_NOT_PROBATIVE', `${shape.code} : ${shape.description}`, { applicableProofs: proofs });
    }
  } else {
    const completing = proofs.filter((p) => p.establishes === 'completed');
    if (completing.length === 0) {
      return keep('not_proven', 'PROOF_FORM_NOT_PROBATIVE', `${entry.code} ne prouve jamais une exécution`, { applicableProofs: proofs });
    }
    if (completing.length < proofs.length) {
      // Ex. FACTURE : acquittée (prouve) ou simple (ne prouve pas) — le type
      // seul ne tranche pas, seule la lecture de la preuve le peut.
      return keep('unknown', 'PROOF_FORM_UNDETERMINED', `forme de preuve à établir pour ${entry.code}`, { needsModel: true, applicableProofs: proofs });
    }
  }

  const match = matchOccurrence(item.date, evidence.occurrenceDate ?? evidence.documentDate, item.recurrence);
  if (match === 'ambiguous') {
    return keep('unknown', 'OCCURRENCE_UNDATED', 'preuve non datée : occurrence non vérifiable', { occurrenceMatch: match, needsModel: true, applicableProofs: proofs });
  }
  if (match === 'none') {
    return keep('not_proven', 'OCCURRENCE_MISMATCH', 'la preuve concerne une autre occurrence (hors fenêtre)', { occurrenceMatch: match, applicableProofs: proofs });
  }
  return {
    status: 'completed',
    decision: evidence.confidence === 'certain' ? 'mark_done' : 'propose_done',
    occurrenceMatch: match,
    reasonCode: 'COMPLETION_PROVEN',
    reason: `preuve de réalisation (${entry.code}) couvrant l'occurrence (${match}), confiance ${evidence.confidence}`,
    needsModel: false,
    applicableProofs: proofs,
  };
}
