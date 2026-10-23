/**
 * COH-ASSET-EQUIPMENT-SEPARATION — données d'un équipement attribuées à son
 * bien (et inversement) — lot 83B (C3 ; CDC cohérence §4.2 « la séparation
 * entre les informations du bien et celles de ses équipements doit être
 * strictement préservée » ; scénario 12 ; arbitrage C-Q2).
 *
 * Le rattrapage BO « Séparation bien / équipement » (lot 71A / 75G) n'était
 * lancé qu'à la main. Ce contrôle en fait une vérification PÉRIODIQUE, avec
 * le MÊME code (aucun second moteur) :
 *   · détection en lecture seule par les fonctions du rattrapage
 *     (`findEvidenceCases`, `findAgendaPurchaseCases`,
 *     `findOtherAttributeSuspects`) ;
 *   · cas à PROVENANCE DÉMONTRÉE (A, B, C du rattrapage) → réparation par
 *     `runDataSeparationBackfill` (application, bornée au bien, partie
 *     « documents » exclue : elle relève de COH-DOC-LINKS) — retrait de
 *     preuve tracé (`data_separation_corrections`), réconciliation T3 de la
 *     fiche, valeur saisie par l'utilisateur jamais modifiée ;
 *   · situations SUSPECTES (provenance insuffisante) → CONSTAT seul, jamais
 *     modifiées.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const BIENS_SQL = `a.account_id = $1 AND a.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM equipments e WHERE e.asset_id = a.id AND e.archived_at IS NULL)`;

export const equipmentSeparationCheck: CoherenceCheck = {
  id: 'COH-ASSET-EQUIPMENT-SEPARATION',
  version: 1,
  status: 'ACTIVE',
  title: 'Séparation bien / équipement : donnée d’un équipement attribuée au bien (provenance démontrée)',
  domain: 'equipements',
  level: 'N2',
  objectType: 'asset',
  scope: 'biens vivants du compte qui ont au moins un équipement actuel',
  sources: ['field_evidence', 'agenda_items', 'canonical_field_writes', 'equipments', 'assets'],
  applicability: 'compte éligible ; bien avec équipement(s)',
  invariant: 'aucune preuve ni valeur du bien n’est la recopie d’une donnée propre à un de ses équipements (et inversement)',
  anomalies: ['DATA_ATTRIBUTED_TO_WRONG_ENTITY', 'SEPARATION_SUSPECT'],
  autoRepairWhen: 'provenance DÉMONTRÉE par le rattrapage 75G (cas A, B, C) ; jamais pour un cas suspect',
  forbiddenRepairs: ['corriger une valeur sur une simple égalité de valeurs', 'modifier une valeur saisie par l’utilisateur', 'supprimer une preuve (retrait tracé seulement)', 'rattacher des documents (COH-DOC-LINKS)'],
  services: ['equipment/data-separation-backfill#findEvidenceCases', 'equipment/data-separation-backfill#runDataSeparationBackfill'],
  chain: ['T1', 'PERSISTENCE'],
  triggers: ['ASSET_UPDATED', 'SOURCE_ANALYZED', 'AGENDA_ITEM_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement du bien ou de ses documents',
  criticality: 'MEDIUM',
  tests: ['L83B-E2E-09', 'L71A-*'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE ${BIENS_SQL} AND a.id > $2 ORDER BY a.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    const ids = e.assetId != null ? [e.assetId] : [];
    if (e.entityId != null && e.type === 'ASSET_UPDATED') ids.push(e.entityId);
    if (e.entityId != null && e.type === 'SOURCE_ANALYZED') {
      ids.push(...idsOf(await rows(ctx.sql, `SELECT asset_id AS id FROM asset_files WHERE account_id = $1 AND id = $2 AND asset_id IS NOT NULL`, [accountId, e.entityId])));
    }
    if (e.entityId != null && e.type === 'AGENDA_ITEM_UPDATED') {
      ids.push(...idsOf(await rows(ctx.sql, `
        SELECT l.asset_id AS id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = $1 AND i.id = $2`, [accountId, e.entityId])));
    }
    if (!ids.length) return [];
    return idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE ${BIENS_SQL} AND a.id = ANY($2::int[]) ORDER BY a.id`, [accountId, intArray(ids)]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { findEvidenceCases, findAgendaPurchaseCases, findOtherAttributeSuspects } = await import('@/services/equipment/data-separation-backfill');
    const vivants = new Set(idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE ${BIENS_SQL} AND a.id = ANY($2::int[])`, [accountId, intArray(ids)])));
    const preuves = await findEvidenceCases(ctx.sql as never, accountId);
    const cas = [...preuves.cases, ...await findAgendaPurchaseCases(ctx.sql as never, accountId)];
    const suspects = [...preuves.suspects, ...await findOtherAttributeSuspects(ctx.sql as never, accountId)];
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const c = cas.filter((x) => x.assetId === id)
        .map((x) => ({ kind: x.kind, fieldKey: x.fieldKey, equipmentId: x.equipmentId, evidenceId: x.evidenceId, sourceFileId: x.sourceFileId, motive: x.motive }));
      const s = suspects.filter((x) => x.assetId === id)
        .map((x) => ({ kind: x.kind, fieldKey: x.fieldKey, equipmentId: x.equipmentId, evidenceId: x.evidenceId, sourceFileId: x.sourceFileId }));
      if (c.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'DATA_ATTRIBUTED_TO_WRONG_ENTITY', faultyLink: 'PERSISTENCE',
          expected: 'chaque donnée propre à l’équipement portée par l’équipement seul', observed: c.slice(0, 20),
          detail: { cases: c.length, suspects: s.length },
          inputHash: hashOf({ id, cas: c.map((x) => [x.kind, x.evidenceId, x.fieldKey, x.equipmentId]) }),
        });
      } else if (s.length) {
        out.set(id, {
          verdict: 'FINDING', anomaly: 'SEPARATION_SUSPECT', faultyLink: 'PERSISTENCE',
          expected: 'provenance démontrée avant toute correction', observed: s.slice(0, 20), detail: { suspects: s.length },
          inputHash: hashOf({ id, s: s.map((x) => [x.kind, x.evidenceId, x.fieldKey, x.equipmentId]) }),
        });
      } else {
        out.set(id, { verdict: 'CONSISTENT' });
      }
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { runDataSeparationBackfill } = await import('@/services/equipment/data-separation-backfill');
    for (const { id } of items) {
      const r = await runDataSeparationBackfill({
        apply: true, accountId, assetIds: [id], documents: false, sql: ctx.sql as never, reason: `contrôle de cohérence (${ctx.correlationId})`,
      });
      if (r.failed.length) throw new Error(r.failed.map((f) => f.error).join(' ; ').slice(0, 400));
      out.set(id, {
        called: true, service: 'runDataSeparationBackfill', aiCalls: 0,
        result: { runId: r.runId, cases: r.cases.length, fieldsCorrected: r.fieldsCorrected, preserved: r.preserved, resumed: r.resumed },
        rollbackRef: `data_separation_corrections:run_id=${r.runId}`,
      });
    }
    return out;
  },
};
