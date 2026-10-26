/**
 * Lot 84E — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-6
 * (§9.3, §9.4, §9.5, §25.1, §25.4, §27.6 ; AC45–AC50 ; E27–E29 ;
 * arbitrages PO V-Q5, C-Q2, C-Q10, C-Q11) : RECONSOLIDATION CIBLÉE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN NOUVEAU MOTEUR
 *
 * Ces fonctions SÉLECTIONNENT un sous-ensemble pertinent (prestataire,
 * références de service, bien, Pièce, équipement) puis réutilisent les
 * chaînes existantes :
 *   · marque de réexamen 55B (`requestTargetedRetroReconciliation`,
 *     état porté par le candidat, reprise sans perte) puis consolidation T3
 *     d'UN document (`consolidateDocument` : M0 → M3, identité de série
 *     `recurrence.ts`, contrôle d'identité économique 78A, décisions
 *     utilisateur, fusion existante, composantes : une facture = un coût) ;
 *   · rattachement d'un équipement par le service unique de regroupement
 *     (`attachEquipment`, 82D : un refus de l'utilisateur n'est jamais défait) ;
 *   · liens directs Document ↔ Équipement par le service commun
 *     (`recomputeDirectLinks` → `syncDocumentEquipmentLinks`, garde
 *     anti-cartésienne 82D).
 * Aucun appel IA ici, sauf l'arbitrage EXISTANT d'une ambiguïté résiduelle
 * entre équipements (si l'appelant l'autorise), borné par le plafond M3 par
 * passage (inchangé). Un rapprochement seulement plausible attend la phase M3
 * du passage T3 suivant (plafonds 5 / passage, 30 / jour, coût mensuel).
 *
 *   reconsolidateRecurringDocuments  série d'un prestataire / service / bien
 *   reconsolidateForEquipment        équipement créé, renommé, déplacé, dont
 *                                    un identifiant change (file durable
 *                                    `equipment_documents`, même événement
 *                                    que `entity_updated`)
 *   reconsolidateForAsset            bien modifié (file T3 Opérations,
 *                                    `asset_updated`)
 *   reconsolidateForRoom             Pièce créée (file T3 Opérations,
 *                                    `asset_updated` + Pièce)
 *   recomputeDirectLinks             arrivée d'un document dans une Opération
 *                                    liée à un équipement (passage T3) ;
 *                                    réparation de COH-DOC-LINKS
 *
 * Journal (§27.6) : `business_operation_targeted_runs` (une ligne par
 * exécution réelle ; jamais pour une simulation). Compte non éligible
 * (C-Q10) : aucune sélection, aucune écriture, statut SKIPPED journalisé.
 * Idempotence : une seconde exécution sur un état à jour n'écrit rien
 * (consolidation, liens) — seule la trace d'exécution est ajoutée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type { DocumentArbitrate } from '@/services/equipment/document-equipment-link.service';
import { recomputeDirectLinks, t1EquipmentFacts, type DirectLinksResult } from './direct-links';
import { requestTargetedRetroReconciliation, type TargetedRetroSelector } from './retro';

type Sql = typeof import('@/db').pgClient;
type Row = Record<string, unknown>;

type TargetedKind = 'EQUIPMENT' | 'ASSET' | 'ROOM' | 'RECURRING_DOCUMENTS' | 'DIRECT_LINKS';

/** Opérations candidates examinées pour un équipement / un bien (borne de lecture). */
const TARGETED_OPERATION_LIMIT = 200;

interface TargetedOptions {
  /** Déclencheur (trace) : `equipment_created`, `asset_updated`, `coherence`, `document_arrival`… */
  trigger: string;
  correlationId?: string | null;
  today?: string;
  /** Simulation : sélection et liens calculés, aucune écriture, aucune IA, aucun journal. */
  dryRun?: boolean;
  /** Arbitrage IA existant d'une ambiguïté résiduelle entre équipements (défaut : non). */
  allowAi?: boolean;
  aiBudget?: { remaining: number };
  arbitrate?: DocumentArbitrate;
  beforeWrite?: (what: string) => Promise<void>;
  /** Interne : exécution imbriquée (pas de ligne de journal propre). */
  nested?: boolean;
  sql?: Sql;
}

interface TargetedReport {
  kind: TargetedKind;
  accountId: number;
  targetId: number | null;
  skipped?: 'ACCOUNT_INELIGIBLE' | 'TARGET_GONE';
  /** Documents récurrents remis en consolidation (ou qui le seraient). */
  marked: number[];
  consolidated: number;
  changes: number;
  /** Opérations touchées (consolidation, rattachement, liens). */
  operations: number[];
  /** Rattachements équipement ↔ Opération posés (certains). */
  equipmentAttached: number;
  directLinks: { examined: number; created: number; proposed: number; unproven: number[]; ambiguous: number[]; rejected: number };
  aiCalls: number;
  errors: string[];
}

const vide = (kind: TargetedKind, accountId: number, targetId: number | null): TargetedReport => ({
  kind, accountId, targetId, marked: [], consolidated: 0, changes: 0, operations: [], equipmentAttached: 0,
  directLinks: { examined: 0, created: 0, proposed: 0, unproven: [], ambiguous: [], rejected: 0 }, aiCalls: 0, errors: [],
});

const pgOf = async (o: TargetedOptions): Promise<Sql> => o.sql ?? (await import('@/db')).pgClient;
const ids = (r: Row[], k = 'id') => r.map((x) => Number(x[k])).filter((n) => Number.isSafeInteger(n) && n > 0);
const uniq = (v: number[]) => [...new Set(v)].sort((a, b) => a - b);

async function eligible(accountId: number): Promise<boolean> {
  const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
  return isAccountProcessingEligible(accountId);
}

/** Trace d'une exécution réelle (§27.6). Ne lève jamais (la trace ne bloque pas le métier). */
async function journal(r: TargetedReport, o: TargetedOptions, startedAt: Date, status: 'DONE' | 'SKIPPED' | 'FAILED'): Promise<void> {
  if (o.dryRun || o.nested) return;
  // Passage T3 sans Opération liée à un équipement : rien d'examiné, aucune trace (pas de bruit à chaque passage).
  if (r.kind === 'DIRECT_LINKS' && status === 'DONE' && r.directLinks.examined === 0 && !r.errors.length) return;
  try {
    const pg = await pgOf(o);
    await pg.unsafe(
      `INSERT INTO business_operation_targeted_runs
         (account_id, kind, target_id, trigger, correlation_id, status, skipped_reason, dry_run, counts, operation_ids, ai_calls, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8::jsonb, $9::bigint[], $10, $11, $12, now())`,
      [r.accountId, r.kind, r.targetId, o.trigger.slice(0, 80), o.correlationId ?? null, status, r.skipped ?? null,
        JSON.stringify({ marked: r.marked.length, consolidated: r.consolidated, changes: r.changes, equipmentAttached: r.equipmentAttached,
          directLinks: { ...r.directLinks, unproven: r.directLinks.unproven.length, ambiguous: r.directLinks.ambiguous.length } }),
        `{${uniq(r.operations).join(',')}}`, r.aiCalls, r.errors.length ? r.errors.join(' ; ').slice(0, 500) : null, startedAt.toISOString()] as never[],
    );
  } catch (e) {
    console.error(`[t3-operations] journal de reconsolidation ciblée (compte ${r.accountId}) :`, (e as Error).message);
  }
}

function absorber(r: TargetedReport, x: TargetedReport): void {
  r.marked = uniq([...r.marked, ...x.marked]);
  r.consolidated += x.consolidated;
  r.changes += x.changes;
  r.operations = uniq([...r.operations, ...x.operations]);
  r.equipmentAttached += x.equipmentAttached;
  absorberLiens(r, x.directLinks);
  r.aiCalls += x.aiCalls;
  r.errors.push(...x.errors);
}
function absorberLiens(r: TargetedReport, d: TargetedReport['directLinks'] | DirectLinksResult): void {
  r.directLinks.examined += d.examined;
  r.directLinks.created += d.created;
  r.directLinks.proposed += typeof d.proposed === 'number' ? d.proposed : d.proposed.length;
  r.directLinks.unproven = uniq([...r.directLinks.unproven, ...d.unproven]);
  r.directLinks.ambiguous = uniq([...r.directLinks.ambiguous, ...d.ambiguous]);
  r.directLinks.rejected += typeof d.rejected === 'number' ? d.rejected : d.rejected.length;
}

async function executer(kind: TargetedKind, accountId: number, targetId: number | null, o: TargetedOptions,
  corps: (r: TargetedReport, o: TargetedOptions) => Promise<void>): Promise<TargetedReport> {
  const r = vide(kind, accountId, targetId);
  const debut = new Date();
  const opts = { ...o, correlationId: o.correlationId ?? `o6:${kind.toLowerCase()}:${randomUUID()}` };
  if (!(await eligible(accountId))) {
    r.skipped = 'ACCOUNT_INELIGIBLE';
    await journal(r, opts, debut, 'SKIPPED');
    return r;
  }
  try {
    await corps(r, opts);
  } catch (e) {
    r.errors.push((e as Error).message.slice(0, 300));
    await journal(r, opts, debut, 'FAILED');
    throw e;
  }
  await journal(r, opts, debut, r.skipped ? 'SKIPPED' : 'DONE');
  return r;
}

// ── Liens directs des Opérations ────────────────────────────────────────────

/** Liens directs de plusieurs Opérations (seules celles liées à un équipement sont examinées). */
async function liensDesOperations(r: TargetedReport, accountId: number, operationIds: readonly number[], o: TargetedOptions): Promise<void> {
  if (!operationIds.length) return;
  const pg = await pgOf(o);
  const avecEquipement = ids((await pg.unsafe(
    `SELECT DISTINCT el.operation_id AS id FROM business_operation_equipment_links el
       JOIN business_operations x ON x.id = el.operation_id AND x.account_id = el.account_id AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL
      WHERE el.account_id = $1 AND el.active AND el.operation_id = ANY($2::bigint[]) ORDER BY 1`,
    [accountId, `{${uniq([...operationIds]).join(',')}}`] as never[],
  )) as unknown as Row[]);
  const budget = o.aiBudget ?? { remaining: (await import('./m3')).operationMatchCallsPerPass() };
  for (const opId of avecEquipement) {
    await o.beforeWrite?.('liens directs Document ↔ Équipement');
    const d = await recomputeDirectLinks(accountId, opId, { dryRun: o.dryRun, allowAi: o.allowAi && !o.dryRun, aiBudget: budget, arbitrate: o.arbitrate, sql: pg });
    absorberLiens(r, d);
    r.aiCalls += d.aiCalls;
    if (d.created > 0) r.operations = uniq([...r.operations, opId]);
  }
}

/**
 * Liens directs Document ↔ Équipement des Opérations désignées (arrivée d'un
 * document dans une Opération liée à un équipement, réparation de cohérence).
 */
export function recomputeDirectLinksForOperations(accountId: number, operationIds: readonly number[], o: TargetedOptions): Promise<TargetedReport> {
  return executer('DIRECT_LINKS', accountId, operationIds.length === 1 ? operationIds[0] : null, o, async (r, opts) => {
    await liensDesOperations(r, accountId, operationIds, opts);
  });
}

// ── Série de documents récurrents ───────────────────────────────────────────

/**
 * Documents récurrents d'un prestataire, d'un service (références de
 * contrat / compte client), d'un bien ou d'Opérations désignées : remis en
 * consolidation T3 un par un (série établie → fragments réunis ; services
 * distincts jamais ; montants contradictoires refusés par 78A ; décisions
 * utilisateur respectées), puis liens directs des Opérations touchées.
 */
export function reconsolidateRecurringDocuments(accountId: number, selector: TargetedRetroSelector, o: TargetedOptions): Promise<TargetedReport> {
  return executer('RECURRING_DOCUMENTS', accountId, selector.operationIds?.length === 1 ? selector.operationIds[0] : null, o, async (r, opts) => {
    await serie(r, accountId, selector, opts);
  });
}

async function serie(r: TargetedReport, accountId: number, selector: TargetedRetroSelector, o: TargetedOptions): Promise<void> {
  const marques = await requestTargetedRetroReconciliation(accountId, selector, { dryRun: o.dryRun, by: `O6:${o.trigger}`.slice(0, 60) });
  r.marked = uniq([...r.marked, ...marques]);
  if (o.dryRun || !marques.length) return;
  const { consolidateDocument } = await import('./consolidator');
  const touchees: number[] = [];
  for (const fileId of marques) {
    await o.beforeWrite?.('reconsolidation ciblée d’un document récurrent');
    const c = await consolidateDocument(accountId, fileId, { today: o.today, correlationId: o.correlationId ?? undefined });
    r.consolidated++;
    r.changes += c.changes;
    if (c.error) r.errors.push(`document ${fileId} : ${c.error}`);
    touchees.push(...c.operations);
  }
  // Opérations actives à l'issue (une absorbée est remplacée par sa canonique).
  const pg = await pgOf(o);
  const actives = ids((await pg.unsafe(
    `SELECT DISTINCT COALESCE(m.id, x.id) AS id FROM business_operations x
       LEFT JOIN business_operations m ON m.id = x.merged_into_operation_id AND m.account_id = x.account_id
      WHERE x.account_id = $1 AND x.id = ANY($2::bigint[])`,
    [accountId, `{${uniq(touchees).join(',')}}`] as never[],
  )) as unknown as Row[]);
  r.operations = uniq([...r.operations, ...actives]);
  await liensDesOperations(r, accountId, actives, o);
}

// ── Équipement ──────────────────────────────────────────────────────────────

/**
 * Équipement créé ou modifié (§9.3, §9.5, AC47–AC49) :
 *   1. séries récurrentes du bien de l'équipement réunies (fragments) ;
 *   2. Opérations du bien dont un document membre DÉSIGNE l'équipement avec
 *      certitude (preuve propre au document) → équipement rattaché à
 *      l'Opération (service de regroupement ; refus utilisateur respecté) ;
 *   3. chaque document membre des Opérations liées à l'équipement réévalué
 *      individuellement (liens directs certains seulement, AC50).
 */
export function reconsolidateForEquipment(accountId: number, equipmentId: number, o: TargetedOptions): Promise<TargetedReport> {
  return executer('EQUIPMENT', accountId, equipmentId, o, async (r, opts) => {
    const pg = await pgOf(opts);
    const [e] = (await pg.unsafe(
      `SELECT e.id, e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE e.id = $2 AND e.archived_at IS NULL`,
      [accountId, equipmentId] as never[],
    )) as unknown as Row[];
    if (!e) { r.skipped = 'TARGET_GONE'; return; }
    const assetId = Number(e.asset_id);
    const candidates = await operationsOfAsset(pg, accountId, assetId);
    // 1. Séries récurrentes concernées (fragments réunis avant l'examen de l'équipement).
    if (candidates.length) await serie(r, accountId, { operationIds: candidates, assetIds: [assetId] }, opts);
    // 2. Rattachement certain de l'équipement aux Opérations (preuve d'un document membre).
    const apres = opts.dryRun ? candidates : await operationsOfAsset(pg, accountId, assetId);
    const liees = ids((await pg.unsafe(
      `SELECT operation_id AS id FROM business_operation_equipment_links WHERE account_id = $1 AND equipment_id = $2 AND active`,
      [accountId, equipmentId] as never[],
    )) as unknown as Row[]);
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    for (const opId of apres.filter((x) => !liees.includes(x))) {
      const membres = ids((await pg.unsafe(
        `SELECT d.file_id AS id FROM business_operation_documents d JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
          WHERE d.operation_id = $1 AND d.account_id = $2 AND d.active ORDER BY 1 LIMIT 500`,
        [opId, accountId] as never[],
      )) as unknown as Row[]);
      let preuve: number | null = null;
      for (const fileId of membres) {
        const d = await syncDocumentEquipmentLinks({
          accountId, fileId, extraFacts: await t1EquipmentFacts(accountId, fileId, pg), restrictTo: new Set([equipmentId]),
          allowAi: false, proposeCard: false, dryRun: true, sql: pg,
        });
        if (d.linked.includes(equipmentId)) { preuve = fileId; break; }
      }
      if (preuve === null) continue;
      if (opts.dryRun) { r.equipmentAttached++; r.operations = uniq([...r.operations, opId]); continue; }
      await opts.beforeWrite?.('rattachement d’un équipement à une Opération');
      const { attachEquipment, withGroupingWrite } = await import('../grouping/service');
      const res = await withGroupingWrite(accountId, (g) => attachEquipment(g, {
        operationId: opId, equipmentId, origin: 'T3', sourceId: null, reasonCode: 'O6_EQUIPMENT_FROM_MEMBER_DOCUMENT',
      }), { correlationId: opts.correlationId ?? undefined });
      if (res.changed) { r.equipmentAttached++; r.changes++; liees.push(opId); }
      r.operations = uniq([...r.operations, opId]);
    }
    // 3. Liens directs des Opérations liées à l'équipement (chaque document, preuve propre).
    await liensDesOperations(r, accountId, uniq(liees), opts);
  });
}

/** Opérations actives liées au bien (lien de bien, ou document membre rattaché au bien), bornées. */
async function operationsOfAsset(pg: Sql, accountId: number, assetId: number): Promise<number[]> {
  return ids((await pg.unsafe(
    `SELECT o.id FROM business_operations o
      WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        AND (EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = $2)
             OR EXISTS (SELECT 1 FROM business_operation_documents d JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id
                         WHERE d.operation_id = o.id AND d.active AND f.deleted_at IS NULL AND (f.asset_id = $2 OR f.linked_asset_id = $2)))
      ORDER BY o.id DESC LIMIT ${TARGETED_OPERATION_LIMIT}`,
    [accountId, assetId] as never[],
  )) as unknown as Row[]);
}

// ── Bien et Pièce ───────────────────────────────────────────────────────────

/** Bien modifié : séries récurrentes de ses Opérations réexaminées, puis leurs liens directs. */
export function reconsolidateForAsset(accountId: number, assetId: number, o: TargetedOptions): Promise<TargetedReport> {
  return executer('ASSET', accountId, assetId, o, async (r, opts) => {
    const pg = await pgOf(opts);
    const [a] = (await pg.unsafe(`SELECT id FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [assetId, accountId] as never[])) as unknown as Row[];
    if (!a) { r.skipped = 'TARGET_GONE'; return; }
    await serie(r, accountId, { assetIds: [assetId] }, opts);
  });
}

/**
 * Pièce créée ou modifiée : Opérations dont une source désigne cette Pièce
 * (cible T1 certaine) ou qui y sont déjà liées, recalculées depuis leurs
 * sources (Pièces de l'Opération, `syncOperationRoomsFromT3`) ; séries du
 * bien porteur réexaminées.
 */
export function reconsolidateForRoom(accountId: number, roomId: number, o: TargetedOptions): Promise<TargetedReport> {
  return executer('ROOM', accountId, roomId, o, async (r, opts) => {
    const pg = await pgOf(opts);
    const [p] = (await pg.unsafe(
      `SELECT s.id, s.asset_id FROM substructures s JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL WHERE s.id = $2`,
      [accountId, roomId] as never[],
    )) as unknown as Row[];
    if (!p) { r.skipped = 'TARGET_GONE'; return; }
    const ops = ids((await pg.unsafe(
      `SELECT DISTINCT s.operation_id AS id FROM business_operation_sources s
         JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         JOIN document_operation_candidates c ON c.account_id = s.account_id AND c.status = 'ACTIVE'
          AND c.file_id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END) AND c.candidate_key = s.locator->>'candidateKey'
        WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'targetHints') = 'array' THEN c.payload->'targetHints' ELSE '[]'::jsonb END) t
                       WHERE t->>'type' = 'ROOM' AND t->>'entityId' = $2::text)
       UNION
       SELECT operation_id FROM business_operation_room_links WHERE account_id = $1 AND substructure_id = $2::int AND active
       ORDER BY 1 LIMIT ${TARGETED_OPERATION_LIMIT}`,
      [accountId, String(roomId)] as never[],
    )) as unknown as Row[]);
    if (ops.length && !opts.dryRun) {
      await opts.beforeWrite?.('reconsolidation des Opérations d’une Pièce');
      const { reconsolidateOperations } = await import('./consolidator');
      r.changes += await reconsolidateOperations(accountId, ops, { today: opts.today, correlationId: opts.correlationId ?? undefined });
    }
    r.operations = uniq([...r.operations, ...ops]);
    await serie(r, accountId, { assetIds: [Number(p.asset_id)] }, opts);
  });
}

export { absorber as mergeTargetedReports };
