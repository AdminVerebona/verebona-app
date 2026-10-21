/**
 * Réévaluation RÉELLE d'une carte LINK-ELT (document → équipement) — lot 54A
 * (écart 2), unifiée au lot 75G (ticket « Rapprochement documents–
 * équipements », écart C ; ticket « écarts résiduels 71A », point A).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MOTEUR : LE SERVICE COMMUN
 *
 * L'ancien Candidate Builder élément (nom dans le fournisseur, TYPE dans le
 * titre, similarité lexicale) et son écriture directe de
 * `asset_files.equipment_id` sont SUPPRIMÉS : ils contournaient les
 * protections du lot 71A (rattachement sur un type seul, liens N-N absents,
 * refus utilisateur ignorés). Le réexamen délègue désormais à
 * `syncDocumentEquipmentLinks` :
 *   · univers RECONSTRUIT depuis l'état courant (document, faits, unités
 *     source, faits non résolus, biens du document, TOUS leurs équipements
 *     actuels — y compris ceux créés après le document) ;
 *   · règles déterministes de `document-equipment-matching` ; T3
 *     (`reconcileLinks`, opération et prompt existants) seulement pour les
 *     groupes encore ambigus, avec la marge supplémentaire 54A conservée
 *     (`ELEMENT_REQUIRED_MARGIN`) ;
 *   · écritures du service (lien N-N + colonne historique compatible),
 *     équipements revérifiés (compte, bien, non archivé), refus et choix de
 *     l'utilisateur respectés, liens N-N existants et lien au bien conservés.
 *
 * FERMETURE : la carte n'est close qu'après VÉRIFICATION en base — un de ses
 * candidats est effectivement rattaché, ou le document porte un rattachement
 * et la question ne se pose plus (obsolescence confirmée) ; sinon ses
 * propositions sont actualisées (candidats reconstruits) et elle reste
 * ouverte. Décision utilisateur (équipement choisi ou retiré dans le tiroir)
 * : la carte est sans objet, rien n'est écrit.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { DocumentArbitrate } from '@/services/equipment/document-equipment-link.service';

export type ElementLinkStatus = 'APPLIED' | 'ALREADY_LINKED' | 'NO_ASSET' | 'TARGET_GONE' | 'NO_CANDIDATE' | 'AMBIGUOUS';

export interface ElementLinkResult {
  status: ElementLinkStatus;
  candidateCount: number;
  deterministicAttempted: boolean;
  aiCalled: boolean;
  equipmentId: number | null;
  method: string | null;
  /** Carte modifiée (nouvelles propositions) sans être fermée. */
  cardUpdated: boolean;
}

export interface ElementLinkDeps {
  /** Arbitrage T3 (défaut : `defaultDocumentArbitrate`, opération existante). */
  arbitrate?: DocumentArbitrate;
}

type Sql = typeof import('@/db').pgClient;
const pg = async (): Promise<Sql> => (await import('@/db')).pgClient;

/** Candidats enregistrés sur la carte (historique de la question posée) et état ouvert. */
async function lireCarte(sql: Sql, accountId: number, actionId: number): Promise<{ open: boolean; candidates: number[] } | null> {
  const [r] = (await sql.unsafe(
    `SELECT resolved_at IS NULL AS open, trigger_context FROM to_process_actions WHERE id = $1 AND account_id = $2`,
    [actionId, accountId] as never[],
  )) as unknown as Array<{ open: boolean; trigger_context: unknown }>;
  if (!r) return null;
  const ctx = (typeof r.trigger_context === 'string' ? JSON.parse(r.trigger_context) : r.trigger_context) as { candidates?: unknown } | null;
  const candidates = Array.isArray(ctx?.candidates) ? ctx!.candidates.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0) : [];
  return { open: r.open === true, candidates };
}

/**
 * Réévalue le rattachement document → équipement d'une carte LINK-ELT ouverte
 * depuis l'état COURANT, par le service commun.
 */
export async function resolveDocumentElementLink(p: {
  accountId: number; fileId: number; actionId: number;
  guard?: { assertActive(what: string): Promise<void> };
  deps?: ElementLinkDeps;
}): Promise<ElementLinkResult> {
  const sql = await pg();
  const res = (status: ElementLinkStatus, over: Partial<ElementLinkResult> = {}): ElementLinkResult => ({
    status, candidateCount: 0, deterministicAttempted: false, aiCalled: false, equipmentId: null, method: null, cardUpdated: false, ...over,
  });
  const svc = await import('@/services/equipment/document-equipment-link.service');
  const doc = await svc.loadDocumentProfile(p.accountId, p.fileId, sql);
  if (!doc) return res('TARGET_GONE');
  const carte = await lireCarte(sql, p.accountId, p.actionId);
  // Décision de l'utilisateur dans le tiroir, ou candidat déjà rattaché : la carte est sans objet (aucune écriture).
  if (doc.userChoseEquipment) return res('ALREADY_LINKED', { equipmentId: doc.equipmentId });
  const deja = (carte?.candidates ?? []).find((id) => doc.linkedEquipmentIds.has(id));
  if (deja !== undefined) return res('ALREADY_LINKED', { equipmentId: deja });
  if (doc.profile.assetIds.length === 0) return res('NO_ASSET');

  const r = await svc.syncDocumentEquipmentLinks({
    accountId: p.accountId, fileId: p.fileId, allowAi: true, proposeCard: true, guard: p.guard,
    requiredMargin: svc.ELEMENT_REQUIRED_MARGIN, ...(p.deps?.arbitrate ? { arbitrate: p.deps.arbitrate } : {}),
  });
  const base = {
    candidateCount: new Set([...r.linked, ...r.ambiguous]).size, deterministicAttempted: true, aiCalled: r.aiCalled,
  };
  const apres = await lireCarte(sql, p.accountId, p.actionId);
  if (apres && !apres.open && r.cardsClosed.includes(p.actionId)) {
    const relu = await svc.loadDocumentProfile(p.accountId, p.fileId, sql);
    const lie = (carte?.candidates ?? []).find((id) => relu?.linkedEquipmentIds.has(id)) ?? r.linked[0] ?? [...(relu?.linkedEquipmentIds ?? [])][0] ?? null;
    console.info(`[t3-open-actions] LINK-ELT document ${p.fileId} → équipement ${lie} (${r.methods.join(', ')}) — carte ${p.actionId} close après vérification.`);
    return res('APPLIED', { ...base, equipmentId: lie, method: r.methods.includes('T3') ? 'AI' : r.methods[0] ?? null });
  }
  if (r.status === 'NO_EQUIPMENT' || base.candidateCount === 0) return res('NO_CANDIDATE', base);
  return res('AMBIGUOUS', { ...base, cardUpdated: r.cardProposed });
}
