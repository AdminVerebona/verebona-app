/**
 * COH-AGENDA-STRUCTURAL-HOUSING — pièces / équipements d'un élément d'agenda
 * sans LOGEMENT rattaché (lot 103D, ticket « Agenda — Pièces / Équipements
 * seulement pour un logement lié », remplace #611).
 *
 * Objet : l'élément d'agenda qui porte des liens pièce / équipement (directs),
 * ou qui est l'événement de référence d'un ensemble portant de tels liens.
 * Règle unique : `lib/agenda/housing-scope` (bien porteur = logement rattaché
 * à l'élément, ou à l'ensemble et à son événement de référence).
 *
 *   · inspection (lecture seule, sans IA) : liens incompatibles classés —
 *     CERTAIN : posé par un traitement automatique (élément automatique
 *     jamais modifié par l'utilisateur ; lien d'ensemble d'autorité
 *     DOCUMENT / INFERENCE / STRUCTURED) et dont le bien porteur n'est PAS
 *     rattaché du tout ; AMBIGU : lien de l'utilisateur (élément saisi ou
 *     modifié, lien d'ensemble d'autorité USER — correction manuelle
 *     préservée), ou bien porteur rattaché mais qui n'est plus un logement
 *     (changement de catégorie) ;
 *   · REPAIRABLE (`STRUCTURAL_LINK_WITHOUT_HOUSING`) : liens CERTAINS
 *     dissociés (liens seulement : pièces, équipements, biens et élément
 *     intacts), journal avant / après (`agenda_occurrence_events`
 *     STRUCTURAL_LINKS_DISSOCIATED ; historique de l'ensemble pour ses
 *     liens), relu au moment de réparer ;
 *   · FINDING (`STRUCTURAL_LINK_HOUSING_AMBIGUOUS`) : aucune écriture,
 *     signalé IMMÉDIATEMENT dans la Supervision (décision de l'utilisateur
 *     ou de l'exploitation).
 * Première exécution À BLANC : mode AUTO de la campagne (qualification du
 * contrôle avant toute correction), comme tout nouveau contrôle du registre.
 */
import { incompatibleStructuralLinks } from '@/lib/agenda/housing-scope';
import { postgresRunner, type GroupingRunner } from '@/services/business-operations/grouping/runner';
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

export const STRUCTURAL_HOUSING_CHECK_ID = 'COH-AGENDA-STRUCTURAL-HOUSING';
const ITEM_EVENTS = new Set(['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED']);

const PERIMETRE_SQL = `
  i.account_id = $1 AND (
    EXISTS (SELECT 1 FROM agenda_room_links r WHERE r.agenda_item_id = i.id)
    OR EXISTS (SELECT 1 FROM agenda_equipment_links e WHERE e.agenda_item_id = i.id)
    OR (i.operation_role = 'PRINCIPAL' AND i.business_operation_id IS NOT NULL AND (
      EXISTS (SELECT 1 FROM business_operation_room_links l WHERE l.operation_id = i.business_operation_id AND l.active)
      OR EXISTS (SELECT 1 FROM business_operation_equipment_links l WHERE l.operation_id = i.business_operation_id AND l.active))))`;

async function elements(ctx: CheckContext, accountId: number, extra: string, params: unknown[]): Promise<number[]> {
  return idsOf(await rows(ctx.sql, `SELECT i.id FROM agenda_items i WHERE ${PERIMETRE_SQL} ${extra} ORDER BY i.id`, [accountId, ...params]));
}

interface LinkVerdict { kind: 'ROOM' | 'EQUIPMENT'; scope: 'ITEM' | 'OPERATION'; id: number; assetId: number | null; certain: boolean; why: string }

export interface StructuralHousingDiagnosis {
  itemId: number;
  operationId: number | null;
  certain: LinkVerdict[];
  ambiguous: LinkVerdict[];
}

/** Diagnostic (lecture seule) d'un élément du compte ; null : hors périmètre ou disparu. */
export async function diagnoseStructuralHousing(r: GroupingRunner, accountId: number, itemId: number): Promise<StructuralHousingDiagnosis | null> {
  const { agendaItemAssetIds, housingAssetIdsOf, loadStructuralParents, operationScopeAssetIds } = await import('@/services/agenda/housing-scope.service');
  const { USER_TOUCH_EVENT_TYPES } = await import('@/services/agenda/historical-completion');
  const [i] = await r.q<{ id: number; is_automatic: boolean; is_automatic_modified: boolean; op: number | null; role: string | null; op_active: boolean | null; touched: boolean }>(
    `SELECT i.id, i.is_automatic, i.is_automatic_modified, i.business_operation_id AS op, i.operation_role AS role,
            (o.id IS NOT NULL AND o.account_id = i.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS op_active,
            EXISTS (SELECT 1 FROM agenda_occurrence_events e WHERE e.agenda_item_id = i.id AND e.event_type = ANY($3::text[])) AS touched
       FROM agenda_items i LEFT JOIN business_operations o ON o.id = i.business_operation_id
      WHERE i.id = $1 AND i.account_id = $2`, [itemId, accountId, [...USER_TOUCH_EVENT_TYPES]]);
  if (!i) return null;
  const out: StructuralHousingDiagnosis = { itemId, operationId: null, certain: [], ambiguous: [] };
  const push = (v: LinkVerdict) => (v.certain ? out.certain : out.ambiguous).push(v);

  // 1. Liens directs de l'élément.
  const roomIds = (await r.q<{ id: number }>(`SELECT substructure_id AS id FROM agenda_room_links WHERE agenda_item_id = $1 ORDER BY 1`, [itemId])).map((x) => Number(x.id));
  const equipIds = (await r.q<{ id: number }>(`SELECT equipment_id AS id FROM agenda_equipment_links WHERE agenda_item_id = $1 ORDER BY 1`, [itemId])).map((x) => Number(x.id));
  if (roomIds.length || equipIds.length) {
    const biens = await agendaItemAssetIds(r, accountId, itemId);
    const parents = await loadStructuralParents(r, accountId, roomIds, equipIds);
    const ko = incompatibleStructuralLinks(await housingAssetIdsOf(r, accountId, biens), parents.rooms, parents.equipments);
    const automatique = i.is_automatic === true && i.is_automatic_modified !== true && i.touched !== true;
    const classer = (kind: LinkVerdict['kind'], id: number, assetId: number | null) => {
      const rattache = assetId !== null && biens.includes(assetId);
      push({ kind, scope: 'ITEM', id, assetId, certain: automatique && !rattache,
        why: !automatique ? 'USER_ITEM' : rattache ? 'ASSET_NOT_HOUSING' : 'HOUSING_NOT_LINKED' });
    };
    for (const id of ko.roomIds) classer('ROOM', id, parents.rooms.find((x) => x.id === id)?.assetId ?? null);
    for (const id of ko.equipmentIds) classer('EQUIPMENT', id, parents.equipments.find((x) => x.id === id)?.assetId ?? null);
  }

  // 2. Liens de l'ensemble dont l'élément est l'événement de référence.
  if (i.role === 'PRINCIPAL' && i.op !== null && i.op_active === true) {
    const op = Number(i.op);
    out.operationId = op;
    const lr = await r.q<{ id: number; asset_id: number; authority: string | null }>(
      `SELECT s.id, s.asset_id, l.authority FROM business_operation_room_links l JOIN substructures s ON s.id = l.substructure_id
        WHERE l.operation_id = $1 AND l.account_id = $2 AND l.active ORDER BY s.id`, [op, accountId]);
    const le = await r.q<{ id: number; asset_id: number; authority: string | null }>(
      `SELECT e.id, e.asset_id, l.authority FROM business_operation_equipment_links l JOIN equipments e ON e.id = l.equipment_id
        WHERE l.operation_id = $1 AND l.active ORDER BY e.id`, [op]);
    if (lr.length || le.length) {
      const scope = await operationScopeAssetIds(r, accountId, op);
      const ko = incompatibleStructuralLinks(await housingAssetIdsOf(r, accountId, scope),
        lr.map((x) => ({ id: Number(x.id), assetId: Number(x.asset_id) })), le.map((x) => ({ id: Number(x.id), assetId: Number(x.asset_id) })));
      const classer = (kind: LinkVerdict['kind'], row: { id: number; asset_id: number; authority: string | null }) => {
        const rattache = scope.includes(Number(row.asset_id));
        const utilisateur = row.authority === 'USER';
        push({ kind, scope: 'OPERATION', id: Number(row.id), assetId: Number(row.asset_id), certain: !utilisateur && !rattache,
          why: utilisateur ? 'USER_LINK' : rattache ? 'ASSET_NOT_HOUSING' : 'HOUSING_NOT_LINKED' });
      };
      for (const row of lr) if (ko.roomIds.includes(Number(row.id))) classer('ROOM', row);
      for (const row of le) if (ko.equipmentIds.includes(Number(row.id))) classer('EQUIPMENT', row);
    }
  }
  return out;
}

const resume = (l: LinkVerdict[]) => l.map((v) => ({ kind: v.kind, scope: v.scope, id: v.id, assetId: v.assetId, why: v.why }));

export const agendaStructuralHousingCheck: CoherenceCheck = {
  id: STRUCTURAL_HOUSING_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : pièces et équipements associés seulement avec un logement rattaché',
  domain: 'agenda',
  level: 'N2',
  objectType: 'agenda_item',
  scope: 'éléments d’agenda portant des liens pièce / équipement, et événements de référence d’un ensemble portant de tels liens',
  sources: ['agenda_items', 'agenda_asset_links', 'agenda_room_links', 'agenda_equipment_links', 'business_operation_asset_links',
    'business_operation_room_links', 'business_operation_equipment_links', 'assets', 'substructures', 'equipments'],
  applicability: 'compte éligible',
  invariant: 'une pièce ou un équipement n’est associé à un élément d’agenda (ou à son ensemble) que si son bien porteur est un logement rattaché à cet élément (ou à l’ensemble et à son événement de référence)',
  anomalies: ['STRUCTURAL_LINK_WITHOUT_HOUSING', 'STRUCTURAL_LINK_HOUSING_AMBIGUOUS'],
  autoRepairWhen: 'lien posé par un traitement automatique (élément automatique jamais modifié, lien d’ensemble non USER) dont le bien porteur n’est pas rattaché du tout : dissociation du lien seul, journal avant / après',
  forbiddenRepairs: ['dissocier un lien posé ou corrigé par l’utilisateur', 'supprimer une pièce, un équipement, un bien ou un élément d’agenda',
    'rattacher implicitement un logement pour rendre un lien valide', 'toucher aux documents associés'],
  services: ['agenda/housing-scope.service#planStructuralLinks', 'business-operations/grouping/service#detachRoom', 'business-operations/grouping/service#detachEquipment'],
  chain: ['T3', 'T4', 'LINK'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'BUSINESS_OPERATION_CHANGED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque modification de l’élément, de son ensemble ou d’un bien',
  criticality: 'MEDIUM',
  tests: ['L103D-U-HOUSING-SCOPE', 'L103D-E2E-PIECES-LOGEMENT'],
  immediateSupervision: ['STRUCTURAL_LINK_HOUSING_AMBIGUOUS'],

  async listObjects(ctx, accountId, afterId, limit) {
    return (await elements(ctx, accountId, 'AND i.id > $2', [afterId])).slice(0, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (ITEM_EVENTS.has(e.type)) return elements(ctx, accountId, 'AND i.id = $2', [e.entityId]);
    if (e.type === 'BUSINESS_OPERATION_CHANGED') return elements(ctx, accountId, 'AND i.business_operation_id = $2', [e.entityId]);
    if (e.type === 'ASSET_UPDATED') {
      return elements(ctx, accountId, `AND (EXISTS (SELECT 1 FROM agenda_asset_links al WHERE al.agenda_item_id = i.id AND al.asset_id = $2)
        OR EXISTS (SELECT 1 FROM business_operation_asset_links ol WHERE ol.operation_id = i.business_operation_id AND ol.asset_id = $2 AND ol.active))`, [e.entityId]);
    }
    return [];
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivants = new Set(await elements(ctx, accountId, 'AND i.id = ANY($2::int[])', [intArray(ids)]));
    const r = postgresRunner(ctx.sql as never);
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = await diagnoseStructuralHousing(r, accountId, id);
      if (!d) { out.set(id, { verdict: 'GONE' }); continue; }
      if (!d.certain.length && !d.ambiguous.length) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      const detail = { operationId: d.operationId, certain: resume(d.certain), ambiguous: resume(d.ambiguous) };
      if (d.certain.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'STRUCTURAL_LINK_WITHOUT_HOUSING', faultyLink: 'LINK',
          expected: 'aucune pièce / aucun équipement hors des logements rattachés', observed: detail.certain, detail,
          inputHash: hashOf({ id, certain: detail.certain }),
        });
      } else {
        out.set(id, {
          verdict: 'FINDING', anomaly: 'STRUCTURAL_LINK_HOUSING_AMBIGUOUS', faultyLink: 'LINK', observed: detail.ambiguous, detail,
          inputHash: hashOf({ id, ambiguous: detail.ambiguous }),
        });
      }
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const r = postgresRunner(ctx.sql as never);
    for (const { id } of items) {
      // Constat RELU au moment de réparer (aucune décision sur un état périmé).
      const d = await diagnoseStructuralHousing(r, accountId, id);
      if (!d || !d.certain.length) { out.set(id, { called: false, service: 'dissociateStructuralLinks', result: { skipped: 'NOTHING_TO_REPAIR' } }); continue; }
      const direct = d.certain.filter((v) => v.scope === 'ITEM');
      const ensemble = d.certain.filter((v) => v.scope === 'OPERATION');
      const result: Record<string, unknown> = {};
      if (direct.length) {
        const rooms = direct.filter((v) => v.kind === 'ROOM').map((v) => v.id);
        const equips = direct.filter((v) => v.kind === 'EQUIPMENT').map((v) => v.id);
        // Gardé dans la requête : élément encore automatique et intact (une correction concurrente de l'utilisateur gagne).
        const removed = await ctx.sql.begin(async (tx) => {
          const garde = `EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2 AND i.is_automatic AND NOT i.is_automatic_modified)`;
          const rr = await tx.unsafe(`DELETE FROM agenda_room_links WHERE agenda_item_id = $1 AND substructure_id = ANY($3::int[]) AND ${garde} RETURNING substructure_id`,
            [id, accountId, rooms] as never[]);
          const re = await tx.unsafe(`DELETE FROM agenda_equipment_links WHERE agenda_item_id = $1 AND equipment_id = ANY($3::int[]) AND ${garde} RETURNING equipment_id`,
            [id, accountId, equips] as never[]);
          const roomIds = (rr as unknown as Array<{ substructure_id: number }>).map((x) => Number(x.substructure_id));
          const equipmentIds = (re as unknown as Array<{ equipment_id: number }>).map((x) => Number(x.equipment_id));
          if (roomIds.length || equipmentIds.length) {
            await tx.unsafe(`INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json)
                             VALUES ($1, $2, 'STRUCTURAL_LINKS_DISSOCIATED', $3::text::jsonb)`,
            [id, accountId, JSON.stringify({ origin: 'COHERENCE', reasonCode: 'STRUCTURAL_LINK_WITHOUT_HOUSING', correlationId: ctx.correlationId,
              before: { roomIds: rooms, equipmentIds: equips }, removed: { roomIds, equipmentIds } })] as never[]);
          }
          return { roomIds, equipmentIds };
        });
        result.item = removed;
      }
      if (ensemble.length && d.operationId !== null) {
        const op = d.operationId;
        const { withGroupingWrite, detachRoom, detachEquipment } = await import('@/services/business-operations/grouping/service');
        result.operation = await withGroupingWrite(accountId, async (g) => {
          const fait = { roomIds: [] as number[], equipmentIds: [] as number[] };
          for (const v of ensemble) {
            // Origine T3 : aucune décision « refusée » de l'utilisateur n'est inventée ; l'historique de l'ensemble porte avant / après.
            if (v.kind === 'ROOM' && await detachRoom(g, { operationId: op, substructureId: v.id, origin: 'T3', reasonCode: 'COH_STRUCTURAL_LINK_WITHOUT_HOUSING' })) fait.roomIds.push(v.id);
            if (v.kind === 'EQUIPMENT' && await detachEquipment(g, { operationId: op, equipmentId: v.id, origin: 'T3', reasonCode: 'COH_STRUCTURAL_LINK_WITHOUT_HOUSING' })) fait.equipmentIds.push(v.id);
          }
          return fait;
        }, { correlationId: ctx.correlationId });
      }
      out.set(id, {
        called: true, service: 'dissociateStructuralLinks', result: { ...result, before: resume(d.certain) },
        rollbackRef: `agenda_occurrence_events:event_type=STRUCTURAL_LINKS_DISSOCIATED;business_operation_history:reason_code=COH_STRUCTURAL_LINK_WITHOUT_HOUSING;correlation_id=${ctx.correlationId}`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
