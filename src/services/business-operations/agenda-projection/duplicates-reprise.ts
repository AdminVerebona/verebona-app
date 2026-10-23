/**
 * Lot 76H — rattrapage PONCTUEL du stock de doublons d'interventions dans
 * l'Agenda (ticket « [P1] Opérations → Agenda — Corriger les doublons
 * d'interventions », §4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN MOTEUR PARALLÈLE : LA PROJECTION EST REJOUÉE SUR LES OPÉRATIONS VISÉES
 *
 *   DÉTECTION (lecture seule, bornée par comptes, curseur stable)
 *     · Opération d'intervention active dont un événement automatique T4
 *       (entretien / réparation, ±3 jours) d'un de ses documents sources
 *       n'est pas lié à elle (T4 non rattaché, doublon T4 ↔ projection) ;
 *     · Opération liée à plusieurs événements ;
 *     · événements restés liés à une Opération fusionnée (résidus de fusion) ;
 *     · groupes T4 « même document, même date » SANS Opération active
 *       d'intervention : SIGNALÉS seulement (aucune Opération artificielle,
 *       aucune fusion — T3 n'a rien établi).
 *   PLAN puis APPLICATION, par compte : la projection (`projectAccountOperations`)
 *     calcule d'abord le plan en SIMULATION (rapport des actions envisagées),
 *     puis — mode APPLY — l'applique : consolidation certaine (journal 0591,
 *     restaurable), abstention + carte « À traiter » si l'identité est
 *     incertaine, interventions distinctes conservées, éléments touchés par
 *     l'utilisateur protégés (gardes SQL).
 *   RESTAURATION : par identifiant d'exécution (journal 0591, ordre inverse).
 *
 * Rejoué, il ne fait rien de plus (la projection est idempotente ; une
 * consolidation restaurée n'est jamais rejouée). Exécutions tracées
 * (`agenda_intervention_reprise_runs`) : compteurs, curseur, rapport borné.
 *
 * Lot 82B : la détection (`detectOperations`) et la projection sont aussi
 * celles du contrôle de cohérence COH-AGENDA-OCCURRENCES (quotidien, ciblé) ;
 * l'ancienne exécution AUTO au démarrage est retirée (une seule chaîne).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { pgClient } from '@/db';
import { consolidationJournalReady, restoreAgendaConsolidations } from './consolidation';
import type { PlannedOperation, ProjectionRunResult } from './service';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

export type RepriseMode = 'SIMULATE' | 'APPLY';
export const REPRISE_ACCOUNTS_PER_CALL = 200;
const REPORT_MAX = 500;

export interface RepriseOptions {
  mode: RepriseMode;
  origin: 'AUTO' | 'BO';
  accountId?: number | null;
  reason?: string | null;
  adminUserId?: number | null;
  /** Reprise d'une exécution interrompue (même identifiant, même curseur). */
  resumeRunId?: string | null;
  /** Comptes examinés au plus par appel (borne). */
  maxAccounts?: number;
  /** Instant (ms) au-delà duquel l'appel rend la main (reprise au suivant). */
  deadline?: number;
  log?: (m: string) => void;
  sql?: Sql;
}

export interface RepriseCounters {
  accounts: number;
  operations: number;
  certain: number;
  consolidated: number;
  linked: number;
  retitled: number;
  arbitration: number;
  protectedItems: number;
  projectionsCreated: number;
  residualsAfterMerge: number;
  noOperationGroups: number;
  errors: number;
}

export interface RepriseReportEntry {
  accountId: number;
  operationId?: number;
  category: 'CERTAIN_CONSOLIDATION' | 'LINK' | 'RETITLE' | 'ARBITRATION' | 'DISTINCT_OR_UNCHANGED' | 'NO_OPERATION' | 'PROTECTED' | 'ERROR';
  detail: Record<string, unknown>;
}

export interface RepriseResult {
  runId: string;
  mode: RepriseMode;
  status: 'succeeded' | 'running' | 'failed';
  /** Il reste des comptes à examiner (appel borné). */
  more: boolean;
  cursor: number;
  counters: RepriseCounters;
  report: RepriseReportEntry[];
}

const zero = (): RepriseCounters => ({
  accounts: 0, operations: 0, certain: 0, consolidated: 0, linked: 0, retitled: 0, arbitration: 0, protectedItems: 0,
  projectionsCreated: 0, residualsAfterMerge: 0, noOperationGroups: 0, errors: 0,
});

// ── Détection (lecture seule) ───────────────────────────────────────────────

/** Comptes à examiner après `cursor` (bornés), dans l'ordre. */
export async function detectAccounts(sql: Sql, cursor: number, limit: number, accountId: number | null): Promise<number[]> {
  const r = await sql.unsafe<Row[]>(`
    SELECT DISTINCT account_id FROM (
      SELECT o.account_id FROM business_operations o
       WHERE o.type_code = 'INTERVENTION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         AND o.account_id > $1 AND ($3::int IS NULL OR o.account_id = $3::int)
         AND EXISTS (SELECT 1 FROM agenda_items i WHERE i.account_id = o.account_id AND i.business_operation_id = o.id)
      UNION
      SELECT i.account_id FROM agenda_items i
        JOIN business_operation_sources s ON s.account_id = i.account_id AND s.active AND s.source_kind = 'DOCUMENT'
             AND s.source_entity_key = i.origin_ref_id::text
       WHERE i.origin_ref_type = 'asset_file' AND i.is_automatic AND i.projection_origin IS NULL
         AND i.business_type IN ('maintenance', 'repair') AND i.account_id > $1 AND ($3::int IS NULL OR i.account_id = $3::int)
      UNION
      SELECT i.account_id FROM agenda_items i JOIN business_operations o ON o.id = i.business_operation_id
       WHERE (o.merged_into_operation_id IS NOT NULL OR o.invalidated_at IS NOT NULL)
         AND i.account_id > $1 AND ($3::int IS NULL OR i.account_id = $3::int)
    ) x
    -- Lot 82A (C-Q10, §3.3) : rattrapage des seuls comptes éligibles.
    WHERE ${processingEligibleSql('x.account_id')}
    ORDER BY account_id LIMIT $2`, [cursor, limit, accountId] as never[]);
  return r.map((x) => Number(x.account_id));
}

/** Opérations d'un compte concernées (voir l'en-tête). */
export async function detectOperations(sql: Sql, accountId: number): Promise<{ ids: number[]; residual: number }> {
  const r = await sql.unsafe<Row[]>(`
    WITH ops AS (
      SELECT o.id, COALESCE(o.realized_date, o.planned_date) AS d FROM business_operations o
       WHERE o.account_id = $1 AND o.type_code = 'INTERVENTION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
    )
    SELECT ops.id, false AS residual FROM ops
     WHERE (ops.d IS NOT NULL AND EXISTS (
              SELECT 1 FROM agenda_items i
                JOIN business_operation_sources s ON s.operation_id = ops.id AND s.active AND s.source_kind = 'DOCUMENT'
                     AND s.source_entity_key = i.origin_ref_id::text
               WHERE i.account_id = $1 AND i.origin_ref_type = 'asset_file' AND i.is_automatic AND i.projection_origin IS NULL
                 AND i.business_type IN ('maintenance', 'repair')
                 AND i.start_date BETWEEN ops.d - 3 AND ops.d + 3
                 AND i.business_operation_id IS DISTINCT FROM ops.id))
        OR (SELECT count(*) FROM agenda_items i WHERE i.account_id = $1 AND i.business_operation_id = ops.id) >= 2
    UNION
    SELECT o.id, true FROM agenda_items i JOIN business_operations o ON o.id = i.business_operation_id
     WHERE i.account_id = $1 AND (o.merged_into_operation_id IS NOT NULL OR o.invalidated_at IS NOT NULL)
    ORDER BY 1`, [accountId] as never[]);
  return { ids: r.map((x) => Number(x.id)), residual: r.filter((x) => x.residual === true).length };
}

/** Groupes T4 « même document, même date » d'entretien / réparation sans Opération active d'intervention (signalés). */
export async function detectNoOperationGroups(sql: Sql, accountId: number): Promise<Row[]> {
  return sql.unsafe<Row[]>(`
    SELECT i.origin_ref_id AS file_id, i.start_date::text AS date, array_agg(i.id ORDER BY i.id) AS item_ids,
           array_agg(i.title ORDER BY i.id) AS titles
      FROM agenda_items i
     WHERE i.account_id = $1 AND i.origin_ref_type = 'asset_file' AND i.is_automatic AND i.projection_origin IS NULL
       AND i.business_type IN ('maintenance', 'repair') AND i.business_operation_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
                        WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = i.origin_ref_id::text
                          AND o.type_code = 'INTERVENTION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)
     GROUP BY i.origin_ref_id, i.start_date HAVING count(*) >= 2
     ORDER BY 1, 2 LIMIT 100`, [accountId] as never[]);
}

// ── Exécution ───────────────────────────────────────────────────────────────

function classify(accountId: number, p: PlannedOperation, counters: RepriseCounters, report: RepriseReportEntry[]): void {
  const push = (e: RepriseReportEntry) => { if (report.length < REPORT_MAX) report.push(e); };
  let utile = false;
  for (const a of p.actions) {
    if (a.kind === 'CONSOLIDATE') {
      counters.certain++;
      utile = true;
      push({ accountId, operationId: p.operationId, category: 'CERTAIN_CONSOLIDATION', detail: { principalId: a.principalId, absorbedIds: a.absorbedIds, linkPrincipal: a.linkPrincipal } });
    } else if (a.kind === 'LINK') {
      utile = true;
      push({ accountId, operationId: p.operationId, category: 'LINK', detail: { itemId: a.itemId, reason: a.reason } });
    } else if (a.kind === 'RETITLE') {
      utile = true;
      push({ accountId, operationId: p.operationId, category: 'RETITLE', detail: { itemId: a.itemId, from: a.from, to: a.title } });
    } else if (a.kind === 'ABSTAIN' && a.candidates?.length) {
      counters.arbitration++;
      utile = true;
      push({ accountId, operationId: p.operationId, category: 'ARBITRATION', detail: { reason: a.reason, candidates: a.candidates.map((c) => c.itemId) } });
    }
  }
  if (!utile) push({ accountId, operationId: p.operationId, category: 'DISTINCT_OR_UNCHANGED', detail: { actions: p.actions.map((a) => a.kind) } });
}

async function writeRun(sql: Sql, runId: string, patch: { status?: string; cursor?: number; counters?: RepriseCounters; report?: RepriseReportEntry[]; error?: string | null; finished?: boolean }): Promise<void> {
  await sql.unsafe(
    `UPDATE agenda_intervention_reprise_runs
        SET status = COALESCE($2, status), cursor_account_id = COALESCE($3, cursor_account_id),
            counters = COALESCE($4::text::jsonb, counters), report = COALESCE($5::text::jsonb, report),
            error = CASE WHEN $6::boolean THEN $7 ELSE error END,
            heartbeat_at = now(), finished_at = CASE WHEN $8::boolean THEN now() ELSE finished_at END
      WHERE id = $1::uuid`,
    [runId, patch.status ?? null, patch.cursor ?? null, patch.counters ? JSON.stringify(patch.counters) : null,
      patch.report ? JSON.stringify({ entries: patch.report }) : null, patch.error !== undefined, patch.error ?? null, patch.finished === true] as never[],
  );
}

/**
 * Exécute (ou reprend) le rattrapage, borné à `maxAccounts` comptes et à
 * `deadline` : `more` indique qu'il reste des comptes (appel suivant).
 */
export async function runAgendaDuplicatesReprise(opts: RepriseOptions): Promise<RepriseResult> {
  const sql = opts.sql ?? pgClient;
  const log = opts.log ?? (() => undefined);
  if (!(await consolidationJournalReady(sql))) throw new Error('Migration 0591 absente : rattrapage des doublons d’interventions impossible.');
  let runId = opts.resumeRunId ?? null;
  let counters = zero();
  let report: RepriseReportEntry[] = [];
  let cursor = 0;
  if (runId) {
    const [r] = await sql.unsafe<Row[]>(`SELECT cursor_account_id, counters, report FROM agenda_intervention_reprise_runs WHERE id = $1::uuid`, [runId] as never[]);
    if (!r) throw new Error(`Exécution ${runId} introuvable.`);
    cursor = Number(r.cursor_account_id ?? 0);
    counters = { ...zero(), ...((r.counters ?? {}) as Partial<RepriseCounters>) };
    report = (((r.report ?? {}) as { entries?: RepriseReportEntry[] }).entries ?? []).slice(0, REPORT_MAX);
    await sql.unsafe(`UPDATE agenda_intervention_reprise_runs SET status = 'running', heartbeat_at = now(), finished_at = NULL, error = NULL WHERE id = $1::uuid`, [runId] as never[]);
  } else {
    runId = randomUUID();
    await sql.unsafe(
      `INSERT INTO agenda_intervention_reprise_runs (id, mode, origin, account_filter, reason, admin_user_id) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
      [runId, opts.mode, opts.origin, opts.accountId ?? null, opts.reason ?? null, opts.adminUserId ?? null] as never[],
    );
  }
  const { projectAccountOperations } = await import('./service');
  const comptes = await detectAccounts(sql, cursor, opts.maxAccounts ?? REPRISE_ACCOUNTS_PER_CALL, opts.accountId ?? null);
  let more = comptes.length >= (opts.maxAccounts ?? REPRISE_ACCOUNTS_PER_CALL);
  try {
    for (const accountId of comptes) {
      if (opts.deadline && Date.now() > opts.deadline) { more = true; break; }
      counters.accounts++;
      try {
        const { ids, residual } = await detectOperations(sql, accountId);
        counters.residualsAfterMerge += residual;
        if (ids.length) {
          counters.operations += ids.length;
          // 1. Plan (simulation) : actions envisagées, rapportées.
          const plan = await projectAccountOperations(accountId, { operationIds: ids, dryRun: true, correlationId: `reprise-76h:${runId}` });
          for (const p of plan.plans ?? []) classify(accountId, p, counters, report);
          // 2. Application (mode APPLY) : même moteur, journal 0591 rattaché à l'exécution.
          if (opts.mode === 'APPLY') {
            const r: ProjectionRunResult = await projectAccountOperations(accountId, { operationIds: ids, runId, correlationId: `reprise-76h:${runId}` });
            counters.consolidated += r.consolidated ?? 0;
            counters.linked += r.linked;
            counters.retitled += r.retitled ?? 0;
            counters.protectedItems += r.consolidationProtected ?? 0;
            counters.projectionsCreated += r.created;
          }
        }
        for (const g of await detectNoOperationGroups(sql, accountId)) {
          counters.noOperationGroups++;
          if (report.length < REPORT_MAX) report.push({ accountId, category: 'NO_OPERATION', detail: { fileId: Number(g.file_id), date: g.date, itemIds: g.item_ids, titles: g.titles } });
        }
      } catch (e) {
        counters.errors++;
        if (report.length < REPORT_MAX) report.push({ accountId, category: 'ERROR', detail: { message: (e as Error).message.slice(0, 300) } });
        console.error(`[reprise-76h] compte ${accountId} :`, (e as Error).message);
      }
      cursor = accountId;
      await writeRun(sql, runId, { cursor, counters, report });
      log(`compte ${accountId} : ${JSON.stringify({ certain: counters.certain, consolidated: counters.consolidated, arbitration: counters.arbitration })}`);
    }
  } catch (e) {
    await writeRun(sql, runId, { status: 'failed', counters, report, error: (e as Error).message.slice(0, 500), finished: true });
    throw e;
  }
  const status = more ? 'running' : 'succeeded';
  await writeRun(sql, runId, { status, cursor, counters, report, finished: !more });
  return { runId, mode: opts.mode, status, more, cursor, counters, report };
}

/** Restaure une exécution APPLY (journal 0591). */
export async function restoreAgendaDuplicatesReprise(sql: Sql, runId: string, opts: { reason?: string | null; adminUserId?: number | null } = {}) {
  if (!(await consolidationJournalReady(sql))) throw new Error('Migration 0591 absente.');
  const [run] = await sql.unsafe<Row[]>(`SELECT mode FROM agenda_intervention_reprise_runs WHERE id = $1::uuid`, [runId] as never[]);
  if (!run) throw new Error(`Exécution ${runId} introuvable.`);
  if (run.mode !== 'APPLY') throw new Error('Seule une exécution « application » se restaure.');
  const restoreRunId = randomUUID();
  await sql.unsafe(
    `INSERT INTO agenda_intervention_reprise_runs (id, mode, origin, restore_of, reason, admin_user_id) VALUES ($1::uuid, 'RESTORE', 'BO', $2::uuid, $3, $4)`,
    [restoreRunId, runId, opts.reason ?? null, opts.adminUserId ?? null] as never[],
  );
  const r = await restoreAgendaConsolidations(sql, { runId, restoreRunId });
  await sql.unsafe(
    `UPDATE agenda_intervention_reprise_runs SET status = 'succeeded', finished_at = now(), counters = $2::text::jsonb, report = $3::text::jsonb WHERE id = $1::uuid`,
    [restoreRunId, JSON.stringify({ restored: r.restored, conflicts: r.conflicts.length }), JSON.stringify({ conflicts: r.conflicts.slice(0, REPORT_MAX) })] as never[],
  );
  return { restoreRunId, ...r };
}

// Lot 82B (C-Q9) : la tâche de démarrage ponctuelle (`runAutomaticAgendaDuplicatesReprise`) est RETIRÉE —
// la détection et la convergence sont reprises CHAQUE JOUR par le contrôle de cohérence COH-AGENDA-OCCURRENCES
// (même détection, même projection, même journal 0591). Restent ici : le rattrapage BO (simuler, appliquer, restaurer).
