/**
 * Lot 113I — CDC V2 « amélioration automatique IA » : recette E2E sur PostgreSQL 16 RÉEL (schéma complet, transactions
 * sur connexions distinctes du pool, verrous consultatifs), fournisseur simulé.
 *
 *   L113I-E01  migrations 1485-1489 rejouables ; tables classées (diagnostic, recette, restauration)
 *   L113I-E02  promotion CIBLÉE : T6 puis T3 promus, deltas fusionnés dans UNE version active, T1/T2/T4 inchangés
 *              (REC-063, TX-01, SQL-005) ; double demande idempotente (REC-069)
 *   L113I-E03  promotions CONCURRENTES T1 / T2 sur deux connexions : sérialisées, les deux deltas présents (TST-002)
 *   L113I-E04  référence du traitement changée par un administrateur → CANDIDATE_STALE, rien d'écrit (REC-065, MAN-03)
 *   L113I-E05  retour arrière CIBLÉ de T3 alors que T6 a changé depuis : T6 conservé (REC-071, TX-02) ; idempotent
 *   L113I-E06  geste humain après promotion → retour arrière refusé, surveillance REPLACED (REC-072, SQL-009)
 *   L113I-E07  surveillance : J+7 sans usage → INSUFFICIENT_USAGE, candidate active, aucun rejeu ; reprise J+30 →
 *              VALIDATED_IN_USAGE (WATCH-01, REC-074..077) ; promotion d'un AUTRE traitement : surveillance maintenue (REC-070)
 *   L113I-E08  budget : deux réservations concurrentes pour le dernier euro, 20 fois → une seule (BUDT-01, REC-026)
 *   L113I-E09  budget : expérimentation épuisée, surveillance disponible (BUDT-03, REC-033) ; alertes 50 / 75 dédupliquées (REC-031)
 *   L113I-E10  budget : réservation orpheline → non rapprochée, bloque ; coût tracé → réglée (BUDT-02, REC-088, REC-029)
 *   L113I-E11  moteur de qualification : budget refusé → zéro appel fournisseur (REC-027) ; financé → appel, règlement
 *   L113I-E12  objectifs : même événement deux fois en concurrence → un objectif (REC-020, LIF-009) ; 3 variantes max
 *              (REC-023) ; transition impossible → code métier (LIF-004)
 *   L113I-E13  BO / API : politique (conflit de révision 409, audit), budget, suspension d'objectif, droits
 *   L113I-E14  reprise des surveillances historiques → LEGACY_OBSERVATION_UNKNOWN (DATA-07, migration 1489)
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l113i@e2e.test', role: 'ADMIN' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => { if (session.role !== 'ADMIN') throw Object.assign(new Error('forbidden'), { status: 403 }); return session.adminId; },
    getSession: async () => ({ userId: session.adminId, email: session.email, role: session.role }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

type Json = Record<string, any>;
type T = 'T1' | 'T2' | 'T3' | 'T4' | 'T6';

scenario('L113I', 'Amélioration automatique IA — CDC V2 (promotion ciblée, budget, surveillance, objectifs)', ({ sql, make }) => {
  let adminId = 0;
  let env = 'local';
  let activeAvant: number[] = [];
  let base = 0;
  let accId = 0;

  const repo = async () => import('@/services/ai/config/config-version.repository');
  const actif = async () => Number((await sql<Json[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].id);
  const snapshotActif = async () => (await sql<Json[]>`SELECT r.snapshot FROM ai_config_versions v JOIN ai_config_revisions r ON r.id = v.current_revision_id WHERE v.environment = ${env} AND v.status = 'ACTIVE'`)[0].snapshot;
  const modele = async (t: T) => ((await snapshotActif()).entries as Json[]).find((e) => e.treatment === t)?.primaryModel ?? null;
  const empreintes = async () => {
    const { treatmentFingerprint, normalizeSnapshot } = await import('@/services/ai/config/config-snapshot');
    const s = normalizeSnapshot(await snapshotActif());
    return Object.fromEntries((['T1', 'T2', 'T3', 'T4', 'T6'] as T[]).map((t) => [t, treatmentFingerprint(s, t)]));
  };
  /** Candidate automatique QUALIFIÉE ne changeant que le modèle principal de `t` (copie de l'active courante). */
  const candidate = async (t: T, model: string) => {
    const r = await repo();
    const v = await r.createVersion({
      userId: null, label: `e2e-l113i ${t} ${model}`, source: { active: true },
      candidate: { key: `e2e-l113i:${t}:${model}:${Date.now()}:${Math.random()}`, reason: 'e2e l113i', campaignId: null, treatment: t, transform: (s) => ({ ...s, entries: s.entries.map((e) => (e.treatment === t ? { ...e, primaryModel: model } : e)) }) },
    });
    await r.setCandidateState(v.id, 'QUALIFIED');
    return v.id;
  };
  const promouvoir = async (id: number, operations = ['t6_formulate']) => {
    const r = await repo();
    const { initialWatch } = await import('@/services/ai/qualification/promotion-watch');
    return r.promoteTreatment(id, { watch: (t) => initialWatch(t, { campaignId: null, operations, previousVersionId: t.globalActiveBefore?.versionId ?? null }) as unknown as Record<string, unknown> });
  };
  const promo = async (id: number) => (await sql<Json[]>`SELECT status, candidate_state, candidate_promotion FROM ai_config_versions WHERE id = ${id}`)[0];
  const politique = async (o: Record<string, unknown>) => {
    const { loadPolicy, savePolicy } = await import('@/services/ai/qualification/improvement-policy');
    const p = await loadPolicy(env);
    return savePolicy({ input: { ...p, ...o }, expectedVersion: p.version, userId: adminId, reason: 'e2e l113i', environment: env });
  };
  const borne = (eurMicros: number) => ({ ok: true as const, maxEurMicros: eurMicros, quotedCurrency: 'EUR', quotedMicros: eurMicros, fx: null, detail: { inputTokens: 1, outputTokens: 1, attempts: 1, safetyMultiplier: 1 } });
  const rempli = async (month: string, phase: 'EXPERIMENT' | 'MONITOR', eurMicros: number) =>
    sql`INSERT INTO ai_improvement_budget_reservations (environment, budget_month, phase, purpose, attempt_key, quoted_currency, quoted_max_micros, max_eur_micros, state, settled_eur_micros, cost_status)
        VALUES (${env}, ${month}, ${phase}, 'VALIDATION', ${`fill:${month}:${phase}:${Math.random()}`}, 'EUR', ${eurMicros}, ${eurMicros}, 'SETTLED', ${eurMicros}, 'KNOWN')`;

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN', email: session.email });
    adminId = admin.id;
    session.adminId = admin.id;
    accId = (await make.account()).id;
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
    const r = await repo();
    const v = await r.createVersion({ userId: adminId, label: 'e2e-l113i base', source: null });
    await r.writeSnapshot({
      versionId: v.id, kind: 'save', userId: adminId,
      next: (s) => ({ ...s, entries: s.entries.map((e) => ({ ...e, primaryModel: `base-${e.treatment.toLowerCase()}`, fallback1: null, fallback2: null })) }),
    });
    await r.activateVersion(v.id, adminId);
    base = v.id;
  }, 120_000);

  afterAll(async () => {
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = ${env} AND status = 'ACTIVE'`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE' WHERE id = ANY(${activeAvant})`;
    (await import('@/services/ai/gateway/pricing/pricing.repository')).clearPricingCache();
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
  });

  it('L113I-E01 — migrations 1485-1489 rejouables ; tables classées', async () => {
    for (const f of ['1485_l113i_objectifs_amelioration.sql', '1486_l113i_budget_amelioration.sql', '1487_l113i_politique_amelioration.sql', '1488_l113i_journal_promotion_ciblee.sql', '1489_l113i_reprise_surveillances.sql']) {
      for (let i = 0; i < 2; i += 1) await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations', f), 'utf8')); });
    }
    for (const t of ['ai_improvement_objectives', 'ai_improvement_budget_reservations', 'ai_improvement_policy_revisions']) {
      expect((await sql<Json[]>`SELECT to_regclass(${t}) AS t`)[0].t).toBe(t);
    }
    const def = (await sql<Json[]>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ai_promotion_events_kind_chk'`)[0].d as string;
    expect(def).toMatch(/TARGETED_ROLLBACK/);
    const { DIAG_TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    const { RECETTE_EXCLUDED } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { RESTORE_KEEP_CURRENT_TABLES } = await import('@/services/backup/schema-signature');
    for (const t of ['ai_improvement_objectives', 'ai_improvement_budget_reservations', 'ai_improvement_policy_revisions']) {
      expect(DIAG_TABLE_COVERAGE[t]?.transversal).toBeTruthy();
      expect(RECETTE_EXCLUDED[t]).toMatch(/qualification IA/);
      expect(RESTORE_KEEP_CURRENT_TABLES).toContain(t);
    }
  });

  it('L113I-E02 — promotions ciblées T6 puis T3 : une seule version active, deltas fusionnés, autres traitements inchangés ; double demande idempotente', async () => {
    const avant = await empreintes();
    const c6 = await candidate('T6', 'cand-t6-a');
    const c3 = await candidate('T3', 'cand-t3-a');
    const r6 = await promouvoir(c6);
    expect(r6.alreadyActive).toBe(false);
    expect(r6.targeted).toMatchObject({ treatment: 'T6', axes: ['MODEL'], globalActiveBefore: { versionId: base } });
    // T3 a été qualifiée sur la configuration d'AVANT la promotion de T6 : sa référence T3 est inchangée → fusion.
    const r3 = await promouvoir(c3);
    expect(r3.alreadyActive).toBe(false);
    expect(await actif()).toBe(c3);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].n).toBe(1);
    expect(await modele('T6')).toBe('cand-t6-a');
    expect(await modele('T3')).toBe('cand-t3-a');
    const apres = await empreintes();
    for (const t of ['T1', 'T2', 'T4'] as T[]) expect(apres[t]).toBe(avant[t]);
    // Surveillance persistée DANS la transaction (SQL-006), état antérieur du traitement conservé (PRO-05).
    const p3 = await promo(c3);
    expect(p3.candidate_state).toBe('ACTIVATED');
    expect(p3.candidate_promotion.watch).toMatchObject({ status: 'WATCHING', treatment: 'T3', fingerprint: apres.T3 });
    expect(p3.candidate_promotion.targeted.previous.entry.primaryModel).toBe('base-t3');
    // Double demande / relance après commit : aucune seconde version effective (REC-069).
    const bis = await promouvoir(c3);
    expect(bis.alreadyActive).toBe(true);
    expect(await actif()).toBe(c3);
  });

  it('L113I-E03 — promotions concurrentes de deux traitements sur deux connexions : sérialisées, les deux deltas présents (TST-002)', async () => {
    const c1 = await candidate('T1', 'cand-t1-a');
    const c2 = await candidate('T2', 'cand-t2-a');
    const avant = await empreintes();
    const [a, b] = await Promise.all([promouvoir(c1), promouvoir(c2)]);
    expect([a.alreadyActive, b.alreadyActive]).toEqual([false, false]);
    expect(await modele('T1')).toBe('cand-t1-a');
    expect(await modele('T2')).toBe('cand-t2-a');
    const apres = await empreintes();
    for (const t of ['T3', 'T4', 'T6'] as T[]) expect(apres[t]).toBe(avant[t]);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].n).toBe(1);
  });

  it('L113I-E04 — référence du traitement modifiée par un administrateur pendant la qualification → CANDIDATE_STALE, rien d’écrit', async () => {
    const c4 = await candidate('T4', 'cand-t4-a');
    const r = await repo();
    const a = await actif();
    await r.writeSnapshot({ versionId: a, kind: 'save', userId: adminId, next: (s) => ({ ...s, entries: s.entries.map((e) => (e.treatment === 'T4' ? { ...e, primaryModel: 'admin-t4' } : e)) }) });
    const avant = await empreintes();
    await expect(promouvoir(c4)).rejects.toMatchObject({ code: 'CANDIDATE_STALE' });
    expect(await actif()).toBe(a);
    expect(await empreintes()).toEqual(avant);
    expect((await promo(c4)).candidate_state).toBe('QUALIFIED');
  });

  it('L113I-E05 — retour arrière CIBLÉ de T3 après une promotion de T6 : T6 conservé, aucune ancienne version réactivée ; idempotent', async () => {
    const c3 = await candidate('T3', 'cand-t3-b');
    await promouvoir(c3);
    const c6 = await candidate('T6', 'cand-t6-b');
    await promouvoir(c6);
    expect(await modele('T6')).toBe('cand-t6-b');
    const avant = await empreintes();
    const svc = await import('@/services/ai/config/config-version.service');
    const r = await svc.rollbackPromotedTreatment(c3, { reason: 'régression certifiée (scène)', evidence: { scene: true } });
    expect(r.status).toBe('ROLLED_BACK');
    expect(await actif()).toBe(c6); // la version globale courante reste active (nouvelle révision)
    expect(await modele('T3')).toBe('cand-t3-a');
    expect(await modele('T6')).toBe('cand-t6-b');
    const apres = await empreintes();
    for (const t of ['T1', 'T2', 'T4', 'T6'] as T[]) expect(apres[t]).toBe(avant[t]);
    const p = await promo(c3);
    expect(p).toMatchObject({ candidate_state: 'SUSPENDED' });
    expect(p.candidate_promotion.watch).toMatchObject({ status: 'ROLLED_BACK' });
    expect((await sql<Json[]>`SELECT kind FROM ai_config_revisions WHERE id = (SELECT current_revision_id FROM ai_config_versions WHERE id = ${c6})`)[0].kind).toBe('restore');
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM ai_promotion_events WHERE kind = 'TARGETED_ROLLBACK' AND candidate_version_id = ${c3}`)[0].n).toBe(1);
    expect((await svc.rollbackPromotedTreatment(c3, { reason: 'relance' })).status).toBe('ALREADY_ROLLED_BACK');
  });

  it('L113I-E06 — geste humain après la promotion : retour arrière refusé, surveillance REPLACED, révision humaine conservée', async () => {
    const c4 = await candidate('T4', 'cand-t4-b');
    await promouvoir(c4);
    const r = await repo();
    await r.writeSnapshot({ versionId: await actif(), kind: 'save', userId: adminId, next: (s) => ({ ...s, entries: s.entries.map((e) => (e.treatment === 'T4' ? { ...e, primaryModel: 'admin-t4-bis' } : e)) }) });
    const svc = await import('@/services/ai/config/config-version.service');
    const out = await svc.rollbackPromotedTreatment(c4, { reason: 'ancienne surveillance' });
    expect(out.status).toBe('REPLACED');
    expect(await modele('T4')).toBe('admin-t4-bis');
    expect((await promo(c4)).candidate_promotion.watch).toMatchObject({ status: 'REPLACED' });
    expect((await sql<Json[]>`SELECT code FROM ai_promotion_events WHERE kind = 'ROLLBACK_REFUSED' AND candidate_version_id = ${c4}`)[0].code).toBe('ROLLBACK_CONFLICT');
  });

  it('L113I-E07 — surveillance : J+7 sans usage → conservée INSUFFICIENT_USAGE ; J+30 usage suffisant → VALIDATED_IN_USAGE ; autre traitement promu : maintenue', async () => {
    const { runPromotionWatch } = await import('@/services/ai/qualification/promotion-watch');
    const c6 = await candidate('T6', 'cand-t6-c');
    const precedente = await actif();
    await promouvoir(c6);
    const w0 = (await promo(c6)).candidate_promotion.watch;
    const t0 = Date.parse(w0.activatedAt);
    const replayInterdit = async () => { throw new Error('aucun rejeu payant attendu'); };
    // J+3 puis J+7, aucune exécution : candidate conservée, aucun rejeu, aucun retour arrière.
    for (const j of [3.5, 7.5]) {
      const s = await runPromotionWatch({ trigger: 'e2e', skipLease: true, environment: env as never, now: () => new Date(t0 + j * 86_400_000), campaign: { call: replayInterdit as never } });
      expect(s).toMatchObject({ rolledBack: 0, replays: 0 });
    }
    expect(await actif()).toBe(c6);
    const w7 = (await promo(c6)).candidate_promotion.watch;
    expect(w7).toMatchObject({ status: 'INSUFFICIENT_USAGE' });
    expect(w7.milestones.h72).toBeTruthy();
    expect(w7.milestones.j7).toBeTruthy();
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM ai_promotion_events WHERE kind = 'WATCH_STATE' AND code = 'REVIEW_J7' AND candidate_version_id = ${c6}`)[0].n).toBe(1);
    // Un autre traitement est promu : la configuration de T6 n'a pas changé → surveillance maintenue (REC-070).
    const c1 = await candidate('T1', 'cand-t1-c');
    await promouvoir(c1);
    // Activité à J+30 : usage suffisant sous la configuration promue (attribuée par empreinte, y compris sous la
    // nouvelle version globale), référence suffisante avant l'activation, aucune dégradation.
    const acc = { id: accId };
    for (let i = 0; i < 20; i += 1) {
      await sql`INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, status, config_version_id, environment, duration_ms, cost_micros, created_at, metadata)
                VALUES (${acc?.id ?? null}, 't6_formulate', 't6_formulate', 'gemini', 'cand-t6-c', 'success', ${i % 2 ? c6 : c1}, ${env}, 100, 10, ${new Date(t0 + 30 * 86_400_000 - i * 60_000).toISOString()}::timestamptz, '{}'::jsonb)`;
      await sql`INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, status, config_version_id, environment, duration_ms, cost_micros, created_at, metadata)
                VALUES (${acc?.id ?? null}, 't6_formulate', 't6_formulate', 'gemini', 'base-t6', 'success', ${precedente}, ${env}, 100, 10, ${new Date(t0 - (i + 1) * 3_600_000).toISOString()}::timestamptz, '{}'::jsonb)`;
    }
    const s30 = await runPromotionWatch({ trigger: 'e2e', skipLease: true, environment: env as never, now: () => new Date(t0 + 30 * 86_400_000 + 60_000), campaign: { call: replayInterdit as never } });
    expect(s30).toMatchObject({ rolledBack: 0, replays: 0 });
    const w30 = (await promo(c6)).candidate_promotion.watch;
    expect(w30).toMatchObject({ status: 'VALIDATED_IN_USAGE' });
    expect(w30.validatedAt).toBeTruthy();
    expect(w30.servingVersionIds).toEqual(expect.arrayContaining([c6, c1]));
  });

  it('L113I-E08 — dernière disponibilité : deux réservations concurrentes, 20 fois → une seule accordée, jamais de dépassement (BUDT-01)', async () => {
    const { reserve, envelopeOf } = await import('@/services/ai/qualification/improvement-budget');
    const { defaultPolicy } = await import('@/services/ai/qualification/improvement-policy');
    const env80 = envelopeOf(defaultPolicy(), 'EXPERIMENT');
    for (let i = 0; i < 20; i += 1) {
      const now = new Date(Date.UTC(2040 + i, 0, 15));
      const mois = now.toISOString().slice(0, 7);
      await rempli(mois, 'EXPERIMENT', env80 - 1_000);
      const r = await Promise.all([1, 2].map((k) => reserve({ attemptKey: `budt01:${i}:${k}`, phase: 'EXPERIMENT', purpose: 'VALIDATION', bound: borne(1_000), environment: env, now })));
      expect(r.filter((x) => x.ok)).toHaveLength(1);
      expect(r.filter((x) => !x.ok).map((x) => (x as { code: string }).code)).toEqual(['BUDGET_UNAVAILABLE']);
      const [t] = await sql<Json[]>`SELECT sum(max_eur_micros)::bigint AS n FROM ai_improvement_budget_reservations WHERE environment = ${env} AND budget_month = ${mois} AND phase = 'EXPERIMENT'`;
      expect(Number(t.n)).toBeLessThanOrEqual(env80);
    }
  });

  it('L113I-E09 — 80 / 20 : expérimentation épuisée, surveillance disponible ; alertes 50 € et 75 € une fois chacune', async () => {
    const { reserve } = await import('@/services/ai/qualification/improvement-budget');
    const now = new Date(Date.UTC(2061, 5, 10));
    await rempli('2061-06', 'EXPERIMENT', 80_000_000);
    const exp = await reserve({ attemptKey: 'budt03:exp', phase: 'EXPERIMENT', purpose: 'EXPLORATION', bound: borne(10_000), environment: env, now });
    expect(exp).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
    const mon = await reserve({ attemptKey: 'budt03:mon', phase: 'MONITOR', purpose: 'MONITOR_CHECK', bound: borne(10_000), environment: env, now });
    expect(mon.ok).toBe(true);
    // Alertes : 80 € engagés → information (50) et vigilance (75), dédupliquées par mois.
    await reserve({ attemptKey: 'budt03:mon2', phase: 'MONITOR', purpose: 'MONITOR_CHECK', bound: borne(10_000), environment: env, now });
    const alertes = await sql<Json[]>`SELECT code FROM ai_alerts WHERE dedupe_key LIKE ${`improvement-budget:${env}:2061-06:%`} ORDER BY code`;
    expect(alertes.map((a) => a.code)).toEqual(expect.arrayContaining(['IMPROVEMENT_BUDGET_INFO', 'IMPROVEMENT_BUDGET_VIGILANCE']));
    expect(alertes.filter((a) => a.code === 'IMPROVEMENT_BUDGET_INFO')).toHaveLength(1);
    expect(alertes.every((a) => a.code.startsWith('IMPROVEMENT_BUDGET'))).toBe(true);
  });

  it('L113I-E10 — réservation orpheline : UNRECONCILED (jamais libérée ni gratuite), bloque ; coût tracé par la clé d’essai → réglée', async () => {
    const { reserve, sweepReservations } = await import('@/services/ai/qualification/improvement-budget');
    const now = new Date(Date.UTC(2062, 2, 1));
    // Borne cotée en USD (devise de la grille) : le règlement convertit avec le taux ADMINISTRÉ (BUD-06).
    const r = await reserve({ attemptKey: 'budt02:orphan', phase: 'EXPERIMENT', purpose: 'VALIDATION', bound: { ...borne(5_000), quotedCurrency: 'USD' }, environment: env, now });
    expect(r.ok).toBe(true);
    await sql`UPDATE ai_improvement_budget_reservations SET created_at = now() - interval '3 hours' WHERE attempt_key = 'budt02:orphan'`;
    const s1 = await sweepReservations({ environment: env, staleMs: 3_600_000 });
    expect(s1.markedUnreconciled).toBe(1);
    expect((await sql<Json[]>`SELECT state, settled_eur_micros FROM ai_improvement_budget_reservations WHERE attempt_key = 'budt02:orphan'`)[0]).toMatchObject({ state: 'UNRECONCILED', settled_eur_micros: null });
    const bloque = await reserve({ attemptKey: 'budt02:next', phase: 'EXPERIMENT', purpose: 'VALIDATION', bound: borne(1), environment: env, now });
    expect(bloque).toMatchObject({ ok: false, code: 'COST_UNRECONCILED' });
    // Le coût de l'appel arrive dans la télémétrie existante, rattaché à la clé d'essai (metadata.improvementAttemptKey).
    const acc = { id: accId };
    await sql`INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, status, environment, cost_micros, metadata)
              VALUES (${acc?.id ?? null}, 't6_formulate', 't6_formulate', 'gemini', 'm', 'success', ${env}, 3000, ${JSON.stringify({ traceId: 'tr-orphan', improvementAttemptKey: 'budt02:orphan' })}::jsonb)`;
    await politique({ fx: { usdToEur: 0.9, source: 'e2e', date: '2026-11-05', marginRatio: 0.1 }, costBound: { safetyMultiplier: 1.5, attachmentMaxTokens: null } });
    const s2 = await sweepReservations({ environment: env, staleMs: 3_600_000 });
    expect(s2.reconciled).toBe(1);
    expect((await sql<Json[]>`SELECT state, settled_eur_micros, provider_trace_id FROM ai_improvement_budget_reservations WHERE attempt_key = 'budt02:orphan'`)[0]).toMatchObject({ state: 'SETTLED', settled_eur_micros: '2970', provider_trace_id: 'tr-orphan' });
    expect((await reserve({ attemptKey: 'budt02:after', phase: 'EXPERIMENT', purpose: 'VALIDATION', bound: borne(1), environment: env, now })).ok).toBe(true);
  });

  it('L113I-E11 — moteur de qualification : budget refusé → zéro appel fournisseur (WAITING_BUDGET) ; financé → un appel par essai, règlement', async () => {
    const { runCoupleCases } = await import('@/services/ai/qualification/runner');
    const { improvementAttemptBudget } = await import('@/services/ai/qualification/improvement-budget');
    const pricing = await import('@/services/ai/gateway/pricing/pricing.repository');
    pricing.primePricingCache([{ provider: 'gemini', model: 'm-l113i', inputMicros: 0.3, outputMicros: 2.5, currency: 'USD', verified: true, fetchedAt: new Date(), source: 'manual' }]);
    const acc = { id: accId };
    await sql`INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, status, environment, input_tokens, cost_micros, metadata)
              VALUES (${acc?.id ?? null}, 't6_formulate', 't6_formulate', 'gemini', 'm-l113i', 'success', ${env}, 800, 10, '{}'::jsonb)`;
    let appels = 0;
    const call = async () => { appels += 1; return { data: { ok: true }, provider: 'gemini', model: 'm-l113i', promptVersion: 'x', usedFallback: false, inputTokens: 800, outputTokens: 20, costMicros: 290, durationMs: 12, traceId: `tr-l113i-${appels}`, fromCache: false } as never; };
    const cas = [{
      caseId: 'c-l113i', operationCode: 't6_formulate', treatment: 'T6' as const, source: 'CORPUS_FIXTURE' as const, expectedSource: 'REFERENCE' as const, mandatory: true, advisory: false,
      accountId: acc?.id ?? null, captureId: null, variables: { q: 'scène' }, outputSchema: z.any(), acceptedOutputSchemas: [], historicalOutput: null, marker: null,
      evaluate: async () => ({ defects: [] }),
    }];
    const couple = { treatment: 'T6' as const, operationCode: 't6_formulate', rank: 0, slot: 'primaryModel' as const, model: 'm-l113i', versionId: base, revisionId: null,
      profile: { reasoning: null, reasoningOrigin: null, maxOutputTokens: 500, timeoutMs: 30_000, timeoutOrigin: null, params: null }, technicalRefusal: null, parts: {} as never, signature: 'sig-l113i-0000000000' };
    const { QUALIFICATION_THRESHOLDS } = await import('@/services/ai/qualification/thresholds');
    const th = { ...QUALIFICATION_THRESHOLDS, transientRetries: 0, concurrency: { ...QUALIFICATION_THRESHOLDS.concurrency, queuedPerTreatment: 1, synchronousSimultaneous: 1, queuedPerWorker: 1 } };
    const lancer = (campaignId: number) => runCoupleCases({ couple: couple as never, cases: cas as never, observations: 1, campaignId, technicalAccountId: acc?.id ?? null, masterText: (async () => '') as never, call: call as never, thresholds: th as never,
      budget: improvementAttemptBudget({ phase: 'EXPERIMENT', purpose: 'VALIDATION', campaignId, environment: env }) });
    // Enveloppe d'expérimentation à 0 € (décision administrative) : aucun appel, essai non concluant FAUTE DE BUDGET.
    await politique({ budget: { monthlyEur: 100, experimentEur: 0, monitorEur: 20, infoAlertEur: 50, vigilanceAlertEur: 75 } });
    const refuse = await lancer(990_001);
    expect(appels).toBe(0);
    expect(refuse.observations.every((o) => o.blockedBy === 'BUDGET' && o.outcome === 'INCONCLUSIVE')).toBe(true);
    expect(refuse.observations[0].inconclusiveReason).toMatch(/BUDGET_UNAVAILABLE/);
    // Enveloppe rétablie : un appel par essai, réservé AVANT puis réglé au coût tracé.
    await politique({ budget: { monthlyEur: 100, experimentEur: 80, monitorEur: 20, infoAlertEur: 50, vigilanceAlertEur: 75 } });
    const ok = await lancer(990_002);
    expect(appels).toBe(1);
    expect(ok.observations[0].outcome).toBe('PASSED');
    const [res] = await sql<Json[]>`SELECT state, settled_quoted_micros, max_eur_micros, provider_trace_id, campaign_id FROM ai_improvement_budget_reservations WHERE attempt_key LIKE 'qualif:990002:%'`;
    expect(res).toMatchObject({ state: 'SETTLED', settled_quoted_micros: '290', provider_trace_id: 'tr-l113i-1', campaign_id: '990002' });
    expect(Number(res.max_eur_micros)).toBeGreaterThan(0);
  });

  it('L113I-E12 — objectifs : même événement en concurrence → un seul objectif ; trois variantes au plus ; transition impossible → code métier', async () => {
    const obj = await import('@/services/ai/qualification/improvement-objectives');
    const e = { environment: env, treatment: 'T3' as const, kind: 'STABLE_MODEL_AVAILABLE' as const, sourceRef: 'catalogue:m', eventFingerprint: 'evt-l113i', baselineFingerprint: 'base-l113i' };
    const [a, b] = await Promise.all([obj.registerObjective(e), obj.registerObjective(e)]);
    expect(a.objective.id).toBe(b.objective.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM ai_improvement_objectives WHERE event_fingerprint = 'evt-l113i' AND is_open`)[0].n).toBe(1);
    const id = a.objective.id;
    expect([await obj.nextVariant(id, 3), await obj.nextVariant(id, 3), await obj.nextVariant(id, 3), await obj.nextVariant(id, 3)]).toEqual([1, 2, 3, null]);
    expect(await obj.transitionObjective(id, ['DETECTED'], 'EXPERIMENTING')).toMatchObject({ ok: false, code: 'TRANSITION_REFUSED' });
    const fin = await obj.transitionObjective(id, ['QUEUED'], 'SUPERSEDED', { reason: 'référence changée' });
    expect(fin.ok).toBe(true);
    // Objectif clos : un événement identique ouvre un NOUVEL objectif seulement s'il est réenregistré ; l'ancien reste au journal.
    expect(await obj.findClosedObjective(e)).toMatchObject({ id, status: 'SUPERSEDED' });
  });

  it('L113I-E13 — BO / API : politique (révision attendue, 409, audit), budget lu, suspension d’objectif, droits', async () => {
    const { NextRequest } = await import('next/server');
    const cost = await import('@/app/api/admin/ai/cost-settings/route');
    const g = await (await cost.GET(new NextRequest('http://app.test/api/admin/ai/cost-settings') as never)).json() as Json;
    expect(g.improvement.budget).toMatchObject({ currency: 'EUR', envelope: { totalEur: 100, experimentEur: 80, monitorEur: 20 } });
    const v = g.improvement.policy.version as number;
    const put = (body: unknown) => cost.PUT(new NextRequest('http://app.test/api/admin/ai/cost-settings', { method: 'PUT', body: JSON.stringify(body) }) as never);
    expect((await put({ improvementPolicy: g.improvement.policy, expectedVersion: v + 7, reason: 'conflit' })).status).toBe(409);
    expect((await put({ improvementPolicy: { ...g.improvement.policy, variants: { maxPerObjective: 9 } }, expectedVersion: v, reason: 'hors bornes' })).status).toBe(400);
    const ok = await put({ improvementPolicy: { ...g.improvement.policy, usage: { minCallsValidated: 25 } }, expectedVersion: v, reason: 'e2e : volume de validation' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as Json).policy.version).toBe(v + 1);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM ai_admin_audit_log WHERE action_type = 'ai_improvement_policy_update'`)[0].n).toBeGreaterThan(0);
    const obj = await import('@/services/ai/qualification/improvement-objectives');
    const o = await obj.registerObjective({ environment: env, treatment: 'T2', kind: 'COST_OPPORTUNITY', sourceRef: 'e2e', eventFingerprint: 'evt-suspend', baselineFingerprint: 'b' });
    const route = await import('@/app/api/admin/ai/promotion/route');
    const post = (body: unknown) => route.POST(new NextRequest('http://app.test/api/admin/ai/promotion', { method: 'POST', body: JSON.stringify(body) }) as never);
    expect((await post({ action: 'suspend-objective', objectiveId: o.objective.id, expectedStatus: 'QUEUED' })).status).toBe(400); // motif obligatoire
    expect((await post({ action: 'suspend-objective', objectiveId: o.objective.id, expectedStatus: 'EXPERIMENTING', reason: 'e2e' })).status).toBe(409);
    const s = await post({ action: 'suspend-objective', objectiveId: o.objective.id, expectedStatus: 'QUEUED', reason: 'e2e : suspendu' });
    expect(s.status).toBe(200);
    expect((await s.json() as Json).objective).toMatchObject({ status: 'ABANDONED' });
    const st = await (await route.GET(new NextRequest('http://app.test/api/admin/ai/promotion') as never)).json() as Json;
    expect(st.improvement.treatments.map((t: Json) => t.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(st.improvement.treatments.every((t: Json) => ['QUALIFIED_ON_CORPUS', 'NOT_BUSINESS_QUALIFIED'].includes(t.qualification))).toBe(true);
    session.role = 'USER';
    try {
      expect((await cost.GET(new NextRequest('http://app.test/api/admin/ai/cost-settings') as never)).status).toBe(401);
      expect((await post({ action: 'suspend-objective', objectiveId: o.objective.id, expectedStatus: 'ABANDONED', reason: 'x' })).status).toBe(401);
    } finally { session.role = 'ADMIN'; }
  });

  it('L113I-E14 — surveillances historiques clôturées par l’ancienne fenêtre → LEGACY_OBSERVATION_UNKNOWN, aucun retour arrière', async () => {
    const id = await candidate('T2', 'legacy-t2');
    await sql`UPDATE ai_config_versions SET candidate_state = 'ACTIVATED', candidate_promotion = jsonb_build_object('watch', jsonb_build_object('status', 'RESOLVED', 'lastVerdict', 'INSUFFICIENT_DATA')) WHERE id = ${id}`;
    await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/1489_l113i_reprise_surveillances.sql'), 'utf8')); });
    const w = (await promo(id)).candidate_promotion.watch;
    expect(w).toMatchObject({ status: 'LEGACY_OBSERVATION_UNKNOWN', legacy: { status: 'RESOLVED' } });
    expect((await promo(id)).candidate_state).toBe('ACTIVATED');
  });
});
