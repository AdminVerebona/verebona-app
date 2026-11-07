/**
 * Lot 113V (#719, post-MEP) — « Aucun » sur une carte « À quel bien rattacher
 * ce document ? » (règle LINK-ASSET) : NON-RATTACHEMENT EXPLICITE.
 *
 * Module PUR (aucun import) : partagé par la carte (client), la résolution,
 * T1 / T3 et le pont documentaire.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE « AUCUN » VEUT DIRE
 *
 * « Aucun des biens actuellement proposés ». Ce n'est ni « document à
 * ignorer », ni « à supprimer », ni « jamais rattachable » : le document
 * reste consultable, recherchable, extrait, classé, exploité par T1 / T3, et
 * visible dans les documents « Sans bien ». Aucune autre relation n'est
 * touchée (équipement, pièce, bien seulement cité).
 *
 * TROIS ÉTATS DISTINCTS, SANS NOUVEAU STATUT DOCUMENTAIRE VISIBLE
 *
 *   · non encore examiné       aucune issue T3 (`document_asset_resolutions`
 *                              absente, PENDING) ;
 *   · rattachement indéterminé issue OUVERTE de T3 (ABSTAINED, NO_CANDIDATE,
 *                              MULTI_ASSET) ;
 *   · non-rattachement choisi  carte LINK-ASSET close « Non applicable »
 *                              avec le choix `NO_ASSET` (trace
 *                              `to_process_action_events` : candidats, biens
 *                              présentés, révision du document, auteur, date)
 *                              ET issue T3 `USER_DECIDED` / `USER_NO_ASSET`.
 *
 * La SOURCE DE VÉRITÉ est la trace de la carte (`EXPLICIT_NO_ASSET_SQL`) :
 * elle prime tant que l'utilisateur n'a pas choisi un bien depuis (colonne
 * de rattachement, lien USER vers un bien, ou nouvelle réponse sur une carte).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Valeur envoyée par la carte pour « Aucun » (jamais un identifiant de bien). */
export const NO_ASSET_CHOICE = 'NONE' as const;
/** Libellé du bouton (repris du ticket #719). */
export const NO_ASSET_CHOICE_LABEL = 'Aucun';
/** Marque de la trace de décision (`to_process_action_events.details.choice`). */
export const NO_ASSET_EVENT_CHOICE = 'NO_ASSET' as const;
/** Motif de l'issue T3 (`document_asset_resolutions.reason_code`, statut USER_DECIDED). */
export const NO_ASSET_REASON_CODE = 'USER_NO_ASSET' as const;

/** La valeur reçue est-elle le choix « Aucun » ? (pure) */
export function isNoAssetChoice(v: unknown): v is typeof NO_ASSET_CHOICE {
  return v === NO_ASSET_CHOICE;
}

/**
 * Condition SQL (alias du document, `asset_files`) : un non-rattachement
 * explicite de l'utilisateur est EN VIGUEUR pour ce document.
 *
 *   1. une carte LINK-ASSET close « Non applicable » porte la trace du choix
 *      `NO_ASSET` (seul « Aucun » ferme ainsi une carte LINK-ASSET : la règle
 *      refuse le « Non applicable » générique) ;
 *   2. aucune réponse de l'utilisateur sur une carte de rattachement depuis
 *      (choix d'un bien, nouvelle complétion) — une fermeture par le système
 *      (OBSOLETE) ne l'efface pas ;
 *   3. aucun rattachement choisi depuis : ni colonne de rattachement, ni lien
 *      USER ACTIF vers un BIEN (un lien d'équipement ou de pièce ne compte
 *      pas : il n'est pas touché par « Aucun »).
 */
export function explicitNoAssetSql(f = 'f'): string {
  return `(${f}.asset_id IS NULL AND ${f}.linked_asset_id IS NULL
    AND EXISTS (
      SELECT 1 FROM to_process_actions na
        JOIN to_process_action_events ne ON ne.action_id = na.id AND ne.account_id = na.account_id
             AND ne.event = 'NOT_APPLICABLE' AND ne.details ->> 'choice' = '${NO_ASSET_EVENT_CHOICE}'
       WHERE na.account_id = ${f}.account_id AND na.target_type = 'DOCUMENT' AND na.target_id = ${f}.id
         AND na.rule_code = 'LINK-ASSET' AND na.resolution_reason = 'NOT_APPLICABLE' AND na.resolved_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM to_process_actions nb
            WHERE nb.account_id = na.account_id AND nb.target_type = 'DOCUMENT' AND nb.target_id = na.target_id
              AND COALESCE(nb.field_key, nb.relation_key) = 'assetIds'
              AND nb.resolution_reason IN ('USER_ARBITRATED', 'USER_COMPLETED') AND nb.resolved_at > na.resolved_at))
    AND NOT EXISTS (
      SELECT 1 FROM document_asset_links nl
       WHERE nl.file_id = ${f}.id AND nl.account_id = ${f}.account_id AND nl.status = 'ACTIVE' AND nl.origin = 'USER'
         AND nl.asset_id IS NOT NULL AND nl.equipment_id IS NULL AND nl.substructure_id IS NULL AND nl.room_id IS NULL))`;
}

/** Décision « Aucun » en vigueur, telle que tracée au moment du choix. */
export interface ExplicitNoAssetDecision {
  /** Carte close par le choix (preuve de clôture). */
  actionId: number;
  decidedAt: string;
  userId: number | null;
  /** Candidats de l'analyse présentés sur la carte. */
  candidateAssetIds: number[];
  /** TOUS les biens présentés (candidats + biens éligibles du compte, lot 113A). */
  offeredAssetIds: number[];
  /** Révision de la connaissance du DOCUMENT au moment du choix (null : illisible). */
  knowledgeRev: string | null;
}

/** Lecture défensive des détails de la trace (pure). */
export function parseNoAssetDecision(row: {
  action_id: unknown; decided_at: unknown; user_id: unknown; details: unknown;
} | null | undefined): ExplicitNoAssetDecision | null {
  if (!row) return null;
  const actionId = Number(row.action_id);
  if (!Number.isSafeInteger(actionId) || actionId <= 0) return null;
  const d = (typeof row.details === 'string' ? safeJson(row.details) : row.details) as Record<string, unknown> | null;
  if (!d || d.choice !== NO_ASSET_EVENT_CHOICE) return null;
  const ids = (v: unknown) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  const at = row.decided_at instanceof Date ? row.decided_at.toISOString() : row.decided_at ? new Date(String(row.decided_at)).toISOString() : new Date(0).toISOString();
  return {
    actionId, decidedAt: at, userId: row.user_id == null ? null : Number(row.user_id),
    candidateAssetIds: [...new Set(ids(d.candidateAssetIds))], offeredAssetIds: [...new Set(ids(d.offeredAssetIds))],
    knowledgeRev: typeof d.knowledgeRev === 'string' ? d.knowledgeRev : null,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Éléments RÉELLEMENT nouveaux depuis « Aucun » (pure) — seuls motifs d'un
 * réexamen soumis à l'utilisateur ; jamais un rattachement automatique.
 *
 *   · NEW_ASSET    bien éligible désigné (candidat, preuve déterministe) qui
 *                  n'existait pas / n'était pas présenté au moment du choix ;
 *   · NEW_EVIDENCE bien déjà présenté (refusé), désigné par une preuve
 *                  DÉTERMINISTE, alors que le contenu du document a changé
 *                  depuis le choix (nouvelle analyse). Un simple candidat d'un
 *                  bien refusé, ou la même preuve, ne suffit jamais.
 */
export function noAssetNewElements(p: {
  offeredAssetIds: readonly number[];
  /** Biens désignés par une preuve déterministe (identifiant, identité, référence partagée). */
  provenAssetIds: readonly number[];
  /** Candidats reconstruits (indices). */
  candidateAssetIds: readonly number[];
  /** Biens pouvant recevoir le document (non supprimés, ni archivés ni verrouillés). */
  eligibleAssetIds: readonly number[];
  documentChanged: boolean;
}): { newAssetIds: number[]; newEvidenceAssetIds: number[]; proposalIds: number[] } {
  const presentes = new Set(p.offeredAssetIds);
  const eligibles = new Set(p.eligibleAssetIds);
  const uniques = (xs: readonly number[]) => [...new Set(xs)].filter((id) => eligibles.has(id));
  const newAssetIds = uniques([...p.provenAssetIds, ...p.candidateAssetIds]).filter((id) => !presentes.has(id));
  const newEvidenceAssetIds = p.documentChanged ? uniques(p.provenAssetIds).filter((id) => presentes.has(id)) : [];
  const ordre = uniques([...p.provenAssetIds, ...p.candidateAssetIds]);
  const retenus = new Set([...newAssetIds, ...newEvidenceAssetIds]);
  return { newAssetIds, newEvidenceAssetIds, proposalIds: ordre.filter((id) => retenus.has(id)) };
}

/**
 * Question d'un réexamen (pure) : elle NOMME l'élément nouveau. Textes à
 * valider par le PO (recette 113V, §5).
 */
export function noAssetReexaminationQuestion(p: { newAssetLabels: readonly string[]; newEvidence: boolean }): string {
  if (p.newAssetLabels.length === 1 && !p.newEvidence) {
    return `Vous avez ajouté « ${p.newAssetLabels[0]} » depuis votre choix « Aucun » : à quel bien rattacher ce document ?`;
  }
  if (p.newAssetLabels.length > 1 && !p.newEvidence) {
    return 'De nouveaux biens ont été ajoutés depuis votre choix « Aucun » : à quel bien rattacher ce document ?';
  }
  return 'Ce document contient de nouveaux éléments depuis votre choix « Aucun » : à quel bien le rattacher ?';
}
