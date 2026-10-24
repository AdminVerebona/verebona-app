/**
 * Rattrapage BO « Opérations v5 : purge et reconstruction (préproduction) »
 * (`operations-v5-rebuild`) — lot 85A, CDC « Opérations, Agenda, Timeline,
 * Sinistres v5 » lot O-2 (§20, AC41–AC43, E20) ; arbitrages PO V-Q2, V-Q3
 * (aucune production : préproduction seulement), C-Q5, C-Q8, C-Q10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MOTEUR : celui des RATTRAPAGES EXISTANTS (BO › Exploitation › Rattrapages,
 * `admin/ops/backfill`) — Simuler / Appliquer / Restaurer, un compte ou tous,
 * exécution en tâche de fond exclusive, journal d'administration. Pas de
 * nouveau runner. Le moteur de CAMPAGNE de cohérence (82B) n'est PAS
 * réutilisé pour exécuter la reconstruction : une campagne est continue,
 * quotidienne et sans point de restauration ni restauration par exécution —
 * y loger une purge en ferait un traitement systématique (contraire à C-Q1 /
 * C-Q7) ; elle est en revanche DEMANDÉE après l'application, sur les comptes
 * reconstruits (V-Q2 « après nettoyage, cohérence globale »).
 *
 * SIMULER : inventaire exact par compte (Opérations purgées / conservées et
 *   motifs, projections retirées, cartes closes, candidats remis, décisions
 *   TCO re-clées, données de l'utilisateur), TCO relu — AUCUNE écriture hors
 *   journal d'exécution.
 * APPLIQUER : REFUSÉ (refus journalisé) sans point de restauration de moins
 *   de 24 h restaurable dans le schéma courant (API 82E, même règle que
 *   83D / 84A). Puis, compte par compte (comptes non éligibles exclus,
 *   C-Q10) :
 *     · compte déjà reconstruit et inchangé depuis (empreinte) → rien
 *       (idempotence : un second passage n'écrit rien) ;
 *     · travail T3 / T4 du compte en cours → compte reporté (BUSY) ;
 *     · travaux T3 / T4 EN ATTENTE du compte retenus dans la file durable
 *       (date de disponibilité repoussée, marque `operationsRebuildHold`)
 *       pendant la reconstruction, relâchés ensuite — arrêt T3 du compte
 *       par la file existante ;
 *     · UNE transaction sous le verrou Opération du compte (39101) : image
 *       AVANT du périmètre (`snapshot.ts`), purge des données dérivées
 *       (`purge.ts`) ;
 *     · reconstruction par les services existants (`reconstruct.ts`), sans
 *       nouvelle analyse T1 ; M3 borné par ses plafonds, mesuré ;
 *     · contrôle : données de l'utilisateur intactes, TCO relu, signature
 *       métier, convergence ; empreinte APRÈS relevée ;
 *     · échec de la reconstruction → compte remis à l'image avant
 *       automatiquement (rien de perdu).
 *   Enfin, campagne de cohérence (82B) sur les comptes reconstruits éligibles.
 * RESTAURER (identifiant d'exécution) : chaque compte reconstruit est remis
 *   EXACTEMENT à son image avant, s'il n'a pas changé depuis la
 *   reconstruction (empreinte) ; sinon restauration REFUSÉE pour ce compte
 *   (tables modifiées signalées, jamais d'écrasement) — le point de
 *   restauration de la base (bloc 0) reste le recours global.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RestorePointCheck, RestorePointInfo } from '../claims/legacy-cleanup';
import type { OperationMatchDeps } from '../consolidation/m3';
import {
  REBUILD_SCOPE, REBUILD_VERSION, RESTORE_POINT_REQUIRED_CODE, canonicalBusinessSignature, preflightStatus, userDataLosses,
  type PurgePlan, type RebuildAccountStatus, type UserDataCounts,
} from './model';
import { accountStateHash, captureSnapshot, changedTables, restoreFromImages, scopeMeta, type TableMeta } from './snapshot';
import { applyPurge, inventoryAccount, readUserData } from './purge';
import { readAccountTco, readSignatureOperations, rebuildAccount, tcoDifferences, type RebuildStepsReport, type TcoSnapshot } from './reconstruct';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

export interface RebuildOptions {
  sql: Sql;
  mode: 'SIMULATE' | 'APPLY';
  accountId?: number | null;
  reason?: string | null;
  adminUserId?: number | null;
  now?: Date;
  /** Date civile de référence (AAAA-MM-JJ) de la reconstruction et du TCO relu (tests). */
  today?: string;
  log?: (m: string) => void;
  /** Tests : points de restauration (défaut : stockage réel, API 82E). */
  restorePoints?: () => Promise<RestorePointInfo[]>;
  /** Tests : demande de campagne de cohérence (défaut : orchestrateur 82B). */
  requestCoherence?: (accountIds: number[], runId: string) => Promise<number | null>;
  /** Niveau M3 : dépendances injectables (tests) ; défaut : passerelle réelle, plafonds existants. */
  operationMatch?: false | OperationMatchDeps;
  /** Reconstruire même un compte inchangé depuis sa dernière reconstruction (tests AC43 ; jamais exposé au BO). */
  force?: boolean;
}

export interface AccountRebuildReport {
  accountId: number;
  status: RebuildAccountStatus;
  reason?: string | null;
  plan?: PurgePlan;
  purge?: Record<string, number>;
  steps?: RebuildStepsReport;
  userData?: { before: UserDataCounts; after: UserDataCounts | null; losses: string[] };
  tco?: { before: TcoSnapshot; after: TcoSnapshot | null; differences: string[] };
  signature?: { before: string; after: string | null; identical: boolean | null };
  ai?: { byOperation: Record<string, number>; costMicros: number; t1Calls: number; t1JobsQueued: number };
  operations?: { before: number; after: number | null };
  queueHeld?: number;
  autoRestored?: boolean;
  warnings: string[];
  durationMs: number;
}

export interface RebuildResult {
  runId: string;
  mode: 'SIMULATE' | 'APPLY';
  status: 'succeeded' | 'partial' | 'refused' | 'failed';
  refusal: string | null;
  restorePoint: { backupId: string | null; finishedAt: string | null } | null;
  version: string;
  accounts: AccountRebuildReport[];
  excluded: Array<{ accountId: number; reason: string }>;
  counters: Record<string, number>;
  coherence: { requested: boolean; campaignId: number | null; accounts: number[] };
}

const HOLD_MARK = 'operationsRebuildHold';
/** Travaux du compte retenus au plus ce délai (filet si l'exécution s'arrête : la file les reprend seule). */
const HOLD_SECONDS = 2 * 3_600;

async function startRun(sql: Sql, p: { runId: string; mode: string; accountId: number | null; reason: string | null; adminUserId: number | null; restoreOf?: string | null }): Promise<void> {
  await sql`
    INSERT INTO operations_rebuild_runs (id, mode, account_filter, reason, admin_user_id, restore_of, rebuild_version)
    VALUES (${p.runId}, ${p.mode}, ${p.accountId}, ${p.reason}, ${p.adminUserId}, ${p.restoreOf ?? null}, ${REBUILD_VERSION})`;
}

async function finishRun(sql: Sql, runId: string, p: {
  status: string; mode?: string; counters?: Row; accounts?: number[]; excluded?: unknown; error?: string | null;
  restorePoint?: { backupId: string | null; finishedAt: string | null } | null; campaignId?: number | null;
}): Promise<void> {
  await sql`
    UPDATE operations_rebuild_runs
       SET status = ${p.status}, mode = COALESCE(${p.mode ?? null}, mode), counters = ${JSON.stringify(p.counters ?? {})}::jsonb,
           accounts = ${p.accounts ?? []}::int[], excluded = ${JSON.stringify(p.excluded ?? [])}::jsonb, error = ${p.error ?? null},
           restore_point_id = ${p.restorePoint?.backupId ?? null}, restore_point_at = ${p.restorePoint?.finishedAt ?? null}::timestamptz,
           coherence_campaign_id = ${p.campaignId ?? null}, finished_at = now()
     WHERE id = ${runId}`;
}

/** Comptes porteurs de données d'Opérations (Opérations, candidats T1 actifs, projections), ordre croissant. */
async function candidateAccounts(sql: Sql, accountId: number | null): Promise<number[]> {
  const r = await sql.unsafe<Array<{ a: number }>>(`
    SELECT DISTINCT a FROM (
      SELECT account_id AS a FROM business_operations
      UNION SELECT account_id FROM document_operation_candidates WHERE status = 'ACTIVE'
      UNION SELECT account_id FROM agenda_items WHERE projection_origin = 'OPERATION'
    ) x WHERE $1::int IS NULL OR a = $1::int ORDER BY a`, [accountId] as never[]);
  return r.map((x) => Number(x.a));
}

async function busyJobs(sql: Sql, accountId: number): Promise<number> {
  const [r] = await sql.unsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM ai_job_queue WHERE account_id = $1 AND treatment IN ('T3', 'T4') AND status = 'RUNNING'`, [accountId] as never[]);
  return Number(r?.n ?? 0);
}

/** Retient les travaux T3 / T4 EN ATTENTE du compte (file durable existante). */
async function holdJobs(sql: Sql, accountId: number, runId: string): Promise<number> {
  return (await sql.unsafe(`
    UPDATE ai_job_queue
       SET available_at = GREATEST(available_at, now() + ($3 || ' seconds')::interval),
           payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{${HOLD_MARK}}', to_jsonb($2::text))
     WHERE account_id = $1 AND treatment IN ('T3', 'T4') AND status = 'PENDING'
       AND COALESCE(payload->>'${HOLD_MARK}', '') <> $2 RETURNING 1`, [accountId, runId, String(HOLD_SECONDS)] as never[])).length;
}

/** Relâche les travaux retenus par l'exécution (disponibles tout de suite). */
async function releaseJobs(sql: Sql, accountId: number, runId: string): Promise<number> {
  return (await sql.unsafe(`
    UPDATE ai_job_queue SET available_at = now(), payload = payload - '${HOLD_MARK}'
     WHERE account_id = $1 AND payload->>'${HOLD_MARK}' = $2 AND status = 'PENDING' RETURNING 1`, [accountId, runId] as never[])).length;
}

async function lastRebuild(sql: Sql, accountId: number): Promise<{ afterHash: string | null } | null> {
  const [r] = await sql.unsafe<Array<{ after_hash: string | null }>>(`
    SELECT after_hash FROM operations_rebuild_accounts
     WHERE account_id = $1 AND status IN ('REBUILT', 'PARTIAL') AND rebuild_version = $2 AND restored_at IS NULL
     ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [accountId, REBUILD_VERSION] as never[]);
  return r ? { afterHash: r.after_hash } : null;
}

async function aiSince(sql: Sql, accountId: number, since: Date): Promise<NonNullable<AccountRebuildReport['ai']>> {
  const r = await sql.unsafe<Array<{ op: string; n: number; cost: number | null }>>(`
    SELECT COALESCE(operation_code, operation_type, '?') AS op, count(*)::int AS n, COALESCE(sum(cost_micros), 0)::bigint AS cost
      FROM ai_usage_event WHERE account_id = $1 AND created_at >= $2::timestamptz GROUP BY 1 ORDER BY 1`, [accountId, since.toISOString()] as never[]);
  const [q] = await sql.unsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM ai_job_queue WHERE account_id = $1 AND treatment = 'T1' AND created_at >= $2::timestamptz`, [accountId, since.toISOString()] as never[]);
  const byOperation = Object.fromEntries(r.map((x) => [x.op, Number(x.n)]));
  return {
    byOperation, costMicros: r.reduce((t, x) => t + Number(x.cost ?? 0), 0),
    t1Calls: r.filter((x) => x.op.startsWith('t1_') || x.op === 'extract_source').reduce((t, x) => t + Number(x.n), 0),
    t1JobsQueued: Number(q?.n ?? 0),
  };
}

async function activeOperationCount(sql: Sql, accountId: number): Promise<number> {
  const [r] = await sql.unsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM business_operations WHERE account_id = $1 AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`, [accountId] as never[]);
  return Number(r?.n ?? 0);
}

/** Empreinte de la signature métier du compte (AC43 : sans identifiant technique). */
export async function businessSignatureHash(sql: Sql, accountId: number): Promise<string> {
  return createHash('sha256').update(canonicalBusinessSignature(await readSignatureOperations(sql, accountId))).digest('hex');
}

/** Campagne de cohérence (82B) sur les comptes reconstruits ÉLIGIBLES (C-Q10). */
async function defaultRequestCoherence(accountIds: number[], runId: string): Promise<number | null> {
  const { coherenceTablesReady, startCampaign } = await import('@/services/coherence/orchestrator');
  if (!accountIds.length || !(await coherenceTablesReady())) return null;
  return startCampaign({ kind: 'MANUAL', trigger: `operations-v5-rebuild:${runId}`.slice(0, 120), scopeAccountIds: accountIds });
}

/** Restaure un compte à l'image d'une exécution (transaction propre, verrou du compte). */
async function restoreAccountImage(sql: Sql, meta: readonly TableMeta[], runId: string, accountId: number): Promise<{ writes: number }> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(39101::int, ${accountId}::int)`;
    const imgs = await tx<Array<{ table_name: string; rows: unknown }>>`
      SELECT table_name, rows FROM operations_rebuild_snapshots WHERE run_id = ${runId} AND account_id = ${accountId}`;
    const images = new Map(imgs.map((x) => [x.table_name, typeof x.rows === 'string' ? x.rows : JSON.stringify(x.rows)]));
    const r = await restoreFromImages(tx, meta.filter((m) => images.has(m.table)), accountId, images);
    return { writes: r.writes };
  });
}

/** Simuler ou appliquer la purge et la reconstruction (voir l'en-tête). */
export async function runOperationsRebuild(opts: RebuildOptions): Promise<RebuildResult> {
  const { sql } = opts;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const runId = randomUUID();
  const accountFilter = opts.accountId ?? null;
  const result: RebuildResult = {
    runId, mode: opts.mode, status: 'succeeded', refusal: null, restorePoint: null, version: REBUILD_VERSION, accounts: [], excluded: [],
    counters: {}, coherence: { requested: false, campaignId: null, accounts: [] },
  };
  await startRun(sql, { runId, mode: opts.mode, accountId: accountFilter, reason: opts.reason ?? null, adminUserId: opts.adminUserId ?? null });

  // C-Q8 : aucune écriture sans point de restauration de moins de 24 h (vérifié AVANT toute lecture).
  if (opts.mode === 'APPLY') {
    const { listRestorePoints, pickRecentRestorePoint } = await import('../claims/legacy-cleanup');
    let check: RestorePointCheck;
    try {
      check = pickRecentRestorePoint(await (opts.restorePoints ?? (() => listRestorePoints(sql)))(), now);
    } catch (e) {
      check = { ok: false, backupId: null, finishedAt: null, reason: `Points de restauration illisibles (${(e as Error).message}) : application refusée.` };
    }
    if (!check.ok) {
      result.status = 'refused';
      result.refusal = (check.reason ?? 'Point de restauration requis.').replace('ce nettoyage', 'cette reconstruction');
      await finishRun(sql, runId, { status: 'refused', mode: 'REFUSED', error: result.refusal });
      log(`refusé : ${result.refusal}`);
      return result;
    }
    result.restorePoint = { backupId: check.backupId, finishedAt: check.finishedAt };
    log(`point de restauration ${check.backupId} (${check.finishedAt})`);
  }

  try {
    const meta = await scopeMeta(sql, REBUILD_SCOPE);
    const comptes = await candidateAccounts(sql, accountFilter);
    const { filterEligibleAccountIds, checkAccountProcessingEligibility } = await import('@/services/account/processing-eligibility');
    const eligibles = await filterEligibleAccountIds(comptes, now);
    for (const accountId of comptes) {
      const t0 = Date.now();
      const rep: AccountRebuildReport = { accountId, status: 'PLANNED', warnings: [], durationMs: 0 };
      const eligible = eligibles.has(accountId);
      if (!eligible) {
        const e = await checkAccountProcessingEligibility(accountId, { now }).catch(() => ({ eligible: false, reason: null }));
        result.excluded.push({ accountId, reason: e.reason ?? 'ACCOUNT_INELIGIBLE' });
        log(`compte ${accountId} : non éligible (${e.reason ?? '—'}), exclu`);
        continue;
      }
      const etat = await accountStateHash(sql, meta, accountId);
      const dernier = await lastRebuild(sql, accountId);
      const upToDate = !opts.force && !!dernier?.afterHash && dernier.afterHash === etat.hash;
      const busy = (await busyJobs(sql, accountId)) > 0;
      const pre = preflightStatus({ eligible, busy, upToDate, mode: opts.mode });
      if (pre) {
        rep.status = pre;
        rep.durationMs = Date.now() - t0;
        result.accounts.push(rep);
        await recordAccount(sql, runId, rep, { beforeHash: etat.hash, afterHash: pre === 'UP_TO_DATE' ? etat.hash : null });
        log(`compte ${accountId} : ${pre}`);
        continue;
      }

      if (opts.mode === 'SIMULATE') {
        rep.plan = await inventoryAccount(sql, accountId);
        rep.tco = { before: await readAccountTco(accountId, opts.today), after: null, differences: [] };
        rep.userData = { before: rep.plan.userData, after: null, losses: [] };
        rep.operations = { before: rep.plan.operations.active, after: null };
        rep.durationMs = Date.now() - t0;
        result.accounts.push(rep);
        await recordAccount(sql, runId, rep, { beforeHash: etat.hash, afterHash: null });
        log(`compte ${accountId} : ${rep.plan.purged.length} Opération(s) à purger, ${rep.plan.kept.length} conservée(s)`);
        continue;
      }

      // ── APPLIQUER ──────────────────────────────────────────────────────
      rep.queueHeld = await holdJobs(sql, accountId, runId);
      try {
        const e = await checkAccountProcessingEligibility(accountId, { now });
        if (!e.eligible) {
          result.excluded.push({ accountId, reason: e.reason ?? 'ACCOUNT_INELIGIBLE' });
          continue;
        }
        const tcoAvant = await readAccountTco(accountId, opts.today);
        const sigAvant = await businessSignatureHash(sql, accountId);
        const opsAvant = await activeOperationCount(sql, accountId);
        const debut = new Date();
        // Image avant + purge : UNE transaction, verrou Opération du compte. Échec : rien n'est purgé (annulée).
        let tour: { plan: PurgePlan; purge: Record<string, number>; beforeHash: string };
        try {
          tour = await sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(39101::int, ${accountId}::int)`;
            const avant = await accountStateHash(tx, meta, accountId);
            const plan = await inventoryAccount(tx, accountId);
            await captureSnapshot(tx, meta, runId, accountId);
            const purge = await applyPurge(tx, accountId, plan, { runId, now });
            return { plan, purge, beforeHash: avant.hash };
          });
        } catch (err) {
          rep.status = 'FAILED';
          rep.reason = `purge annulée, rien n’a été modifié : ${(err as Error).message.slice(0, 400)}`;
          rep.durationMs = Date.now() - t0;
          result.accounts.push(rep);
          await recordAccount(sql, runId, rep, { beforeHash: etat.hash, afterHash: null });
          log(`compte ${accountId} : ${rep.reason}`);
          continue;
        }
        const { plan, purge, beforeHash } = tour;
        rep.plan = plan;
        rep.purge = purge;
        rep.operations = { before: opsAvant, after: null };
        // Trace provisoire : si l'exécution s'arrête (redémarrage, déploiement), le compte reste lisible au rapport ;
        // relancer « Appliquer » sur ce compte reprend proprement (aucune donnée de l'utilisateur n'a été purgée).
        await recordAccount(sql, runId, {
          ...rep, status: 'FAILED',
          reason: 'reconstruction commencée — si l’exécution a été interrompue, relancez « Appliquer » sur ce compte (aucune donnée de l’utilisateur n’a été purgée) ou restaurez le point de restauration de la base',
        }, { beforeHash, afterHash: null });
        log(`compte ${accountId} : ${purge.operationsPurged ?? 0} Opération(s) purgée(s), ${plan.kept.length} conservée(s), ${purge.projectionsRemoved} projection(s) retirée(s)`);
        try {
          rep.steps = await rebuildAccount(accountId, plan.agendaSourceItems, {
            correlationId: `operations-rebuild:${runId}:${accountId}`, today: opts.today, log,
            ...(opts.operationMatch !== undefined ? { operationMatch: opts.operationMatch } : {}),
            beforeWrite: async () => { await holdJobs(sql, accountId, runId); },
          });
        } catch (err) {
          // Reconstruction interrompue : le compte revient EXACTEMENT à son image avant (rien de perdu).
          rep.status = 'FAILED';
          rep.reason = (err as Error).message.slice(0, 500);
          try {
            await restoreAccountImage(sql, meta, runId, accountId);
            rep.autoRestored = true;
            rep.warnings.push('Reconstruction interrompue : compte remis automatiquement à son état d’avant.');
          } catch (e2) {
            rep.autoRestored = false;
            rep.warnings.push(`Reconstruction interrompue et remise automatique impossible (${(e2 as Error).message.slice(0, 200)}) : utilisez « Restaurer » ou le point de restauration de la base.`);
          }
          rep.durationMs = Date.now() - t0;
          result.accounts.push(rep);
          await recordAccount(sql, runId, rep, { beforeHash, afterHash: null, restored: rep.autoRestored === true });
          log(`compte ${accountId} : échec de la reconstruction — ${rep.reason}`);
          continue;
        }
        const userAfter = await readUserData(sql, accountId);
        rep.userData = { before: plan.userData, after: userAfter, losses: userDataLosses(plan.userData, userAfter) };
        const tcoApres = await readAccountTco(accountId, opts.today);
        rep.tco = { before: tcoAvant, after: tcoApres, differences: tcoDifferences(tcoAvant, tcoApres) };
        const sigApres = await businessSignatureHash(sql, accountId);
        rep.signature = { before: sigAvant, after: sigApres, identical: sigAvant === sigApres };
        rep.operations.after = await activeOperationCount(sql, accountId);
        rep.ai = await aiSince(sql, accountId, debut);
        const s = rep.steps;
        if (rep.userData.losses.length) rep.warnings.push(...rep.userData.losses.map((l) => `Donnée de l’utilisateur en baisse — ${l}`));
        if (s.consolidation.remaining) rep.warnings.push('Des documents restent à consolider : le passage T3 suivant les reprendra.');
        if (s.convergence.consolidationChanges || s.convergence.projectionChanges) {
          rep.warnings.push(`Convergence incomplète (dernier passage : ${s.convergence.consolidationChanges} écriture(s) T3, ${s.convergence.projectionChanges} écriture(s) de projection).`);
        }
        if (rep.ai.t1Calls || rep.ai.t1JobsQueued) rep.warnings.push(`Analyse T1 sollicitée (${rep.ai.t1Calls} appel(s), ${rep.ai.t1JobsQueued} travail(aux)) : anomalie, la reconstruction ne doit jamais relancer T1.`);
        rep.warnings.push(...s.errors.slice(0, 20));
        rep.status = rep.userData.losses.length || s.errors.length || s.consolidation.errors || s.consolidation.remaining ? 'PARTIAL' : 'REBUILT';
        const apres = await accountStateHash(sql, meta, accountId);
        rep.durationMs = Date.now() - t0;
        result.accounts.push(rep);
        await recordAccount(sql, runId, rep, { beforeHash, afterHash: apres.hash, afterTables: apres.tables });
        log(`compte ${accountId} : ${rep.status} — ${rep.operations.before} → ${rep.operations.after} Opération(s) active(s), M3 ${s.m3.calls} appel(s)`);
      } finally {
        await releaseJobs(sql, accountId, runId).catch(() => 0);
      }
    }

    const rebuilt = result.accounts.filter((a) => a.status === 'REBUILT' || a.status === 'PARTIAL').map((a) => a.accountId);
    if (opts.mode === 'APPLY' && rebuilt.length) {
      // V-Q2 : après la purge, cohérence globale sur les comptes actifs concernés (jamais un compte inéligible).
      const { filterEligibleAccountIds } = await import('@/services/account/processing-eligibility');
      const el = await filterEligibleAccountIds(rebuilt, new Date());
      result.coherence.accounts = rebuilt.filter((a) => el.has(a));
      if (result.coherence.accounts.length) {
        try {
          result.coherence.campaignId = await (opts.requestCoherence ?? defaultRequestCoherence)(result.coherence.accounts, runId);
          result.coherence.requested = result.coherence.campaignId !== null;
        } catch (e) {
          log(`campagne de cohérence non demandée : ${(e as Error).message}`);
        }
      }
    }
    result.counters = countersOf(result);
    if (result.accounts.some((a) => a.status === 'PARTIAL' || a.status === 'FAILED')) result.status = 'partial';
    await finishRun(sql, runId, {
      status: result.status, counters: result.counters, accounts: result.accounts.map((a) => a.accountId), excluded: result.excluded,
      restorePoint: result.restorePoint, campaignId: result.coherence.campaignId,
    });
    return result;
  } catch (e) {
    result.status = 'failed';
    result.counters = countersOf(result);
    await finishRun(sql, runId, { status: 'failed', counters: result.counters, accounts: result.accounts.map((a) => a.accountId), excluded: result.excluded, error: (e as Error).message, restorePoint: result.restorePoint });
    throw e;
  }
}

function countersOf(r: RebuildResult): Record<string, number> {
  const c: Record<string, number> = { accounts: r.accounts.length, excluded: r.excluded.length };
  for (const a of r.accounts) {
    c[`status_${a.status}`] = (c[`status_${a.status}`] ?? 0) + 1;
    if (a.plan) {
      c.operationsPurged = (c.operationsPurged ?? 0) + a.plan.purged.length;
      c.operationsKept = (c.operationsKept ?? 0) + a.plan.kept.length;
      c.projectionsRemoved = (c.projectionsRemoved ?? 0) + a.plan.projectionsRemoved.length;
      c.candidatesRequeued = (c.candidatesRequeued ?? 0) + a.plan.candidatesRequeued;
      c.tcoDecisionsRekeyed = (c.tcoDecisionsRekeyed ?? 0) + a.plan.tcoDecisionsRekeyed.length;
    }
    if (a.steps) c.m3Calls = (c.m3Calls ?? 0) + a.steps.m3.calls;
    if (a.ai) c.t1Calls = (c.t1Calls ?? 0) + a.ai.t1Calls;
  }
  return c;
}

async function recordAccount(sql: Sql, runId: string, rep: AccountRebuildReport, h: {
  beforeHash: string | null; afterHash: string | null; afterTables?: Record<string, { rows: number; hash: string }>; restored?: boolean;
}): Promise<void> {
  const report = { ...rep, ...(h.afterTables ? { afterTables: h.afterTables } : {}) };
  await sql`
    INSERT INTO operations_rebuild_accounts (run_id, account_id, status, before_hash, after_hash, rebuild_version, report, restored_at, finished_at)
    VALUES (${runId}, ${rep.accountId}, ${rep.status}, ${h.beforeHash}, ${h.afterHash}, ${REBUILD_VERSION}, ${JSON.stringify(report)}::jsonb,
            ${h.restored ? new Date().toISOString() : null}::timestamptz, now())
    ON CONFLICT (run_id, account_id) DO UPDATE
       SET status = EXCLUDED.status, before_hash = EXCLUDED.before_hash, after_hash = EXCLUDED.after_hash, report = EXCLUDED.report,
           restored_at = EXCLUDED.restored_at, finished_at = now()`;
}

// ── Restauration ────────────────────────────────────────────────────────────

export interface RebuildRestoreReport {
  runId: string;
  restoreRunId: string;
  restored: Array<{ accountId: number; writes: number }>;
  refused: Array<{ accountId: number; reason: string; tables: string[] }>;
  conflicts: string[];
}

/**
 * Restaure une APPLICATION par son identifiant : chaque compte reconstruit
 * (non encore restauré) est remis EXACTEMENT à son image avant, dans sa
 * propre transaction, s'il n'a pas changé depuis la reconstruction ; sinon
 * refus signalé pour ce compte (rien d'écrit).
 */
export async function restoreOperationsRebuild(sql: Sql, runId: string, opts: { reason?: string | null; adminUserId?: number | null } = {}): Promise<RebuildRestoreReport> {
  const [run] = await sql<{ mode: string }[]>`SELECT mode FROM operations_rebuild_runs WHERE id = ${runId}`;
  if (!run || run.mode !== 'APPLY') throw new Error(`Exécution ${runId} introuvable ou non appliquée : rien à restaurer.`);
  const restoreRunId = randomUUID();
  await startRun(sql, { runId: restoreRunId, mode: 'RESTORE', accountId: null, reason: opts.reason ?? null, adminUserId: opts.adminUserId ?? null, restoreOf: runId });
  const out: RebuildRestoreReport = { runId, restoreRunId, restored: [], refused: [], conflicts: [] };
  const meta = await scopeMeta(sql, REBUILD_SCOPE);
  const comptes = await sql<Array<{ account_id: number; status: string; before_hash: string | null; after_hash: string | null; report: { afterTables?: Record<string, { rows: number; hash: string }> } }>>`
    SELECT account_id, status, before_hash, after_hash, report FROM operations_rebuild_accounts
     WHERE run_id = ${runId} AND status IN ('REBUILT', 'PARTIAL') AND restored_at IS NULL ORDER BY account_id DESC`;
  for (const c of comptes) {
    const accountId = Number(c.account_id);
    try {
      const r = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(39101::int, ${accountId}::int)`;
        const cur = await accountStateHash(tx, meta, accountId);
        if (!c.after_hash || cur.hash !== c.after_hash) {
          return { refused: changedTables(c.report?.afterTables ?? {}, cur.tables) };
        }
        const imgs = await tx<Array<{ table_name: string; rows: unknown }>>`
          SELECT table_name, rows FROM operations_rebuild_snapshots WHERE run_id = ${runId} AND account_id = ${accountId}`;
        const images = new Map(imgs.map((x) => [x.table_name, typeof x.rows === 'string' ? x.rows : JSON.stringify(x.rows)]));
        const w = await restoreFromImages(tx, meta.filter((m) => images.has(m.table)), accountId, images);
        const fin = await accountStateHash(tx, meta, accountId);
        if (c.before_hash && fin.hash !== c.before_hash) throw Object.assign(new Error('état restauré différent de l’image avant (empreinte)'), { code: 'RESTORE_NOT_EXACT' });
        await tx`UPDATE operations_rebuild_accounts SET restored_at = now(), restore_run_id = ${restoreRunId} WHERE run_id = ${runId} AND account_id = ${accountId}`;
        return { writes: w.writes };
      });
      if ('refused' in r && r.refused) {
        const reason = 'le compte a changé depuis la reconstruction : restauration refusée (rien n’a été modifié) — utilisez le point de restauration de la base si nécessaire';
        out.refused.push({ accountId, reason, tables: r.refused });
        out.conflicts.push(`compte ${accountId} : ${reason} (${r.refused.join(', ') || 'empreinte'})`);
        await sql`UPDATE operations_rebuild_accounts SET report = report || ${JSON.stringify({ restoreRefused: { at: new Date().toISOString(), tables: r.refused, restoreRunId } })}::jsonb
                   WHERE run_id = ${runId} AND account_id = ${accountId}`;
      } else {
        out.restored.push({ accountId, writes: (r as { writes: number }).writes });
      }
    } catch (e) {
      out.refused.push({ accountId, reason: (e as Error).message.slice(0, 300), tables: [] });
      out.conflicts.push(`compte ${accountId} : ${(e as Error).message.slice(0, 300)}`);
    }
  }
  await finishRun(sql, restoreRunId, {
    status: out.refused.length && !out.restored.length && comptes.length ? 'refused' : 'succeeded',
    counters: { restored: out.restored.length, refused: out.refused.length }, accounts: out.restored.map((x) => x.accountId),
  });
  return out;
}

export { RESTORE_POINT_REQUIRED_CODE };
