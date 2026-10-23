/**
 * COH-DOC-LINKS — rattachements document ↔ bien ↔ équipement (lot 82B,
 * CDC §4.2, arbitrages C-Q2, C-Q9).
 *
 * Deux constats sur CHAQUE document du compte :
 *   · association document → équipement CERTAINE absente : réparée par le
 *     service commun `syncDocumentEquipmentLinks` (identifiants exacts, mêmes
 *     règles que l'analyse, sans IA ni carte : `allowAi: false`,
 *     `proposeCard: false`) — un choix de l'utilisateur n'est jamais
 *     contredit (le service le protège) ; l'ambiguïté reste à l'arbitrage
 *     existant (carte LINK-ELT de la chaîne d'analyse), jamais tranchée ici ;
 *   · document encore rattaché à un bien SUPPRIMÉ (suppression logique) :
 *     CONSTAT seulement. L'ancienne maintenance horaire le détachait sans
 *     trace (`asset_id = NULL`, retiré au lot 82B) ; ce détachement n'est
 *     pas une correction certaine (le document peut devoir suivre le bien
 *     retiré plutôt que réapparaître « sans bien »).
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const OPEN_DOCUMENT_SQL = `f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED'`;

async function documentsLiesABienSupprime(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, number[]>> {
  const r = await rows(ctx.sql, `
    SELECT f.id, array_agg(DISTINCT a.id ORDER BY a.id) AS assets
      FROM asset_files f
      JOIN assets a ON a.account_id = f.account_id AND a.deleted_at IS NOT NULL
       AND (a.id = f.asset_id OR a.id = f.linked_asset_id
            OR a.id IN (SELECT l.asset_id FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE'))
     WHERE f.account_id = $1 AND f.id = ANY($2::int[])
     GROUP BY f.id`, [accountId, intArray(ids)]);
  return new Map(r.map((x) => [Number(x.id), (x.assets as number[]).map(Number)]));
}

export const documentLinksCheck: CoherenceCheck = {
  id: 'COH-DOC-LINKS',
  version: 1,
  status: 'ACTIVE',
  title: 'Rattachements document ↔ bien ↔ équipement',
  domain: 'documents-liens',
  level: 'N2',
  objectType: 'document',
  scope: 'tous les documents visibles du compte (non supprimés, non regroupés, dépôt terminé)',
  sources: ['asset_files', 'document_asset_links', 'document_facts', 'document_unresolved_facts', 'document_source_units', 'equipments', 'equipment_cil_specs'],
  applicability: 'compte éligible (actif et modifiable) ; document rattaché à au moins un bien vivant pour la partie équipement',
  invariant: 'un équipement désigné avec certitude par le document (identifiant exact) lui est rattaché ; aucun document n’est rattaché à un bien supprimé',
  anomalies: ['CERTAIN_EQUIPMENT_LINK_MISSING', 'LINKED_TO_DELETED_ASSET'],
  autoRepairWhen: 'rattachement certain calculé par le service commun (même décision qu’à l’analyse), sans arbitrage ni IA',
  forbiddenRepairs: ['trancher une ambiguïté entre équipements', 'contredire un choix de l’utilisateur', 'détacher un document d’un bien supprimé', 'appeler T3 ou créer une carte'],
  services: ['equipment/document-equipment-link.service#syncDocumentEquipmentLinks'],
  chain: ['T1', 'LINK'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'MEDIUM',
  tests: ['L82B-U-LINKS', 'L82B-E2E-02', 'L82B-E2E-04', 'L82B-E2E-05'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} ORDER BY f.id LIMIT $3`,
    [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'ASSET_UPDATED') {
      // Dépendance : un équipement du bien créé, renommé ou dont l'identifiant change.
      return idsOf(await rows(ctx.sql, `
        SELECT DISTINCT f.id FROM asset_files f
         WHERE f.account_id = $1 AND ${OPEN_DOCUMENT_SQL}
           AND (f.asset_id = $2 OR f.linked_asset_id = $2
                OR f.id IN (SELECT l.file_id FROM document_asset_links l WHERE l.account_id = $1 AND l.asset_id = $2 AND l.status = 'ACTIVE'))
         ORDER BY f.id`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = $2`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const supprimes = await documentsLiesABienSupprime(ctx, accountId, ids);
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    for (const fileId of ids) {
      const morts = supprimes.get(fileId);
      if (morts?.length) {
        out.set(fileId, {
          verdict: 'FINDING', anomaly: 'LINKED_TO_DELETED_ASSET', faultyLink: 'LINK',
          expected: 'aucun rattachement à un bien supprimé', observed: { deletedAssetIds: morts },
          inputHash: hashOf({ fileId, morts }),
        });
        continue;
      }
      const r = await syncDocumentEquipmentLinks({ accountId, fileId, dryRun: true, allowAi: false, proposeCard: false, sql: ctx.sql });
      if (r.status === 'NOT_FOUND') { out.set(fileId, { verdict: 'GONE' }); continue; }
      const detail = { status: r.status, linked: r.linked, ambiguous: r.ambiguous, methods: r.methods };
      if (r.created > 0) {
        out.set(fileId, {
          verdict: 'REPAIRABLE', anomaly: 'CERTAIN_EQUIPMENT_LINK_MISSING', faultyLink: 'LINK',
          expected: { equipmentIds: r.linked }, observed: { missing: r.created }, detail,
          inputHash: hashOf({ fileId, linked: [...r.linked].sort(), ambiguous: r.ambiguous }),
        });
      } else if (r.status === 'AMBIGUOUS') {
        out.set(fileId, { verdict: 'AMBIGUOUS', anomaly: 'EQUIPMENT_AMBIGUITY', faultyLink: 'LINK', detail, inputHash: hashOf({ fileId, ambiguous: r.ambiguous }) });
      } else {
        out.set(fileId, { verdict: 'CONSISTENT', detail });
      }
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    for (const { id } of items) {
      const r = await syncDocumentEquipmentLinks({ accountId, fileId: id, allowAi: false, proposeCard: false, sql: ctx.sql });
      out.set(id, {
        called: true, service: 'syncDocumentEquipmentLinks', aiCalls: r.aiCalled ? 1 : 0,
        result: { status: r.status, linked: r.linked, created: r.created, columnSet: r.columnSet, cardsClosed: r.cardsClosed },
        // Retour arrière : liens N-N d'origine AI posés sur ce document (statut REMOVED), colonne `equipment_id` si posée.
        rollbackRef: `document_asset_links:file=${id}:origin=AI`,
      });
    }
    return out;
  },
};
