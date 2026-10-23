/**
 * Orchestrateur UNIQUE du contrôle de cohérence global — lot 82B (arbitrages
 * PO du 23/10/2026 C-Q1, C-Q2, C-Q3, C-Q4, C-Q5, C-Q9, C-Q10, §3.1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GÉNÉRALISATION DU MOTEUR DE CAMPAGNE « À TRAITER » (l76-pertinence)
 *
 * Même principe que la campagne de pertinence : curseur en base (compte ×
 * contrôle × objet), lots bornés, reprise après redémarrage ou dépassement
 * de délai, bilan RECALCULÉ depuis les éléments consignés (idempotent : une
 * reprise ne compte jamais deux fois), statut technique distinct du
 * résultat métier. Le motif l76 s'applique désormais à TOUS les contrôles du
 * registre (`registry/`), pour TOUS les comptes éligibles.
 *
 *   CAMPAGNE QUOTIDIENNE (DAILY) — exhaustive : chaque jour (Paris), TOUS les
 *     objets des comptes éligibles, y compris inchangés (C-Q1) ;
 *       phase TRAVERSE : parcours complet ;
 *       phase VERIFY   : recomptage de TOUS les objets attendus ; ceux qui
 *                        n'ont pas de contrôle RÉUSSI depuis le début de la
 *                        campagne (erreur, objet apparu) sont contrôlés à
 *                        nouveau ; ce qui reste en échec est consigné ;
 *       COMPLETE seulement si tout objet attendu a un contrôle réussi —
 *       sinon PARTIAL (reste consigné), jamais déclarée exhaustive (C-Q4).
 *       Échéance : début de la campagne du lendemain (5 h, Paris).
 *   CAMPAGNE DE RATTRAPAGE (CATCHUP) — exhaustive sur UN compte, demandée à
 *     sa réactivation (`requestCoherenceCatchup`, C-Q10), prioritaire.
 *   CAMPAGNE MANUELLE (MANUAL) — BO › Tâches planifiées › « Exécuter » quand
 *     aucune campagne n'est en cours : même code, mêmes règles.
 *   CONTRÔLES CIBLÉS (TARGETED) — au fil des changements : un événement
 *     métier (analyse T1, document, bien, agenda) marque les objets dépendants
 *     « à contrôler » (`events.ts`) ; regroupés (temporisation), contrôlés au
 *     passage suivant ; les contrôles en erreur sont repris (délai croissant).
 *
 * MODE : à blanc (DRY_RUN, défaut — aucune écriture métier) ou correctif
 * (CORRECTIVE), lu à la création de la campagne (`COHERENCE_CAMPAIGN_MODE`)
 * et figé pour sa durée (C-Q5 : première campagne à blanc, puis corrective).
 *
 * ÉLIGIBILITÉ (C-Q10) : vérifiée à l'entrée de chaque compte, puis avant la
 * première réparation de chaque lot ; un compte non éligible ne reçoit aucun
 * contrôle métier (motif consigné dans la campagne).
 * Lot 83E — SEULE EXCEPTION, à arbitrer par le PO (voir le rapport) : un
 * compte non éligible DU FAIT DE SON ABONNEMENT (essai échu, impayé,
 * abonnement terminé, lecture seule, rétractation, sans abonnement) est lu
 * par les seuls contrôles déclarés `ineligibleAccounts:
 * 'SUBSCRIPTION_STATE_READ'` (abonnement local comparé à Stripe, droits) :
 * LECTURE de l'état d'abonnement uniquement — aucun autre contrôle, aucun
 * traitement métier, aucun appel IA ; réparation neutralisée par le moteur,
 * SAUF (lot 84A, décision PO L83-Q1) celle des contrôles déclarés
 * `repairOnIneligibleBilling` : resynchronisation de l'abonnement depuis
 * Stripe, en mode correctif seulement ; la réactivation qui en découle passe
 * par le rattrapage 82A normal (`onAccountReactivated`). Compte suspendu,
 * neutralisé ou introuvable : rien du tout.
 *
 * SUPERVISION (C-Q3) : aucun onglet ; échecs de réparation, constats
 * persistants, erreurs répétées, réparations répétées et campagnes
 * partielles remontent dans la Supervision existante (`supervision.ts`).
 *
 * MESURES (C-Q1) : durée, CPU, mémoire, appels IA, objets contrôlés,
 * réparations — par campagne (`metrics`, `counters`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { addDaysToDateStr, todayParisDateStr } from '@/lib/notifications/time-paris';
import { parisWallTimeToDate } from '@/services/scheduling/task-calendar';
import { activeChecks, getCheck, registryVersion } from './registry';
import type { AccountScope, CheckContext, CoherenceCheck, CoherenceMode, ControlResult, Sql } from './registry/types';
import { RESOLVED_RESULTS } from './registry/types';
import { controlObjects, AccountNoLongerEligibleError, type BatchSummary } from './engine';
import { coherenceAccountEligibility } from './eligibility';
import { exec, intArray, rows, type Row } from './registry/util';

/** Objets contrôlés par lot. */
export const COHERENCE_BATCH = 50;
/** Temporisation d'une demande de contrôle ciblé (rafale d'événements regroupée). */
export const TARGETED_DEBOUNCE_MS = 2 * 60_000;
/** Demandes ciblées traitées au plus par passage. */
export const TARGETED_MAX_PER_RUN = 2_000;
/** Rétention des preuves d'objets qui ne sont plus contrôlés (objet disparu, compte sorti du périmètre). */
export const PROOF_RETENTION_DAYS = 35;
/** Rétention du journal des réparations et des campagnes. */
export const REPAIR_RETENTION_DAYS = 400;
export const CAMPAIGN_RETENTION_DAYS = 120;

export type CampaignKind = 'DAILY' | 'CATCHUP' | 'MANUAL';
export type CampaignStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED';

/** Mode des NOUVELLES campagnes (`COHERENCE_CAMPAIGN_MODE`) : à blanc par défaut ; valeur inconnue → à blanc. */
export function coherenceMode(env: Record<string, string | undefined> = process.env): CoherenceMode {
  const v = (env.COHERENCE_CAMPAIGN_MODE ?? '').trim().toLowerCase();
  return ['corrective', 'correctif', 'correction', 'repair'].includes(v) ? 'CORRECTIVE' : 'DRY_RUN';
}

export async function coherenceTablesReady(sql: Sql = pgClient): Promise<boolean> {
  try {
    const [r] = await rows(sql, `SELECT to_regclass('coherence_campaigns') IS NOT NULL AND to_regclass('coherence_object_proofs') IS NOT NULL
                                        AND to_regclass('coherence_repairs') IS NOT NULL AS ok`);
    return r?.ok === true;
  } catch { return false; }
}

const json = <T>(v: unknown, def: T): T => (v == null ? def : (typeof v === 'string' ? JSON.parse(v) : v) as T);

// ══ Campagnes ═══════════════════════════════════════════════════════════════

export interface CampaignRow {
  id: number; kind: CampaignKind; mode: CoherenceMode; status: CampaignStatus; phase: 'TRAVERSE' | 'VERIFY' | 'DONE';
  campaignDate: string | null; scope: number[] | null; trigger: string; startedAt: Date; deadlineAt: Date | null;
  cursorAccountId: number; cursorCheckIndex: number; cursorObjectId: number;
  accounts: CampaignAccounts; counters: Record<string, CheckCounters>; metrics: CampaignMetrics;
}

export interface CampaignAccounts {
  visited: number;
  /** Comptes non éligibles, par motif (jamais contrôlés, C-Q10). */
  skipped: Record<string, number>;
  /** Échantillon d'identifiants ignorés (≤ 50). */
  skippedIds?: number[];
  /**
   * Lot 83E (C-Q10) : comptes non éligibles du fait de leur abonnement, lus
   * par les seuls contrôles d'état d'abonnement (aussi comptés dans `skipped`
   * : aucun contrôle métier).
   */
  subscriptionStateRead?: number;
}

export interface CheckCounters {
  controlled: number;
  results: Partial<Record<ControlResult, number>>;
  durationMs: number;
  /** Phase VERIFY : objets attendus recomptés, objets sans contrôle réussi repris, restés en échec. */
  expected?: number;
  missingAtVerify?: number;
  remaining?: number;
}

export interface CampaignMetrics {
  runs: number;
  durationMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssPeakMb: number;
  aiCalls: number;
  repairsAttempted: number;
  objectsControlled: number;
}

/**
 * Lot 83E (C-Q10) : motifs d'inéligibilité qui tiennent à l'ABONNEMENT — seuls
 * ceux-là autorisent la lecture de l'état d'abonnement (jamais un compte
 * suspendu, neutralisé, introuvable ou d'éligibilité illisible).
 */
export const SUBSCRIPTION_STATE_REASONS: ReadonlySet<string> = new Set([
  'TRIAL_EXPIRED', 'UNPAID', 'SUBSCRIPTION_ENDED', 'READ_ONLY', 'NO_SUBSCRIPTION', 'WITHDRAWN',
]);

/**
 * Revérification juste avant une réparation (C-Q10), selon le périmètre du
 * compte. Compte éligible : règle 82A. Compte lu pour son état d'abonnement
 * (lot 84A, L83-Q1 : seule la resynchronisation Stripe d'un contrôle déclaré
 * `repairOnIneligibleBilling` y parvient — moteur) : permise tant que le
 * compte est éligible OU non éligible du seul fait de son abonnement ; un
 * compte devenu suspendu, archivé ou illisible arrête le parcours.
 */
export async function repairEligibilityFor(accountId: number, scope: AccountScope, now: Date): Promise<{ eligible: boolean; reason: string }> {
  const e = await coherenceAccountEligibility(accountId, now);
  if (e.eligible || scope === 'ELIGIBLE') return e;
  return SUBSCRIPTION_STATE_REASONS.has(e.reason) ? { eligible: true, reason: e.reason } : e;
}

/** Le contrôle peut-il s'exécuter dans ce périmètre de compte ? (pure) */
export function checkRunsInScope(check: Pick<CoherenceCheck, 'ineligibleAccounts'>, scope: AccountScope): boolean {
  return scope === 'ELIGIBLE' || check.ineligibleAccounts === 'SUBSCRIPTION_STATE_READ';
}

const zeroMetrics = (): CampaignMetrics => ({ runs: 0, durationMs: 0, cpuUserMs: 0, cpuSystemMs: 0, rssPeakMb: 0, aiCalls: 0, repairsAttempted: 0, objectsControlled: 0 });

function toCampaign(r: Row): CampaignRow {
  return {
    id: Number(r.id), kind: r.kind as CampaignKind, mode: r.mode as CoherenceMode, status: r.status as CampaignStatus, phase: r.phase as CampaignRow['phase'],
    campaignDate: r.campaign_date ? String(r.campaign_date).slice(0, 10) : null,
    scope: Array.isArray(r.scope_account_ids) ? (r.scope_account_ids as number[]).map(Number) : null,
    trigger: String(r.trigger_code), startedAt: new Date(r.started_at as string), deadlineAt: r.deadline_at ? new Date(r.deadline_at as string) : null,
    cursorAccountId: Number(r.cursor_account_id), cursorCheckIndex: Number(r.cursor_check_index), cursorObjectId: Number(r.cursor_object_id),
    accounts: { visited: 0, skipped: {}, ...json<Partial<CampaignAccounts>>(r.accounts, {}) },
    counters: json<Record<string, CheckCounters>>(r.counters, {}),
    metrics: { ...zeroMetrics(), ...json<Partial<CampaignMetrics>>(r.metrics, {}) },
  };
}

export async function getCampaign(id: number, sql: Sql = pgClient): Promise<CampaignRow | null> {
  const [r] = await rows(sql, `SELECT * FROM coherence_campaigns WHERE id = $1`, [id]);
  return r ? toCampaign(r) : null;
}

export interface StartCampaignInput {
  kind: CampaignKind;
  trigger: string;
  mode?: CoherenceMode;
  now?: Date;
  /** Comptes du périmètre (rattrapage, ou tests) ; absent : tous les comptes éligibles. */
  scopeAccountIds?: number[] | null;
  deadlineAt?: Date | null;
  sql?: Sql;
}

/** Échéance d'une campagne quotidienne : début de la suivante (5 h, Paris). */
export function dailyDeadline(now: Date): Date {
  return parisWallTimeToDate(addDaysToDateStr(todayParisDateStr(now), 1), [5, 0]);
}

/** Démarre une campagne (statut RUNNING). Rend son identifiant. */
export async function startCampaign(p: StartCampaignInput): Promise<number> {
  const sql = p.sql ?? pgClient;
  const now = p.now ?? new Date();
  const checks = activeChecks().map((c) => ({ id: c.id, version: c.version }));
  const [r] = await rows(sql, `
    INSERT INTO coherence_campaigns (kind, mode, campaign_date, scope_account_ids, trigger_code, registry_version, checks, started_at, deadline_at, metrics)
    VALUES ($1, $2, $3::date, $4::int[], $5, $6, $7::text::jsonb, $8, $9, $10::text::jsonb) RETURNING id`,
  [p.kind, p.mode ?? coherenceMode(), p.kind === 'DAILY' ? todayParisDateStr(now) : null, p.scopeAccountIds ? intArray(p.scopeAccountIds) : null,
    p.trigger, registryVersion(), JSON.stringify(checks), now,
    p.deadlineAt === undefined ? (p.kind === 'DAILY' ? dailyDeadline(now) : new Date(now.getTime() + 24 * 3_600_000)) : p.deadlineAt,
    JSON.stringify(zeroMetrics())]);
  return Number(r.id);
}

/**
 * Campagne quotidienne du jour (Paris) : créée si absente. Une campagne
 * quotidienne antérieure encore en cours est close PARTIAL (échéance passée).
 */
export async function ensureDailyCampaign(now: Date = new Date(), sql: Sql = pgClient): Promise<number> {
  const today = todayParisDateStr(now);
  const [r] = await rows(sql, `SELECT id FROM coherence_campaigns WHERE kind = 'DAILY' AND campaign_date = $1::date`, [today]);
  if (r) return Number(r.id);
  try {
    return await startCampaign({ kind: 'DAILY', trigger: 'schedule', now, sql });
  } catch (e) {
    // Course entre deux instances : l'index unique garde une seule campagne du jour.
    if ((e as { code?: string }).code === '23505') {
      const [x] = await rows(sql, `SELECT id FROM coherence_campaigns WHERE kind = 'DAILY' AND campaign_date = $1::date`, [today]);
      if (x) return Number(x.id);
    }
    throw e;
  }
}

/**
 * Rattrapage à la RÉACTIVATION d'un compte (C-Q10) : campagne exhaustive sur
 * ce seul compte, prioritaire sur la campagne quotidienne. Idempotent : une
 * campagne de rattrapage déjà en cours pour le compte est réutilisée.
 * Point d'entrée à raccorder à la réactivation (chantier 82A).
 */
export async function requestCoherenceCatchup(p: { accountId: number; reason: string; now?: Date; sql?: Sql }): Promise<number | null> {
  const sql = p.sql ?? pgClient;
  if (!(await coherenceTablesReady(sql))) return null;
  const [r] = await rows(sql, `
    SELECT id FROM coherence_campaigns WHERE kind = 'CATCHUP' AND status = 'RUNNING' AND scope_account_ids = ARRAY[$1]::int[] ORDER BY id DESC LIMIT 1`,
  [p.accountId]);
  if (r) return Number(r.id);
  return startCampaign({ kind: 'CATCHUP', trigger: `reactivation:${p.reason}`.slice(0, 120), scopeAccountIds: [p.accountId], now: p.now, sql });
}

/**
 * Étape de reprise à la RÉACTIVATION, au contrat de 82A
 * (`AccountReactivationStep`, `src/services/account/processing-lifecycle.ts`).
 * À l'intégration : `registerAccountReactivationStep('catchup-control', coherenceCatchupReactivationStep)`
 * au démarrage — elle remplace l'étape par défaut (T3 complète du compte) par
 * la campagne de rattrapage EXHAUSTIVE du compte (tous les contrôles du registre).
 */
export async function coherenceCatchupReactivationStep(ctx: { accountId: number; source: string; now: Date }): Promise<Record<string, unknown>> {
  const campaignId = await requestCoherenceCatchup({ accountId: ctx.accountId, reason: ctx.source, now: ctx.now });
  return { coherenceCatchupCampaignId: campaignId };
}

/** Compte suivant du périmètre (après `after`), non archivé, dans l'ordre des identifiants. */
async function nextAccount(sql: Sql, c: CampaignRow, after: number): Promise<number | null> {
  const [r] = await rows(sql, `
    SELECT id FROM accounts WHERE id > $1 AND ($2::int[] IS NULL OR id = ANY($2::int[])) ORDER BY id LIMIT 1`, [after, c.scope]);
  return r ? Number(r.id) : null;
}

async function saveProgress(sql: Sql, c: CampaignRow, extra: { errorSample?: string | null } = {}): Promise<void> {
  await exec(sql, 
    `UPDATE coherence_campaigns SET phase = $2, cursor_account_id = $3, cursor_check_index = $4, cursor_object_id = $5,
            accounts = $6::text::jsonb, counters = $7::text::jsonb, metrics = $8::text::jsonb, last_run_at = now(),
            error_sample = COALESCE($9, error_sample)
      WHERE id = $1`,
    [c.id, c.phase, c.cursorAccountId, c.cursorCheckIndex, c.cursorObjectId, JSON.stringify(c.accounts), JSON.stringify(c.counters),
      JSON.stringify(c.metrics), extra.errorSample ?? null],
  );
}

function compter(c: CampaignRow, check: CoherenceCheck, s: BatchSummary, verify: boolean): void {
  const k = (c.counters[check.id] ??= { controlled: 0, results: {}, durationMs: 0 });
  k.controlled += s.outcomes.length;
  k.durationMs += s.durationMs;
  for (const [r, n] of Object.entries(s.results)) k.results[r as ControlResult] = (k.results[r as ControlResult] ?? 0) + (n ?? 0);
  if (verify) {
    k.missingAtVerify = (k.missingAtVerify ?? 0) + s.outcomes.length;
    k.remaining = (k.remaining ?? 0) + s.outcomes.filter((o) => o.result === 'ERROR').length;
  }
  c.metrics.aiCalls += s.aiCalls;
  c.metrics.repairsAttempted += s.repairsAttempted;
  c.metrics.objectsControlled += s.outcomes.length;
}

function skip(c: CampaignRow, accountId: number, reason: string): void {
  c.accounts.skipped[reason] = (c.accounts.skipped[reason] ?? 0) + 1;
  c.accounts.skippedIds = [...(c.accounts.skippedIds ?? []), accountId].slice(-50);
}

export interface CampaignStepResult {
  campaignId: number;
  status: CampaignStatus;
  phase: string;
  controlled: number;
  done: boolean;
}

export interface RunOptions {
  deadline: number;
  now?: Date;
  sql?: Sql;
  /** Date civile de référence injectée (tests). */
  today?: string;
}

function contexte(c: CampaignRow | null, mode: CoherenceMode, sql: Sql, now: Date, today: string | undefined, check: CoherenceCheck, accountScope: AccountScope = 'ELIGIBLE'): CheckContext {
  return {
    sql, now, today: today ?? todayParisDateStr(now), mode, correlationId: `coherence:${c ? `${c.kind.toLowerCase()}-${c.id}` : 'targeted'}:${check.id}`, accountScope,
  };
}

/**
 * Un passage d'une campagne : avance jusqu'à `deadline`, curseur en base.
 * Rend `done` quand la campagne est close (COMPLETE / PARTIAL / FAILED).
 */
export async function runCampaignStep(campaignId: number, o: RunOptions): Promise<CampaignStepResult> {
  const sql = o.sql ?? pgClient;
  const now = o.now ?? new Date();
  const c = await getCampaign(campaignId, sql);
  if (!c) throw new Error(`campagne de cohérence ${campaignId} introuvable`);
  if (c.status !== 'RUNNING') return { campaignId, status: c.status, phase: c.phase, controlled: 0, done: true };
  if (c.deadlineAt && now.getTime() > c.deadlineAt.getTime()) {
    await finalize(sql, c, now, 'DEADLINE');
    return { campaignId, status: 'PARTIAL', phase: c.phase, controlled: 0, done: true };
  }
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const checks = activeChecks();
  let controlled = 0;
  let errorSample: string | null = null;
  let eligibleAccount: number | null = null;
  let scope: AccountScope = 'ELIGIBLE';
  const lectureAbonnement = checks.some((x) => x.ineligibleAccounts === 'SUBSCRIPTION_STATE_READ');
  try {
    while (Date.now() < o.deadline) {
      if (c.cursorAccountId === 0) {
        eligibleAccount = null;
        const next = await nextAccount(sql, c, 0);
        if (next === null) { if (await endOfPhase(sql, c, now)) break; continue; }
        c.cursorAccountId = next; c.cursorCheckIndex = 0; c.cursorObjectId = 0;
      }
      const accountId = c.cursorAccountId;
      // Éligibilité à l'EXÉCUTION (C-Q10) : vérifiée à chaque reprise du compte.
      if (eligibleAccount !== accountId) {
        const e = await coherenceAccountEligibility(accountId, now);
        if (!e.eligible) {
          // Lot 83E (C-Q10) : non éligible du fait de l'abonnement → lecture de l'état d'abonnement seule.
          const lecture = lectureAbonnement && SUBSCRIPTION_STATE_REASONS.has(e.reason);
          if (c.cursorCheckIndex === 0 && c.cursorObjectId === 0 && c.phase === 'TRAVERSE') {
            skip(c, accountId, e.reason);
            if (lecture) c.accounts.subscriptionStateRead = (c.accounts.subscriptionStateRead ?? 0) + 1;
          }
          if (!lecture) {
            if (await advanceAccount(sql, c, now)) break;
            continue;
          }
          scope = 'SUBSCRIPTION_STATE_READ';
        } else {
          scope = 'ELIGIBLE';
        }
        eligibleAccount = accountId;
      }
      const check = checks[c.cursorCheckIndex];
      if (!check) {
        if (c.phase === 'TRAVERSE' && scope === 'ELIGIBLE') c.accounts.visited += 1;
        eligibleAccount = null;
        if (await advanceAccount(sql, c, now)) break;
        continue;
      }
      if (!checkRunsInScope(check, scope)) {
        // Contrôle métier : jamais exécuté sur un compte non éligible (C-Q10).
        c.cursorCheckIndex += 1; c.cursorObjectId = 0;
        continue;
      }
      const ctx = contexte(c, c.mode, sql, new Date(now.getTime() + (Date.now() - t0)), o.today ?? todayParisDateStr(now), check, scope);
      const page = await check.listObjects!(ctx, accountId, c.cursorObjectId, COHERENCE_BATCH);
      if (!page.length) { c.cursorCheckIndex += 1; c.cursorObjectId = 0; await saveProgress(sql, c); continue; }
      let cible = page;
      if (c.phase === 'VERIFY') {
        const k = (c.counters[check.id] ??= { controlled: 0, results: {}, durationMs: 0 });
        k.expected = (k.expected ?? 0) + page.length;
        const ok = new Set((await rows(sql, `
          SELECT object_id FROM coherence_object_proofs WHERE account_id = $1 AND check_id = $2 AND object_id = ANY($3::bigint[]) AND last_success_at >= $4`,
        [accountId, check.id, page, c.startedAt])).map((x) => Number(x.object_id)));
        cible = page.filter((id) => !ok.has(id));
      }
      if (cible.length) {
        const portee = scope;
        try {
          const s = await controlObjects({
            ctx, check, accountId, ids: cible, trigger: c.kind === 'DAILY' ? 'DAILY' : c.kind, campaignId: c.id,
            // Lecture d'état d'abonnement (lot 83E) : seule une réparation déclarée `repairOnIneligibleBilling`
            // (lot 84A, L83-Q1) y est tentée (moteur) ; jamais sur un compte devenu suspendu ou archivé.
            stillEligible: () => repairEligibilityFor(accountId, portee, ctx.now),
          });
          compter(c, check, s, c.phase === 'VERIFY');
          controlled += s.outcomes.length;
          const err = s.outcomes.find((x) => x.result === 'ERROR');
          if (err) errorSample ??= `compte ${accountId} · ${check.id} · objet ${err.id} — ${err.error ?? 'erreur'}`.slice(0, 500);
        } catch (e) {
          if (e instanceof AccountNoLongerEligibleError) {
            // Le compte a perdu son éligibilité en cours de parcours : arrêt immédiat, aucune réparation.
            skip(c, accountId, `${e.reason}_DURING_CAMPAIGN`);
            eligibleAccount = null;
            if (await advanceAccount(sql, c, now)) break;
            continue;
          }
          throw e;
        }
      }
      c.cursorObjectId = page[page.length - 1];
      await saveProgress(sql, c, { errorSample });
    }
  } catch (e) {
    errorSample = `${String((e as Error).message).slice(0, 400)}`;
    await saveProgress(sql, c, { errorSample });
    throw e;
  } finally {
    const cpu = process.cpuUsage(cpu0);
    c.metrics.runs += 1;
    c.metrics.durationMs += Date.now() - t0;
    c.metrics.cpuUserMs += Math.round(cpu.user / 1000);
    c.metrics.cpuSystemMs += Math.round(cpu.system / 1000);
    c.metrics.rssPeakMb = Math.max(c.metrics.rssPeakMb, Math.round(process.memoryUsage().rss / 1_048_576));
    await exec(sql, `UPDATE coherence_campaigns SET metrics = $2::text::jsonb, runs = runs + 1, last_run_at = now() WHERE id = $1`, [c.id, JSON.stringify(c.metrics)]);
  }
  const fin = await getCampaign(c.id, sql);
  return { campaignId: c.id, status: fin!.status, phase: fin!.phase, controlled, done: fin!.status !== 'RUNNING' };
}

/** Compte suivant ; rend vrai si la campagne est terminée. */
async function advanceAccount(sql: Sql, c: CampaignRow, now: Date): Promise<boolean> {
  const next = await nextAccount(sql, c, c.cursorAccountId);
  if (next === null) return endOfPhase(sql, c, now);
  c.cursorAccountId = next; c.cursorCheckIndex = 0; c.cursorObjectId = 0;
  await saveProgress(sql, c);
  return false;
}

/** Fin du parcours d'une phase : TRAVERSE → VERIFY ; VERIFY → clôture. Rend vrai si close. */
async function endOfPhase(sql: Sql, c: CampaignRow, now: Date): Promise<boolean> {
  if (c.phase === 'TRAVERSE') {
    c.phase = 'VERIFY'; c.cursorAccountId = 0; c.cursorCheckIndex = 0; c.cursorObjectId = 0;
    await saveProgress(sql, c);
    return false;
  }
  await finalize(sql, c, now, 'END');
  return true;
}

/**
 * Clôture : bilan EXACT recalculé depuis les preuves (contrôles ACHEVÉS depuis
 * le début de la campagne, périmètre), couverture par contrôle. COMPLETE si
 * la vérification a recompté tous les objets attendus et qu'aucun n'est resté
 * sans contrôle réussi ; PARTIAL sinon (échéance, erreurs restantes).
 */
async function finalize(sql: Sql, c: CampaignRow, now: Date, why: 'END' | 'DEADLINE'): Promise<void> {
  const parResultat = await rows(sql, `
    SELECT check_id, last_result, count(*)::int AS n FROM coherence_object_proofs
     WHERE last_completed_at >= $1 AND ($2::int[] IS NULL OR account_id = ANY($2::int[]))
     GROUP BY check_id, last_result`, [c.startedAt, c.scope]);
  const bilan: Record<string, Partial<Record<ControlResult, number>>> = {};
  for (const r of parResultat) (bilan[String(r.check_id)] ??= {})[r.last_result as ControlResult] = Number(r.n);
  const coverage: Record<string, unknown> = {};
  let restants = 0;
  for (const ch of activeChecks()) {
    const k = c.counters[ch.id] ?? { controlled: 0, results: {}, durationMs: 0 };
    const remaining = why === 'END' ? (k.remaining ?? 0) : null;
    if (remaining) restants += remaining;
    coverage[ch.id] = {
      version: ch.version, expected: why === 'END' ? (k.expected ?? 0) : null, missingAtVerify: k.missingAtVerify ?? 0, remaining,
      results: bilan[ch.id] ?? {},
      findingsOpen: Object.entries(bilan[ch.id] ?? {}).filter(([r]) => !RESOLVED_RESULTS.has(r as ControlResult) && r !== 'ERROR').reduce((n, [, v]) => n + (v ?? 0), 0),
    };
  }
  const status: CampaignStatus = why === 'DEADLINE' || restants > 0 ? 'PARTIAL' : 'COMPLETE';
  const remaining = status === 'PARTIAL'
    ? { reason: why === 'DEADLINE' ? 'DEADLINE_REACHED' : 'OBJECTS_STILL_FAILING', phase: c.phase, cursorAccountId: c.cursorAccountId,
        cursorCheckIndex: c.cursorCheckIndex, cursorObjectId: c.cursorObjectId, failingObjects: restants }
    : null;
  await exec(sql, 
    `UPDATE coherence_campaigns SET status = $2, phase = 'DONE', finished_at = $3, coverage = $4::text::jsonb, remaining = $5::text::jsonb,
            accounts = $6::text::jsonb, counters = $7::text::jsonb, last_run_at = now() WHERE id = $1 AND status = 'RUNNING'`,
    [c.id, status, now, JSON.stringify(coverage), remaining ? JSON.stringify(remaining) : null, JSON.stringify(c.accounts), JSON.stringify(c.counters)],
  );
  c.status = status;
  c.phase = 'DONE';
}

// ══ Contrôles ciblés ════════════════════════════════════════════════════════

export interface TargetedResult {
  processed: number;
  results: Partial<Record<ControlResult, number>>;
  skippedAccounts: number;
  aiCalls: number;
}

/**
 * Contrôles CIBLÉS : objets marqués par un changement (temporisés) et
 * contrôles en erreur dont la reprise est due. Comptes non éligibles : les
 * demandes sont abandonnées (le rattrapage de réactivation les couvrira).
 */
export async function runTargetedChecks(o: RunOptions & { mode?: CoherenceMode; limit?: number }): Promise<TargetedResult> {
  const sql = o.sql ?? pgClient;
  const now = o.now ?? new Date();
  const t0 = Date.now();
  const out: TargetedResult = { processed: 0, results: {}, skippedAccounts: 0, aiCalls: 0 };
  const lots = await rows(sql, `
    SELECT account_id, check_id, array_agg(object_id ORDER BY object_id) AS ids FROM (
      SELECT account_id, check_id, object_id FROM coherence_object_proofs
       WHERE (requested_at IS NOT NULL AND requested_at <= $1) OR (next_retry_at IS NOT NULL AND next_retry_at <= $2)
       ORDER BY COALESCE(requested_at, next_retry_at) LIMIT $3) x
     GROUP BY account_id, check_id ORDER BY account_id, check_id`,
  [new Date(now.getTime() - TARGETED_DEBOUNCE_MS), now, o.limit ?? TARGETED_MAX_PER_RUN]);
  const eligibilite = new Map<number, { eligible: boolean; reason: string }>();
  for (const lot of lots) {
    if (Date.now() >= o.deadline) break;
    const accountId = Number(lot.account_id);
    const ids = (lot.ids as Array<number | string>).map(Number);
    const check = getCheck(String(lot.check_id));
    if (!eligibilite.has(accountId)) eligibilite.set(accountId, await coherenceAccountEligibility(accountId, now));
    if (!check || check.status !== 'ACTIVE' || !eligibilite.get(accountId)!.eligible) {
      // Contrôle retiré du registre, ou compte non éligible (C-Q10) : la demande n'est pas exécutée.
      await exec(sql, 
        `UPDATE coherence_object_proofs SET requested_at = NULL, next_retry_at = NULL,
                request_reason = CASE WHEN requested_at IS NULL THEN request_reason ELSE $4 END
          WHERE account_id = $1 AND check_id = $2 AND object_id = ANY($3::bigint[])`,
        [accountId, String(lot.check_id), ids, `abandonnée : ${check ? eligibilite.get(accountId)!.reason : 'contrôle hors registre'}`],
      );
      if (check) out.skippedAccounts += 1;
      continue;
    }
    for (let i = 0; i < ids.length && Date.now() < o.deadline; i += COHERENCE_BATCH) {
      const ctx = contexte(null, o.mode ?? coherenceMode(), sql, new Date(now.getTime() + (Date.now() - t0)), o.today, check);
      try {
        const s = await controlObjects({
          ctx, check, accountId, ids: ids.slice(i, i + COHERENCE_BATCH), trigger: 'TARGETED', campaignId: null,
          stillEligible: () => coherenceAccountEligibility(accountId, ctx.now),
        });
        out.processed += s.outcomes.length;
        out.aiCalls += s.aiCalls;
        for (const [r, n] of Object.entries(s.results)) out.results[r as ControlResult] = (out.results[r as ControlResult] ?? 0) + (n ?? 0);
      } catch (e) {
        if (e instanceof AccountNoLongerEligibleError) { eligibilite.set(accountId, { eligible: false, reason: e.reason }); break; }
        throw e;
      }
    }
  }
  return out;
}

/**
 * Demande de contrôle ciblé (objets dépendants d'un changement). Comptes non
 * éligibles : rien n'est demandé (C-Q10, vérifié à la mise en file).
 */
export async function requestTargetedChecks(p: {
  accountId: number; event: { type: string; entityId: number | null; assetId?: number | null }; now?: Date; sql?: Sql; skipEligibility?: boolean;
  /** Lot 83B : contrôles à ne pas redemander (propagation aval demandée par une réparation : jamais le contrôle réparateur lui-même). */
  excludeChecks?: readonly string[];
}): Promise<Record<string, number>> {
  const sql = p.sql ?? pgClient;
  const now = p.now ?? new Date();
  const out: Record<string, number> = {};
  const exclus = new Set(p.excludeChecks ?? []);
  const checks = activeChecks().filter((c) => c.triggers.includes(p.event.type) && c.objectsForEvent && !exclus.has(c.id));
  if (!checks.length) return out;
  if (!p.skipEligibility && !(await coherenceAccountEligibility(p.accountId, now)).eligible) return out;
  for (const check of checks) {
    const ctx = contexte(null, 'DRY_RUN', sql, now, undefined, check);
    const ids = intArray(await check.objectsForEvent!(ctx, p.accountId, p.event));
    if (!ids.length) continue;
    await exec(sql, 
      `INSERT INTO coherence_object_proofs (account_id, check_id, object_id, object_type, rules_version, registry_version, requested_at, request_reason)
       SELECT $1::int, $2::text, x, $3::text, $4::int, $5::text, $6::timestamptz, $7::text FROM unnest($8::bigint[]) AS x
       ON CONFLICT (account_id, check_id, object_id) DO UPDATE
          SET requested_at = GREATEST(coherence_object_proofs.requested_at, EXCLUDED.requested_at), request_reason = EXCLUDED.request_reason`,
      [p.accountId, check.id, check.objectType, check.version, registryVersion(), now, `${p.event.type}:${p.event.entityId ?? ''}`.slice(0, 120), ids],
    );
    out[check.id] = ids.length;
  }
  return out;
}

// ══ Tâche planifiée ═════════════════════════════════════════════════════════

/** Rétention bornée : preuves d'objets plus contrôlés, journal ancien, campagnes anciennes. */
export async function purgeCoherenceHistory(now: Date = new Date(), sql: Sql = pgClient): Promise<{ proofs: number; repairs: number; campaigns: number }> {
  const proofs = await rows(sql, `
    DELETE FROM coherence_object_proofs WHERE ctid IN (
      SELECT ctid FROM coherence_object_proofs
       WHERE requested_at IS NULL AND COALESCE(last_completed_at, last_started_at, '-infinity'::timestamptz) < $1 LIMIT 5000) RETURNING 1`,
  [new Date(now.getTime() - PROOF_RETENTION_DAYS * 86_400_000)]);
  const repairs = await rows(sql, `DELETE FROM coherence_repairs WHERE id IN (SELECT id FROM coherence_repairs WHERE created_at < $1 LIMIT 5000) RETURNING 1`,
    [new Date(now.getTime() - REPAIR_RETENTION_DAYS * 86_400_000)]);
  const campaigns = await rows(sql, `DELETE FROM coherence_campaigns WHERE status <> 'RUNNING' AND started_at < $1 RETURNING 1`,
    [new Date(now.getTime() - CAMPAIGN_RETENTION_DAYS * 86_400_000)]);
  return { proofs: proofs.length, repairs: repairs.length, campaigns: campaigns.length };
}

export interface CoherenceTaskResult {
  disabled?: boolean;
  note: string;
  campaigns: CampaignStepResult[];
  targeted: TargetedResult | null;
}

/**
 * Tâche planifiée `coherence-control` : rattrapages de réactivation, puis
 * contrôles ciblés, puis campagne en cours (manuelle ou quotidienne du jour),
 * supervision et rétention. Budget borné par `deadline`.
 */
export async function runCoherenceControl(o: RunOptions & { trigger: 'schedule' | 'manual' | 'startup' }): Promise<CoherenceTaskResult> {
  const sql = o.sql ?? pgClient;
  const now = o.now ?? new Date();
  if (!(await coherenceTablesReady(sql))) return { disabled: true, note: 'migration 0644 absente : contrôle de cohérence inactif', campaigns: [], targeted: null };
  const steps: CampaignStepResult[] = [];
  const reste = () => o.deadline - Date.now();

  // 1. Rattrapages de réactivation (prioritaires, C-Q10).
  for (const r of await rows(sql, `SELECT id FROM coherence_campaigns WHERE kind = 'CATCHUP' AND status = 'RUNNING' ORDER BY id`)) {
    if (reste() <= 0) break;
    steps.push(await runCampaignStep(Number(r.id), { ...o, sql, now, deadline: Math.min(o.deadline, Date.now() + Math.max(30_000, reste() / 3)) }));
  }
  // 2. Contrôles ciblés au fil des changements (temporisés).
  const targeted = reste() > 0 ? await runTargetedChecks({ ...o, sql, now, deadline: Math.min(o.deadline, Date.now() + Math.max(30_000, reste() / 3)) }) : null;
  // 3. Campagne exhaustive : manuelle en cours (ou demandée depuis le BO), sinon quotidienne du jour.
  let [enCours] = await rows(sql, `SELECT id FROM coherence_campaigns WHERE kind IN ('MANUAL', 'DAILY') AND status = 'RUNNING' ORDER BY (kind = 'MANUAL') DESC, id LIMIT 1`);
  if (o.trigger === 'manual' && !enCours) enCours = { id: await startCampaign({ kind: 'MANUAL', trigger: 'manual', now, sql }) };
  // La campagne quotidienne du jour est créée même si une précédente est encore en cours (celle-ci sera close PARTIAL à son échéance).
  const daily = await ensureDailyCampaign(now, sql);
  const ids = [...new Set([...(enCours ? [Number(enCours.id)] : []), daily])];
  for (const id of ids) {
    if (reste() <= 0) break;
    steps.push(await runCampaignStep(id, { ...o, sql, now }));
  }
  // Campagnes quotidiennes antérieures encore ouvertes : closes PARTIAL à leur échéance.
  for (const r of await rows(sql, `SELECT id FROM coherence_campaigns WHERE status = 'RUNNING' AND deadline_at < $1`, [now])) {
    steps.push(await runCampaignStep(Number(r.id), { ...o, sql, now, deadline: Date.now() }));
  }
  // 4. Supervision (C-Q3) et rétention.
  const { syncCoherenceSupervision } = await import('./supervision');
  const sup = await syncCoherenceSupervision({ now, sql });
  const purge = await purgeCoherenceHistory(now, sql);
  const note = [
    ...steps.map((s) => `campagne ${s.campaignId} ${s.status}/${s.phase} : ${s.controlled} objet(s)`),
    targeted ? `ciblés : ${targeted.processed} objet(s) ${JSON.stringify(targeted.results)}` : null,
    `supervision : ${sup.reported} signalement(s), ${sup.resolved} résolu(s)`,
    purge.proofs + purge.repairs + purge.campaigns > 0 ? `rétention : ${JSON.stringify(purge)}` : null,
  ].filter(Boolean).join(' — ');
  return { note, campaigns: steps, targeted };
}
