/**
 * COH-DOC-TARGETS — rattachements MULTIPLES d'un document cohérents avec la
 * source canonique (lot 111I, ticket « plusieurs biens, pièces et
 * équipements par document »). Reprise du stock : à blanc (DRY_RUN) puis
 * correctif, idempotente, comptes éligibles seulement (moteur 82B).
 *
 * Source canonique : `document_asset_links` (liens ACTIFS PRIMARY /
 * SECONDARY). Colonnes historiques `asset_id`, `linked_asset_id`,
 * `substructure_id`, `equipment_id` = principal dérivé, reflété par le
 * déclencheur 0221 en liens LEGACY_COLUMN.
 *
 * Constats sur CHAQUE document visible :
 *   REPAIRABLE  DOCUMENT_TARGET_COLUMN_NOT_LINKED — une colonne désigne une
 *               cible du compte sans lien ACTIF de cette cible (document
 *               antérieur au déclencheur ou rattrapage interrompu). Réparation
 *               DÉTERMINISTE : `document_asset_links_sync_file` (la fonction
 *               même du déclencheur ; ne touche ni USER, ni AI, ni MIGRATION).
 *   REPAIRABLE  DOCUMENT_TARGET_LINK_ASSET_STALE — lien d'équipement ou de
 *               pièce dont le bien n'est plus celui de l'équipement / de la
 *               pièce (déplacement dans le compte) : bien du lien réaligné
 *               (LEGACY_COLUMN : resynchronisation ; autre origine : mise à
 *               jour du bien, ou retrait du doublon si la cible est déjà liée).
 *   FINDING     DOCUMENT_TARGET_COLUMNS_INCOHERENT — pièce ou équipement
 *               principal (colonnes) porté par un autre bien que le bien
 *               principal : aucune correction certaine (laquelle des deux
 *               colonnes a raison ?) — constat pour le BO.
 * Jamais : supprimer un document ou un lien (DELETE), écraser une décision
 * USER, rattacher à une cible d'un autre compte, déplacer le bien principal.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { exec, hashOf, idsOf, intArray, rows } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';

interface Diag {
  missing: string[];
  stale: Array<{ linkId: number; origin: string; key: string; from: number | null; to: number }>;
  incoherent: string[];
}

/** Diagnostic en lecture seule d'un lot de documents du compte. */
export async function diagnoseDocumentTargets(sql: Parameters<typeof rows>[0], accountId: number, ids: readonly number[]): Promise<Map<number, Diag>> {
  const out = new Map<number, Diag>();
  for (const id of ids) out.set(id, { missing: [], stale: [], incoherent: [] });
  if (!ids.length) return out;
  // 1. Colonnes sans lien actif de la même cible (cibles du compte seulement, comme le déclencheur).
  for (const r of await rows(sql, `
    WITH c AS (
      SELECT f.id AS file_id, 'A' AS k, f.asset_id AS t, f.asset_id AS a, NULL::int AS s, NULL::int AS e
        FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND f.asset_id IS NOT NULL
      UNION ALL
      SELECT f.id, 'A', f.linked_asset_id, f.linked_asset_id, NULL, NULL
        FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND f.linked_asset_id IS NOT NULL
      UNION ALL
      SELECT f.id, 'S', f.substructure_id, s.asset_id, f.substructure_id, NULL
        FROM asset_files f JOIN substructures s ON s.id = f.substructure_id
       WHERE f.account_id = $1 AND f.id = ANY($2::int[])
      UNION ALL
      SELECT f.id, 'E', f.equipment_id, e.asset_id, NULL, f.equipment_id
        FROM asset_files f JOIN equipments e ON e.id = f.equipment_id
       WHERE f.account_id = $1 AND f.id = ANY($2::int[])
    )
    SELECT c.file_id, c.k, c.t FROM c
      JOIN assets a ON a.id = c.a AND a.account_id = $1
     WHERE NOT EXISTS (
       SELECT 1 FROM document_asset_links l
        WHERE l.file_id = c.file_id AND l.status = 'ACTIVE'
          AND COALESCE(l.asset_id, 0) = c.a AND COALESCE(l.substructure_id, 0) = COALESCE(c.s, 0)
          AND COALESCE(l.equipment_id, 0) = COALESCE(c.e, 0) AND l.room_id IS NULL)
       -- Intégration lot 111 : un lien que l'utilisateur a retiré (ou refusé) n'est jamais recréé par la
       -- reprise, même si l'ancienne colonne désigne encore la cible : son geste fait foi (C6, L83E-E2E-05).
       AND NOT EXISTS (
       SELECT 1 FROM document_asset_links l
        WHERE l.file_id = c.file_id AND l.status IN ('REMOVED', 'REJECTED')
          AND (CASE c.k WHEN 'E' THEN l.equipment_id = c.e WHEN 'S' THEN l.substructure_id = c.s AND l.equipment_id IS NULL
                        ELSE l.asset_id = c.a AND l.substructure_id IS NULL AND l.equipment_id IS NULL END))
     ORDER BY 1, 2, 3`, [accountId, intArray(ids)])) {
    out.get(Number(r.file_id))?.missing.push(`${r.k}:${r.t}`);
  }
  // 2. Liens d'équipement / de pièce au bien périmé (cible du compte).
  for (const r of await rows(sql, `
    SELECT l.id, l.file_id, l.origin, l.asset_id,
           CASE WHEN l.equipment_id IS NOT NULL THEN 'E:' || l.equipment_id ELSE 'S:' || l.substructure_id END AS k,
           COALESCE(e.asset_id, s.asset_id) AS cur
      FROM document_asset_links l
      LEFT JOIN equipments e ON e.id = l.equipment_id
      LEFT JOIN substructures s ON s.id = l.substructure_id AND l.equipment_id IS NULL
      JOIN assets a ON a.id = COALESCE(e.asset_id, s.asset_id) AND a.account_id = $1
     WHERE l.account_id = $1 AND l.file_id = ANY($2::int[]) AND l.status = 'ACTIVE'
       AND (l.equipment_id IS NOT NULL OR l.substructure_id IS NOT NULL)
       -- Intégration lot 111 : seul un bien RENSEIGNÉ et périmé est réaligné ; un lien d'équipement / de pièce
       -- sans bien (asset_id NULL) reste tel quel (le bien est déduit à la lecture, jamais écrit : L88B-E2E-03).
       AND l.asset_id IS NOT NULL AND l.asset_id <> COALESCE(e.asset_id, s.asset_id)
     ORDER BY l.id`, [accountId, intArray(ids)])) {
    out.get(Number(r.file_id))?.stale.push({
      linkId: Number(r.id), origin: String(r.origin), key: String(r.k), from: r.asset_id == null ? null : Number(r.asset_id), to: Number(r.cur),
    });
  }
  // 3. Triplet principal incohérent (constat).
  for (const r of await rows(sql, `
    SELECT f.id,
           (s.id IS NOT NULL AND s.asset_id IS DISTINCT FROM f.asset_id) AS piece,
           (e.id IS NOT NULL AND e.asset_id IS DISTINCT FROM f.asset_id) AS equip
      FROM asset_files f
      LEFT JOIN substructures s ON s.id = f.substructure_id
      LEFT JOIN equipments e ON e.id = f.equipment_id
     WHERE f.account_id = $1 AND f.id = ANY($2::int[])
       AND ((s.id IS NOT NULL AND s.asset_id IS DISTINCT FROM f.asset_id) OR (e.id IS NOT NULL AND e.asset_id IS DISTINCT FROM f.asset_id))`,
  [accountId, intArray(ids)])) {
    const d = out.get(Number(r.id));
    if (!d) continue;
    if (r.piece === true) d.incoherent.push('substructure_id');
    if (r.equip === true) d.incoherent.push('equipment_id');
  }
  return out;
}

export const documentTargetsCheck: CoherenceCheck = {
  id: 'COH-DOC-TARGETS',
  version: 1,
  status: 'ACTIVE',
  title: 'Documents : rattachements multiples (biens, pièces, équipements) reflétés par la source canonique',
  domain: 'documents',
  level: 'N1',
  objectType: 'document',
  scope: 'documents visibles du compte (non supprimés, non regroupés, dépôt terminé)',
  sources: ['asset_files', 'document_asset_links', 'equipments', 'substructures', 'assets'],
  applicability: 'compte éligible',
  invariant: 'chaque cible des colonnes historiques (principal) a un lien ACTIF ; un lien d’équipement ou de pièce porte le bien ACTUEL de sa cible ; le triplet principal (bien, pièce, équipement) est porté par un seul bien',
  anomalies: ['DOCUMENT_TARGET_COLUMN_NOT_LINKED', 'DOCUMENT_TARGET_LINK_ASSET_STALE', 'DOCUMENT_TARGET_COLUMNS_INCOHERENT'],
  autoRepairWhen: 'colonne sans lien (resynchronisation par la fonction du déclencheur 0221) ; bien périmé d’un lien d’équipement / de pièce (réaligné sur le bien actuel de la cible, même compte)',
  forbiddenRepairs: ['supprimer un document ou un lien', 'modifier ou retirer un lien USER hors réalignement du bien de sa propre cible',
    'rattacher à une cible d’un autre compte', 'changer le bien principal d’un document', 'corriger un triplet principal incohérent sans décision'],
  services: ['db#document_asset_links_sync_file', 'documents/document-targets#applyDocumentTargets'],
  chain: ['PERSISTENCE', 'LINK'],
  triggers: ['DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque modification de document',
  criticality: 'MEDIUM',
  tests: ['L111I-U-PLAN', 'L111I-E2E-REPRISE'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} ORDER BY f.id LIMIT $3`,
    [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = $2 AND ${OPEN_DOCUMENT_SQL}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivants = new Set(idsOf(await rows(ctx.sql, `SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`, [accountId, intArray(ids)])));
    const diags = await diagnoseDocumentTargets(ctx.sql, accountId, [...vivants]);
    for (const id of ids) {
      const d = diags.get(id);
      if (!vivants.has(id) || !d) { out.set(id, { verdict: 'GONE' }); continue; }
      if (d.missing.length || d.stale.length) {
        out.set(id, {
          verdict: 'REPAIRABLE',
          anomaly: d.missing.length ? 'DOCUMENT_TARGET_COLUMN_NOT_LINKED' : 'DOCUMENT_TARGET_LINK_ASSET_STALE',
          faultyLink: 'LINK',
          expected: { columnsLinked: true, linkAssetCurrent: true },
          observed: { missing: d.missing, stale: d.stale.map((s) => ({ link: s.linkId, key: s.key, from: s.from, to: s.to })) },
          detail: { incoherentColumns: d.incoherent },
          inputHash: hashOf({ id, d }),
        });
      } else if (d.incoherent.length) {
        out.set(id, {
          verdict: 'FINDING', anomaly: 'DOCUMENT_TARGET_COLUMNS_INCOHERENT', faultyLink: 'PERSISTENCE',
          observed: { columns: d.incoherent }, inputHash: hashOf({ id, inc: d.incoherent }),
        });
      } else out.set(id, { verdict: 'CONSISTENT' });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    for (const { id } of items) {
      // Diagnostic relu au moment de réparer (aucune décision sur un état périmé).
      const d = (await diagnoseDocumentTargets(ctx.sql, accountId, [id])).get(id);
      if (!d || (!d.missing.length && !d.stale.length)) {
        out.set(id, { called: false, service: 'document_asset_links_sync_file', result: { skipped: 'NOTHING_TO_REPAIR' } });
        continue;
      }
      let realigned = 0;
      let duplicatesRemoved = 0;
      let resync = d.missing.length > 0;
      for (const s of d.stale) {
        if (s.origin === 'LEGACY_COLUMN') { resync = true; continue; }
        const [col, val] = s.key.split(':');
        const doublon = await rows(ctx.sql, `
          SELECT 1 FROM document_asset_links WHERE file_id = $1 AND status = 'ACTIVE' AND id <> $2 AND COALESCE(asset_id, 0) = $3
             AND ${col === 'E' ? 'equipment_id = $4' : 'substructure_id = $4 AND equipment_id IS NULL'} LIMIT 1`, [id, s.linkId, s.to, Number(val)]);
        if (doublon.length) {
          await exec(ctx.sql, `UPDATE document_asset_links SET status = 'REMOVED', removed_at = now(), updated_at = now() WHERE id = $1 AND account_id = $2 AND status = 'ACTIVE'`, [s.linkId, accountId]);
          duplicatesRemoved++;
        } else {
          await exec(ctx.sql, `UPDATE document_asset_links SET asset_id = $3, updated_at = now() WHERE id = $1 AND account_id = $2 AND status = 'ACTIVE'`, [s.linkId, accountId, s.to]);
          realigned++;
        }
      }
      if (resync) await exec(ctx.sql, `SELECT document_asset_links_sync_file($1::int)`, [id]);
      out.set(id, {
        called: true, service: 'document_asset_links_sync_file',
        result: { resynchronized: resync, realigned, duplicatesRemoved, missing: d.missing.length },
        rollbackRef: `document_asset_links:file_id=${id};correlation_id=${ctx.correlationId}`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
