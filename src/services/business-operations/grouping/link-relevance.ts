/**
 * Pertinence d'une ASSOCIATION Document ↔ Agenda selon ses PREUVES (lot 86D —
 * ticket P1 « Documents / Agenda — associations erronées et gestion
 * bidirectionnelle », §3 à §6 ; CDC v5 §7.1, §7.3, §7.4, §10 ; arbitrages
 * C-Q2, C-Q6, C-Q11, V-Q5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CHAQUE PROVENANCE AUTOMATIQUE EST CONFRONTÉE À LA PREUVE QUI LA FONDE
 *
 * Un lien `agenda_file_links` cumule des provenances (82D). Seules les
 * provenances AUTOMATIQUES sont jugées ici ; MANUAL_DIRECT est une décision de
 * l'utilisateur, jamais retirée automatiquement (§5), quelle que soit sa
 * vraisemblance.
 *
 *   OPERATION_PRINCIPAL  fondée SEULEMENT si l'élément est l'événement de
 *                        référence d'un ensemble ACTIF du compte dont le
 *                        document est membre actif (non supprimé), sans refus
 *                        de propagation (§7.1) ;
 *   AI_DIRECT            fondée par une trace de PRODUCTION propre au couple
 *                        (`agenda_item_sources` : T4 ou moteur historique a
 *                        produit / prouvé l'élément à partir de CE document)
 *                        ou par l'origine de l'élément automatique
 *                        (`origin_ref` = ce document) ; à défaut, pour un
 *                        élément PROJETÉ d'un ensemble, par la règle de
 *                        projection (le document est membre de l'ensemble
 *                        projeté — 83A : une échéance garde les documents de
 *                        son ensemble) ;
 *   toute provenance     infondée si l'utilisateur a DÉTACHÉ ce lien
 *                        (AGENDA_FILE_LINK REJECTED, 0736).
 *
 * Verdict :
 *   CONSISTENT  aucune provenance automatique infondée ni non prouvée ;
 *   REPAIRABLE  au moins une provenance automatique DÉMONTRÉE infondée
 *               (preuve contraire déterministe) → retirée par le service de
 *               regroupement (`withdrawAutomaticLinkProvenances`), le lien
 *               disparaît s'il ne reste rien, la propagation est recalculée ;
 *   AMBIGUOUS   provenance AI_DIRECT sans preuve propre ni règle de
 *               projection (lien hérité de la reprise 0654, posé avant que les
 *               traces existent…) : absence de preuve ≠ preuve contraire —
 *               AUCUNE écriture ; le jugement de pertinence relève de l'IA
 *               (contrat demandé : `86D-t4-pertinence-lien-document-agenda`) ;
 *   FINDING     lien entre deux comptes : anomalie de SÉCURITÉ, traitée par
 *               le contrôle intercomptes existant — jamais par celui-ci.
 *
 * Jamais une preuve : le même bien, une date proche, un intitulé ressemblant
 * (ticket §3) — aucune règle lexicale ni chronologique ici. PUR : testable
 * sans base ; le chargement est dans le contrôle du registre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AutomaticProvenance } from './service';

/** Contrat IA demandé pour juger la pertinence sémantique d'un lien non prouvé (l86/demandes-ia). */
export const LINK_RELEVANCE_AI_CONTRACT = '86D-t4-pertinence-lien-document-agenda';

export interface LinkEvidenceSnapshot {
  linkId: number;
  itemId: number;
  fileId: number;
  provenances: readonly string[];
  itemAccountId: number;
  /** Compte du document (null : document introuvable). */
  fileAccountId: number | null;
  fileDeleted: boolean;
  /** Élément projeté depuis un ensemble (`projection_origin` posé). */
  itemProjected: boolean;
  /** Ensemble ACTIF du compte de l'élément, sinon null. */
  operationId: number | null;
  role: 'PRINCIPAL' | 'RELATED' | null;
  /** Le document est membre actif de l'ensemble de l'élément. */
  fileMember: boolean;
  /** Propagation de ce document vers l'événement de référence refusée (PRINCIPAL_LINK). */
  propagationRefused: boolean;
  /** Lien détaché par l'utilisateur (AGENDA_FILE_LINK REJECTED actif). */
  userDetached: boolean;
  /** Traces de production du couple (`<effet>:<rôle>`), vides si aucune. */
  productionTraces: readonly string[];
  /** L'élément automatique a ce document pour origine (`origin_ref`). */
  originRef: boolean;
}

export type ProvenanceBasis =
  | 'PRINCIPAL_OF_ENSEMBLE_WITH_MEMBER_DOCUMENT' | 'PRODUCTION_TRACE' | 'ITEM_ORIGIN' | 'PROJECTION_OF_ENSEMBLE_MEMBER';

export type UnjustifiedReason =
  | 'USER_DETACHED' | 'NOT_REFERENCE_EVENT' | 'NO_ACTIVE_ENSEMBLE' | 'DOCUMENT_NOT_MEMBER' | 'DOCUMENT_IN_TRASH'
  | 'PROPAGATION_REFUSED' | 'PROJECTION_DOCUMENT_LEFT_ENSEMBLE';

export interface LinkRelevance {
  verdict: 'CONSISTENT' | 'REPAIRABLE' | 'AMBIGUOUS' | 'FINDING';
  anomaly: 'AUTOMATIC_LINK_UNJUSTIFIED' | 'AUTOMATIC_LINK_UNPROVEN' | 'CROSS_ACCOUNT_LINK' | null;
  /** Provenances automatiques DÉMONTRÉES infondées (à retirer), avec leur motif. */
  unjustified: Array<{ provenance: AutomaticProvenance; reason: UnjustifiedReason }>;
  /** Provenances automatiques sans preuve propre (constat, aucune écriture). */
  unproven: AutomaticProvenance[];
  /** Preuve retenue pour chaque provenance fondée. */
  justified: Array<{ provenance: AutomaticProvenance | 'MANUAL_DIRECT'; basis: ProvenanceBasis | 'USER_DECISION' }>;
}

/** Évalue une association (pure, déterministe). */
export function evaluateLinkRelevance(s: LinkEvidenceSnapshot): LinkRelevance {
  const out: LinkRelevance = { verdict: 'CONSISTENT', anomaly: null, unjustified: [], unproven: [], justified: [] };
  if (s.fileAccountId !== null && s.fileAccountId !== s.itemAccountId) {
    return { ...out, verdict: 'FINDING', anomaly: 'CROSS_ACCOUNT_LINK' };
  }
  const prov = new Set(s.provenances);
  // Décision de l'utilisateur : jamais remise en cause par une inférence (§5).
  if (prov.has('MANUAL_DIRECT')) {
    out.justified.push({ provenance: 'MANUAL_DIRECT', basis: 'USER_DECISION' });
    return out;
  }
  const ensemble = s.operationId !== null;
  if (prov.has('OPERATION_PRINCIPAL')) {
    const reason: UnjustifiedReason | null = s.userDetached ? 'USER_DETACHED'
      : !ensemble ? 'NO_ACTIVE_ENSEMBLE'
        : s.role !== 'PRINCIPAL' ? 'NOT_REFERENCE_EVENT'
          : s.fileDeleted ? 'DOCUMENT_IN_TRASH'
            : !s.fileMember ? 'DOCUMENT_NOT_MEMBER'
              : s.propagationRefused ? 'PROPAGATION_REFUSED' : null;
    if (reason) out.unjustified.push({ provenance: 'OPERATION_PRINCIPAL', reason });
    else out.justified.push({ provenance: 'OPERATION_PRINCIPAL', basis: 'PRINCIPAL_OF_ENSEMBLE_WITH_MEMBER_DOCUMENT' });
  }
  if (prov.has('AI_DIRECT')) {
    if (s.userDetached) out.unjustified.push({ provenance: 'AI_DIRECT', reason: 'USER_DETACHED' });
    else if (s.productionTraces.length) out.justified.push({ provenance: 'AI_DIRECT', basis: 'PRODUCTION_TRACE' });
    else if (s.originRef) out.justified.push({ provenance: 'AI_DIRECT', basis: 'ITEM_ORIGIN' });
    else if (s.itemProjected) {
      // Seule justification possible : la règle de projection (documents de l'ensemble projeté).
      if (ensemble && s.fileMember && !s.fileDeleted) out.justified.push({ provenance: 'AI_DIRECT', basis: 'PROJECTION_OF_ENSEMBLE_MEMBER' });
      else out.unjustified.push({ provenance: 'AI_DIRECT', reason: 'PROJECTION_DOCUMENT_LEFT_ENSEMBLE' });
    } else {
      out.unproven.push('AI_DIRECT');
    }
  }
  if (out.unjustified.length) return { ...out, verdict: 'REPAIRABLE', anomaly: 'AUTOMATIC_LINK_UNJUSTIFIED' };
  if (out.unproven.length) return { ...out, verdict: 'AMBIGUOUS', anomaly: 'AUTOMATIC_LINK_UNPROVEN' };
  return out;
}
