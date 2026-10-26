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
 *
 * Lot 83B (C3, CDC §4.2 « documents d'équipement rattachés uniquement au
 * bien ») — version 2 :
 *   · la réparation reste réservée à la provenance DÉMONTRÉE par le
 *     document lui-même (identifiant exact, cible T1 certaine : service
 *     commun) ;
 *   · document membre d'une Opération active liée à un ou plusieurs
 *     équipements, mais rattaché au seul bien (aucun lien direct à un
 *     équipement, aucun refus de l'utilisateur) : CONSTAT
 *     `EQUIPMENT_ASSOCIATION_UNPROVEN` — l'appartenance commune à une
 *     Opération n'est JAMAIS une preuve (P19, garde anti-cartésienne 82D) ;
 *     la décision document par document relève de T3 (demande IA
 *     `82D-t3-document-equipement`). Aucune écriture.
 *
 * Lot 84E (CDC v5 O-6, C-Q11) — version 3 : la reconsolidation ciblée O-6
 * devient la réparation de PREMIER RANG de ce constat. Le document est
 * réévalué vers les équipements de son Opération par `recomputeDirectLinks`
 * (M04 étendu au contrat T1 actuel de CE document : cible ÉQUIPEMENT
 * vérifiée, désignation brute d'un équipement créé après l'analyse — garde
 * anti-cartésienne 82D) :
 *   · preuve propre au document → REPAIRABLE, réparé par
 *     `recomputeDirectLinksForOperations` (aucune IA depuis le contrôle) ;
 *   · aucune preuve → CONSTAT inchangé (contrat IA 82D en attente).
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

/** Document visible (non supprimé, non regroupé, dépôt terminé) — partagé par les contrôles documentaires. */
export const OPEN_DOCUMENT_SQL = `f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED'`;

/** Demande de contrat IA dont dépend la relation document ↔ équipement non démontrée par le document. */
const DOCUMENT_EQUIPMENT_CONTRACT = '82D-t3-document-equipement';

/**
 * Documents rattachés au seul bien alors que leur Opération est liée à des
 * équipements (lecture seule) : équipements de l'Opération non refusés par
 * l'utilisateur pour ce document.
 */
async function associationsNonDemontrees(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, { operations: number[]; equipments: number[] }>> {
  const r = await rows(ctx.sql, `
    SELECT d.file_id, array_agg(DISTINCT d.operation_id::int ORDER BY d.operation_id::int) AS ops,
           array_agg(DISTINCT el.equipment_id ORDER BY el.equipment_id) AS equips
      FROM business_operation_documents d
      JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id
       AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
      JOIN business_operation_equipment_links el ON el.operation_id = d.operation_id AND el.active
      JOIN equipments e ON e.id = el.equipment_id AND e.archived_at IS NULL
     WHERE d.account_id = $1 AND d.active AND d.file_id = ANY($2::int[])
       AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = d.account_id AND l.file_id = d.file_id AND l.status = 'ACTIVE' AND l.equipment_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.id = d.file_id AND f.equipment_id IS NOT NULL)
     GROUP BY d.file_id`, [accountId, intArray(ids)]);
  const out = new Map<number, { operations: number[]; equipments: number[] }>();
  if (!r.length) return out;
  const { userRefusedEquipments } = await import('@/services/equipment/document-equipment-link.service');
  for (const x of r) {
    const fileId = Number(x.file_id);
    const refuses = await userRefusedEquipments(accountId, fileId, ctx.sql);
    const equipments = ((x.equips as number[]) ?? []).map(Number).filter((e) => !refuses.has(e));
    if (equipments.length) out.set(fileId, { operations: ((x.ops as number[]) ?? []).map(Number), equipments });
  }
  return out;
}

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
  version: 3,
  status: 'ACTIVE',
  title: 'Rattachements document ↔ bien ↔ équipement',
  domain: 'documents-liens',
  level: 'N2',
  objectType: 'document',
  scope: 'tous les documents visibles du compte (non supprimés, non regroupés, dépôt terminé)',
  sources: ['asset_files', 'document_asset_links', 'document_facts', 'document_unresolved_facts', 'document_source_units', 'equipments', 'equipment_cil_specs',
    'business_operation_documents', 'business_operation_equipment_links'],
  applicability: 'compte éligible (actif et modifiable) ; document rattaché à au moins un bien vivant pour la partie équipement',
  invariant: 'un équipement désigné avec certitude par le document (identifiant exact) lui est rattaché ; aucun document n’est rattaché à un bien supprimé ; un document d’équipement n’est pas laissé au seul bien sans que l’écart soit tracé',
  anomalies: ['CERTAIN_EQUIPMENT_LINK_MISSING', 'LINKED_TO_DELETED_ASSET', 'EQUIPMENT_AMBIGUITY', 'EQUIPMENT_ASSOCIATION_UNPROVEN'],
  autoRepairWhen: 'rattachement certain calculé par le service commun (même décision qu’à l’analyse), sans arbitrage ni IA ; lot 84E : document d’une Opération liée à un équipement qu’il désigne lui-même (reconsolidation ciblée O-6)',
  forbiddenRepairs: ['trancher une ambiguïté entre équipements', 'contredire un choix de l’utilisateur', 'détacher un document d’un bien supprimé', 'appeler T3 ou créer une carte',
    'lier un document aux équipements de son Opération par simple appartenance (P19)'],
  services: ['equipment/document-equipment-link.service#syncDocumentEquipmentLinks', 'business-operations/consolidation/targeted#recomputeDirectLinksForOperations'],
  chain: ['T1', 'LINK'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'MEDIUM',
  tests: ['L82B-U-LINKS', 'L82B-E2E-02', 'L82B-E2E-04', 'L82B-E2E-05', 'L83B-E2E-08', 'L84E-E2E-08'],

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
    const nonDemontrees = await associationsNonDemontrees(ctx, accountId, ids);
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
      } else if (nonDemontrees.has(fileId)) {
        // Lot 83B : appartenance à une Opération liée à des équipements — jamais une preuve ; constat tracé.
        const a = nonDemontrees.get(fileId)!;
        // Lot 84E : le document désigne-t-il LUI-MÊME un équipement de son Opération ? (simulation, sans IA)
        const { recomputeDirectLinks } = await import('@/services/business-operations/consolidation/direct-links');
        const proposes: Array<{ operationId: number; equipmentId: number; method: string }> = [];
        for (const opId of a.operations) {
          const d = await recomputeDirectLinks(accountId, opId, { dryRun: true, fileIds: [fileId], sql: ctx.sql });
          proposes.push(...d.proposed.filter((x) => x.fileId === fileId && a.equipments.includes(x.equipmentId)).map((x) => ({ operationId: opId, equipmentId: x.equipmentId, method: x.method })));
        }
        if (proposes.length) {
          out.set(fileId, {
            verdict: 'REPAIRABLE', anomaly: 'EQUIPMENT_ASSOCIATION_UNPROVEN', faultyLink: 'T3',
            expected: { equipmentIds: [...new Set(proposes.map((x) => x.equipmentId))].sort((x, y) => x - y) },
            observed: { operationIds: a.operations, equipmentIds: a.equipments },
            detail: { ...detail, repairChain: 'recomputeDirectLinks (O-6)', evidence: proposes },
            inputHash: hashOf({ fileId, unproven: a, proposes }),
          });
          continue;
        }
        out.set(fileId, {
          verdict: 'FINDING', anomaly: 'EQUIPMENT_ASSOCIATION_UNPROVEN', faultyLink: 'T3',
          expected: 'relation document ↔ équipement décidée pour CE document (preuve propre)', observed: { operationIds: a.operations, equipmentIds: a.equipments },
          detail: { ...detail, pendingContract: DOCUMENT_EQUIPMENT_CONTRACT },
          inputHash: hashOf({ fileId, unproven: a }),
        });
      } else {
        out.set(fileId, { verdict: 'CONSISTENT', detail });
      }
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    for (const { id, inspection } of items) {
      if (inspection.anomaly === 'EQUIPMENT_ASSOCIATION_UNPROVEN') {
        // Lot 84E : reconsolidation ciblée O-6 (liens directs des documents de l'Opération), sans IA.
        const { recomputeDirectLinksForOperations } = await import('@/services/business-operations/consolidation/targeted');
        const ops = ((inspection.observed as { operationIds?: number[] } | undefined)?.operationIds ?? []).map(Number);
        const r = await recomputeDirectLinksForOperations(accountId, ops, { trigger: 'coherence', correlationId: ctx.correlationId, sql: ctx.sql });
        out.set(id, {
          called: true, service: 'recomputeDirectLinksForOperations', aiCalls: r.aiCalls,
          result: { operations: ops, created: r.directLinks.created, unproven: r.directLinks.unproven.length, skipped: r.skipped ?? null },
          rollbackRef: `document_asset_links:file=${id}:origin=AI`,
        });
        continue;
      }
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
