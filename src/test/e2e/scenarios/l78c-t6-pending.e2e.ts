/**
 * Lot 78C — ticket « [P1] T6 — Corriger les évaluations bloquées en PENDING
 * et fiabiliser leur exécution » — de bout en bout sur PostgreSQL 16 réel :
 * vrai collecteur, vraie décision, vraie passerelle IA, vraie persistance
 * (`t6_evaluation_runs`, migration 0616), vraie file de pré-génération,
 * vrais rapports et vraie supervision. Modèle SIMULÉ (aucun réseau).
 *
 * Les assertions portent sur les ÉTATS PERSISTÉS (§5), pas seulement sur le
 * texte affiché.
 *
 *  L78C-01  première évaluation : PENDING réel → RUNNING → COMPLETED ;
 *           accueil « en cours » avec actualisation ciblée, puis décision
 *           affichée sans message d'attente ; rapport evaluate:display
 *  L78C-02  échec IA (RETRY_WAIT, prochain essai) puis reprise réussie ;
 *           aucun nouvel appel avant l'heure
 *  L78C-03  sortie invalide puis décisions entièrement rejetées jusqu'à
 *           FAILED ; anomalie de supervision ; reprise explicite (BO) ;
 *           résolution automatique de l'anomalie
 *  L78C-04  échec de persistance : jamais COMPLETED, reprise planifiée
 *  L78C-05  redémarrage pendant une évaluation : bail vivant respecté
 *           (aucun appel), bail expiré repris (interruption tracée) ;
 *           clôture d'une instance dépossédée sans effet
 *  L78C-06  exécutions concurrentes sur plusieurs instances : une seule prise,
 *           un seul appel IA
 *  L78C-07  plusieurs échéances : lot de 8, les restantes PENDING puis reprises
 *  L78C-08  pré-génération sans sujet à afficher mais évaluations incomplètes :
 *           demande NON close (reportée), jamais « nothing_to_say »
 *  L78C-09  T6 indisponible (aucun appel, aucun état fictif ; lot 81B : état
 *           UNAVAILABLE explicite) ; plafond IA du compte (UNAVAILABLE, essai planifié)
 *  L78C-10  absence de boucle : passages répétés sans appel IA ; décision
 *           enregistrée encore réclamée à contexte inchangé bornée (3 / 20 h)
 *  L78C-11  supervision : demande non prise au-delà du délai, tâche planifiée
 *           inactive distinguée ; migration 0616 idempotente
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

interface Candidat { subjectId: string; title: string; evidence: Array<{ ref: string; kind: string }> }

const modele = vi.hoisted(() => ({
  /** Décision rendue pour un candidat. */
  juger: (_c: Candidat): Record<string, unknown> => ({}),
  panne: false,
  /** Sortie brute EVALUATE imposée (sortie invalide). */
  brute: null as unknown,
  latenceMs: 0,
  evaluate: [] as Candidat[][],
}));

function provider() {
  return {
    name: 'simule-l78c',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        modele.evaluate.push(ctx.candidates);
        if (modele.latenceMs) await new Promise((r) => setTimeout(r, modele.latenceMs));
        if (modele.panne) throw new Error('fournisseur indisponible (simulé)');
        if (modele.brute) return { rawText: JSON.stringify(modele.brute), inputTokens: 200, outputTokens: 60 };
        const decisions = ctx.candidates.map((c) => ({
          subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, uncertainties: [],
          evidenceRefs: [c.evidence.find((x) => x.kind === 'DUE_DATE')?.ref ?? c.evidence[0].ref],
          ...AUCUNE, ...modele.juger(c),
        }));
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return {
        rawText: JSON.stringify({ schemaVersion: 't6-output-v2', messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })), suggestions: [] }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', priorityHint: 'LOW' };
const AGIR = { decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.', expectedAction: 'Prendre rendez-vous avec le prestataire', priorityHint: 'MEDIUM' };
/** SHOW_NOW + ACTION_NOW sans action attendue : rejeté par la validation métier. */
const REJETEE = { decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.', expectedAction: null, priorityHint: 'MEDIUM' };

interface Run {
  agenda_item_id: number; status: string; attempts: number; last_error_kind: string | null; next_attempt_at: Date | null;
  interrupted_count: number; run_id: string | null; last_outcome: string | null; lease_until: Date | null; context_fingerprint: string | null;
}

scenario('L78C-T6', 'Lot 78C — évaluations T6 : états réels persistés, reprise, concurrence, supervision', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    Object.assign(modele, { juger: () => AGIR, panne: false, brute: null, latenceMs: 0 });
    modele.evaluate.length = 0;
    const R = await import('@/services/home/mascot/t6-runner');
    R.resetT6Breaker(); R.resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    await sql`DELETE FROM home_mascot_pregen_requests`;
  });
  afterEach(async () => { (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations(); });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');
  const Q = () => import('@/services/home/mascot/pregen-queue');
  const RUNS = () => import('@/services/home/mascot/t6-evaluation-runs');
  const pregen = async (accountId: number) => (await svc()).getMascotPresentation(accountId, 'pregen', null);
  const afficher = async (c: { id: number; ownerUserId: number }) => (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
  const appels = () => modele.evaluate.length;
  const affichees = (p: import('@/services/home/mascot/types').MascotPresentation) =>
    p.paragraphs.filter((x) => x.reminder != null).map((x) => x.reminder!.agendaItemId);
  const etat = (p: import('@/services/home/mascot/types').MascotPresentation) => p.state?.evaluation ?? 'OK';

  async function compte() {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    return { ...a, maison: maison.id };
  }
  async function echeance(c: { id: number; ownerUserId: number; maison: number }, titre: string, date: string) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action' WHERE id = ${e.id}`;
    return e.id;
  }
  const date = (v: unknown) => (v == null ? null : new Date(String(v instanceof Date ? v.toISOString() : v)));
  const runs = async (accountId: number): Promise<Run[]> => (await sql<Run[]>`
    SELECT agenda_item_id, status, attempts, last_error_kind, next_attempt_at, interrupted_count, run_id, last_outcome, lease_until, context_fingerprint
      FROM t6_evaluation_runs WHERE account_id = ${accountId} ORDER BY agenda_item_id`)
    .map((r) => ({ ...r, next_attempt_at: date(r.next_attempt_at), lease_until: date(r.lease_until) }));
  const run = async (accountId: number, id: number) => (await runs(accountId)).find((r) => r.agenda_item_id === id) ?? null;
  const decision = async (accountId: number, id: number) =>
    (await sql<Array<{ decision: string }>>`SELECT decision FROM t6_interpellation_assessments WHERE account_id = ${accountId} AND agenda_item_id = ${id}`)[0] ?? null;
  /** Le délai avant le nouvel essai est écoulé (horloge simulée). */
  const essaiDu = async (accountId: number) => {
    await sql`UPDATE t6_evaluation_runs SET next_attempt_at = now() - interval '1 second' WHERE account_id = ${accountId} AND next_attempt_at IS NOT NULL`;
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState(); // disjoncteur de l'instance
  };
  const attendreFin = async (accountId: number, id: number) => {
    for (let i = 0; i < 600; i += 1) {
      const r = await run(accountId, id);
      if (r && !['PENDING', 'RUNNING'].includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    return run(accountId, id);
  };
  const demande = async (accountId: number) => (await sql<Array<{ traitee: boolean; last_status: string | null; attempts: number; futur: boolean }>>`
    SELECT processed_at IS NOT NULL AS traitee, last_status, attempts, requested_at > now() AS futur FROM home_mascot_pregen_requests WHERE account_id = ${accountId}`)[0] ?? null;

  it('L78C-01 — première évaluation : PENDING réel → COMPLETED, accueil actualisé sans message d’attente', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle chaudière', await plus(20));
    modele.latenceMs = 4_000;
    const p0 = await afficher(c);
    // Avant décision : examen RÉELLEMENT en cours (demande enregistrée, prise en charge), actualisation ciblée.
    expect(etat(p0)).toBe('PENDING');
    expect(p0.refreshAfterMs).toBeGreaterThanOrEqual(15_000);
    const r0 = await run(c.id, id);
    expect(['PENDING', 'RUNNING']).toContain(r0!.status);
    expect(r0!.context_fingerprint!.startsWith('v4:')).toBe(true);
    const r1 = await attendreFin(c.id, id);
    expect(r1).toMatchObject({ status: 'COMPLETED', attempts: 1, last_error_kind: null, next_attempt_at: null });
    expect(r1!.last_outcome).toBe('SHOW_NOW/ACTION_REQUIRED_SOON');
    expect(await decision(c.id, id)).toMatchObject({ decision: 'SHOW_NOW' });
    // Accueil actualisé : la mascotte quitte son message d'attente, sans relecture ciblée.
    const p1 = await afficher(c);
    expect(etat(p1)).toBe('OK');
    expect(affichees(p1)).toEqual([id]);
    expect(p1.refreshAfterMs).toBeUndefined();
    expect(p1.contextHash).not.toBe(p0.contextHash);
    expect(appels()).toBe(1);
    // Rapport evaluate:display : statut réel, tentative, empreinte, état de la pré-génération.
    await new Promise((res) => setTimeout(res, 100));
    const [rap] = await sql<Array<{ id: number; counters: Record<string, number>; sources: Record<string, unknown>; steps: Array<Record<string, unknown>> }>>`
      SELECT id, counters, sources, steps FROM ai_execution_reports WHERE account_id = ${c.id} AND trigger_code = 'evaluate:display' ORDER BY id DESC LIMIT 1`;
    expect(rap.counters).toMatchObject({ runCompleted: 1, runRetryWait: 0, runFailed: 0, persisted: 1 });
    expect(rap.sources.pregen).toMatchObject({ exists: true });
    expect(rap.steps.find((s) => s.step === 'run_state')).toMatchObject({ status: 'OK' });
    const [ligne] = await sql<Array<{ value: Record<string, unknown> }>>`
      SELECT value FROM ai_execution_report_entries WHERE report_id = ${rap.id} AND section = 'EVALUATE'`;
    expect(ligne.value).toMatchObject({ persisted: true, run: { status: 'COMPLETED', attempt: 1, nextAttemptAt: null } });
    expect(String(ligne.value.contextFingerprint)).toMatch(/^v4:/);
  });

  it('L78C-02 — échec IA : RETRY_WAIT persisté, aucun appel avant l’heure, puis reprise réussie', async () => {
    const c = await compte();
    const id = await echeance(c, 'Ramonage', await plus(15));
    modele.panne = true;
    const p = await pregen(c.id);
    const n1 = appels(); // appels fournisseur de CETTE évaluation (modèle principal et replis)
    expect(n1).toBeGreaterThan(0);
    const r = (await run(c.id, id))!;
    expect(r).toMatchObject({ status: 'RETRY_WAIT', attempts: 1, last_error_kind: 'model_unavailable' });
    const delai = (r.next_attempt_at!.getTime() - Date.now()) / 60_000;
    expect(delai).toBeGreaterThan(8);
    expect(delai).toBeLessThan(11);
    // Jamais « en cours d'examen » après un échec ; jamais de décision inventée.
    expect(etat(p)).toBe('UNAVAILABLE');
    expect(await decision(c.id, id)).toBeNull();
    // Avant l'heure : aucun appel (affichage comme pré-génération), même sur une autre « instance ».
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    await pregen(c.id);
    await afficher(c);
    await new Promise((res) => setTimeout(res, 100));
    expect(appels()).toBe(n1);
    // L'heure venue, le modèle répond : décision valide, tentative 2.
    modele.panne = false;
    await essaiDu(c.id);
    const q = await pregen(c.id);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 2, last_error_kind: null });
    expect(affichees(q)).toEqual([id]);
    expect(etat(q)).toBe('OK');
  });

  it('L78C-03 — sortie invalide puis rejets jusqu’à FAILED ; anomalie, reprise explicite BO, résolution automatique', async () => {
    const c = await compte();
    const id = await echeance(c, 'Entretien climatisation', await plus(25));
    // 1. Sortie hors contrat : rejetée en entier.
    modele.brute = { schemaVersion: 't6-evaluation-v1', decisions: [] };
    await pregen(c.id);
    expect(await run(c.id, id)).toMatchObject({ status: 'RETRY_WAIT', attempts: 1, last_error_kind: 'invalid_output' });
    // 2. et 3. Décision rejetée par la validation métier : jamais considérée comme traitée.
    modele.brute = null;
    modele.juger = () => REJETEE;
    await essaiDu(c.id);
    await pregen(c.id);
    expect(await run(c.id, id)).toMatchObject({ status: 'RETRY_WAIT', attempts: 2, last_error_kind: 'rejected' });
    await essaiDu(c.id);
    const p = await pregen(c.id);
    const echec = (await run(c.id, id))!;
    expect(echec).toMatchObject({ status: 'FAILED', attempts: 3, last_error_kind: 'rejected', next_attempt_at: null });
    expect(echec.last_outcome).toContain('show_now_without_action');
    expect(etat(p)).toBe('UNAVAILABLE');
    expect(await decision(c.id, id)).toBeNull();
    // Tentatives épuisées : plus aucun appel, quel que soit le chemin.
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    await pregen(c.id);
    await afficher(c);
    await new Promise((res) => setTimeout(res, 100));
    expect(appels()).toBe(3);
    // Pré-génération : close avec un motif explicite (jamais « rien à dire »).
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    expect(await (await Q()).processMascotPregenerationFor(c.id)).toBe('evaluation_failed');
    expect(await demande(c.id)).toMatchObject({ last_status: 'evaluation_failed' });
    // Supervision : anomalie du compte (BO › Supervision), cause distinguée.
    const S = await RUNS();
    const sup = await S.superviseT6Evaluations({ onlyAccountId: c.id });
    expect(sup.reported).toBe(1);
    const [an] = await sql<Array<{ id: number; status: string; account_id: number; domain: string; technical_detail: Record<string, unknown> }>>`
      SELECT id, status, account_id, domain, technical_detail FROM admin_anomalies WHERE fingerprint = ${S.t6EvaluationAnomalyFingerprint(c.id)}`;
    expect(an).toMatchObject({ status: 'open', account_id: c.id, domain: 'ai' });
    expect(an.technical_detail).toMatchObject({ kind: 't6_evaluation', failed: 1 });
    expect(an.technical_detail.causes).toContain('rejected');
    // Reprise explicite (BO) : remise à zéro, pré-génération demandée.
    expect(await S.resetT6RunsForRetry(c.id)).toBe(1);
    expect(await run(c.id, id)).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await demande(c.id)).toMatchObject({ futur: false, last_status: 'evaluation_failed' });
    modele.juger = () => AGIR;
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    await pregen(c.id);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    // Retour à la normale : anomalie résolue automatiquement.
    await S.superviseT6Evaluations({ onlyAccountId: c.id });
    const [apres] = await sql<Array<{ status: string; resolution_source: string; auto_resolution_origin: string }>>`
      SELECT status, resolution_source, auto_resolution_origin FROM admin_anomalies WHERE id = ${an.id}`;
    expect(apres).toMatchObject({ status: 'resolved', resolution_source: 'auto', auto_resolution_origin: 't6_evaluations_completed' });
  });

  it('L78C-04 — échec de persistance : jamais COMPLETED, nouvel essai planifié, puis décision enregistrée', async () => {
    const c = await compte();
    const id = await echeance(c, 'Révision portail', await plus(18));
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l78c_refus() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'écriture refusée (l78c)'; END $$`);
    await sql.unsafe(`CREATE TRIGGER l78c_refus BEFORE INSERT OR UPDATE ON t6_interpellation_assessments FOR EACH ROW EXECUTE FUNCTION l78c_refus()`);
    try {
      const p = await pregen(c.id);
      const r = (await run(c.id, id))!;
      expect(r).toMatchObject({ status: 'RETRY_WAIT', attempts: 1, last_error_kind: 'write_failed' });
      expect(r.last_outcome).toMatch(/non enregistrée/);
      expect(await decision(c.id, id)).toBeNull();
      expect(etat(p)).toBe('UNAVAILABLE');
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS l78c_refus ON t6_interpellation_assessments`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS l78c_refus()`);
    }
    await essaiDu(c.id);
    await pregen(c.id);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(await decision(c.id, id)).toMatchObject({ decision: 'SHOW_NOW' });
  });

  it('L78C-05 — redémarrage pendant une évaluation : bail vivant respecté, bail expiré repris et tracé', async () => {
    const c = await compte();
    const id = await echeance(c, 'Vidange fosse', await plus(22));
    const S = await RUNS();
    // Une autre instance a pris l'évaluation (bail vivant).
    await pregen(c.id); // demande + première décision
    await sql`DELETE FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    await sql`UPDATE t6_evaluation_runs SET status = 'RUNNING', run_id = 'instance-b', mode = 'pregen', attempts = 1, started_at = now(),
                     lease_until = now() + interval '4 minutes', finished_at = NULL WHERE account_id = ${c.id}`;
    const n0 = appels();
    const p = await afficher(c);
    await new Promise((res) => setTimeout(res, 150));
    expect(appels()).toBe(n0); // aucune exécution concurrente
    expect(etat(p)).toBe('PENDING'); // réellement en cours
    expect(p.refreshAfterMs).toBeGreaterThan(60_000); // relecture peu après la fin du bail
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    expect(await (await Q()).processMascotPregenerationFor(c.id)).toBe('evaluation_waiting');
    expect(await demande(c.id)).toMatchObject({ traitee: false, last_status: 'evaluation_waiting', futur: true });
    // L'instance B est morte : bail expiré → repris, interruption comptée.
    await sql`UPDATE t6_evaluation_runs SET lease_until = now() - interval '1 second' WHERE account_id = ${c.id}`;
    const q = await pregen(c.id);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 2, interrupted_count: 1 });
    expect(affichees(q)).toEqual([id]);
    // L'instance B se réveille : sa clôture est sans effet (exécution dépossédée).
    const fin = await S.finishT6Runs({ accountId: c.id, runId: 'instance-b', results: [{ agendaItemId: id, outcome: 'RETRY', errorKind: 'model_unavailable' }] });
    expect(fin).toEqual([]);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED' });
  });

  it('L78C-06 — exécutions concurrentes sur plusieurs instances : une seule prise, un seul appel IA', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle extincteurs', await plus(12));
    const S = await RUNS();
    // Deux prises simultanées (deux connexions) : une seule réussit.
    const sujets = [{ agendaItemId: id, fingerprint: 'v4:test', signature: null }];
    const [a, b] = await Promise.all([
      S.claimT6Runs({ accountId: c.id, runId: 'x1', mode: 'pregen', subjects: sujets }),
      S.claimT6Runs({ accountId: c.id, runId: 'x2', mode: 'pregen', subjects: sujets }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const refus = (a.ok ? b : a) as Extract<typeof a, { ok: false }>;
    expect(refus.reason).toBe('running_elsewhere');
    await sql`DELETE FROM t6_evaluation_runs WHERE account_id = ${c.id}`;
    // Deux « instances » (mémoires distinctes) évaluent le même lot : un seul appel IA.
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const I = await import('@/services/home/mascot/t6-interpellation.service');
    const R = await import('@/services/home/mascot/t6-runner');
    const prep = await I.prepareT6Interpellation({ accountId: c.id, userId: null, raw: await collectMascotData(c.id) }, {
      aiCapable: async () => true, thresholdDays: async () => 60, evaluationConfig: R.t6EvaluationConfig, runs: I.T6_RUN_LOADERS,
    });
    expect(prep.bundle).not.toBeNull();
    modele.latenceMs = 300;
    const premiere = R.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'pregen' });
    await new Promise((res) => setTimeout(res, 100));
    R.resetT6EvaluationState(); // l'autre instance ne partage pas la mémoire de la première
    const seconde = await R.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'display' });
    expect(seconde).toMatchObject({ status: 'skipped', run: { claimed: false, refusal: { reason: 'running_elsewhere' } } });
    expect((await premiere).status).toBe('generated');
    expect(appels()).toBe(1);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
  });

  it('L78C-07 — plusieurs échéances : lot de 8, les restantes PENDING puis reprises par la pré-génération durable', async () => {
    const c = await compte();
    const ids: number[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await echeance(c, `Échéance ${i + 1}`, await plus(10 + i)));
    modele.juger = () => AUCUNE;
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    expect(await (await Q()).processMascotPregenerationFor(c.id)).toBe('resumed');
    expect(modele.evaluate[0]).toHaveLength(8);
    const apres1 = await runs(c.id);
    expect(apres1.filter((r) => r.status === 'COMPLETED')).toHaveLength(8);
    expect(apres1.filter((r) => r.status === 'PENDING')).toHaveLength(2);
    // Reprise durable demandée (t6-resume) : la demande suivante évalue les 2 restantes.
    expect(await demande(c.id)).toMatchObject({ traitee: true });
    expect((await sql<Array<{ reason: string; en_attente: boolean }>>`SELECT reason, requested_at > processed_at AS en_attente FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`)[0])
      .toMatchObject({ reason: 't6-resume', en_attente: true });
    const o2 = await (await Q()).processMascotPregenerationFor(c.id);
    expect(['nothing_to_say', 'formulated']).toContain(o2);
    expect(modele.evaluate[1]).toHaveLength(2);
    expect((await runs(c.id)).every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(appels()).toBe(2);
  });

  it('L78C-08 — pré-génération sans sujet à afficher mais évaluations incomplètes : demande reportée, jamais « nothing_to_say »', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrat entretien', await plus(30));
    modele.panne = true;
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    const o = await (await Q()).processMascotPregenerationFor(c.id);
    expect(o).toBe('evaluation_waiting');
    const d = (await demande(c.id))!;
    expect(d).toMatchObject({ traitee: false, last_status: 'evaluation_waiting', futur: true, attempts: 0 });
    expect(await run(c.id, id)).toMatchObject({ status: 'RETRY_WAIT' });
    // La tâche planifiée ne la reprend pas avant l'essai planifié (aucune boucle).
    const t = await (await Q()).runMascotPregeneration({ batch: 50 });
    expect(t.claimed).toBe(0);
    // Essai dû : reprise par la tâche, décision enregistrée, demande close.
    modele.panne = false;
    await essaiDu(c.id);
    await sql`UPDATE home_mascot_pregen_requests SET requested_at = now() WHERE account_id = ${c.id}`;
    const o2 = await (await Q()).processMascotPregenerationFor(c.id);
    expect(o2).not.toBe('evaluation_waiting');
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED' });
    expect((await demande(c.id))!.traitee).toBe(true);
  });

  it('L78C-09 — T6 indisponible : aucun appel ni état fictif ; plafond IA : UNAVAILABLE et essai planifié', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle gaz', await plus(14));
    await sql`INSERT INTO ai_treatment_state (treatment, state, updated_at) VALUES ('T6', 'DISABLED', now())
              ON CONFLICT (treatment) DO UPDATE SET state = 'DISABLED', updated_at = now()`;
    try {
      const p = await pregen(c.id);
      expect(etat(p)).toBe('UNAVAILABLE');
      expect(appels()).toBe(0);
      // Lot 81B (B) : jamais d'attente fictive (aucun PENDING) — mais l'évaluation
      // éligible a désormais un état EXPLICITE (UNAVAILABLE, `t6_unavailable`),
      // repris au rétablissement (auparavant : aucune ligne, aucune reprise garantie).
      expect((await runs(c.id)).map((r) => [r.status, r.last_error_kind])).toEqual([['UNAVAILABLE', 't6_unavailable']]);
    } finally {
      await sql`UPDATE ai_treatment_state SET state = 'ENABLED', updated_at = now() WHERE treatment = 'T6'`;
    }
    // Plafond IA du mois du compte atteint.
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const I = await import('@/services/home/mascot/t6-interpellation.service');
    const R = await import('@/services/home/mascot/t6-runner');
    const prep = await I.prepareT6Interpellation({ accountId: c.id, userId: null, raw: await collectMascotData(c.id) }, {
      aiCapable: async () => true, thresholdDays: async () => 60, evaluationConfig: R.t6EvaluationConfig, runs: I.T6_RUN_LOADERS,
    });
    const o = await R.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'pregen' }, {
      ...R.t6EvaluationDefaultDeps,
      execute: async () => { throw Object.assign(new Error('plafond'), { code: 'COST_CAP_REACHED' }); },
    });
    expect(o.status).toBe('error');
    const r = (await run(c.id, id))!;
    expect(r).toMatchObject({ status: 'UNAVAILABLE', last_error_kind: 'cost_cap' });
    expect((r.next_attempt_at!.getTime() - Date.now()) / 3_600_000).toBeGreaterThan(5.9);
    const p2 = await pregen(c.id);
    expect(etat(p2)).toBe('UNAVAILABLE');
    expect(appels()).toBe(0);
  });

  it('L78C-10 — absence de boucle : passages répétés sans appel ; décision enregistrée encore réclamée bornée (anti-boucle)', async () => {
    const c = await compte();
    const id = await echeance(c, 'Taille des haies', await plus(16));
    await pregen(c.id);
    expect(appels()).toBe(1);
    for (let i = 0; i < 3; i += 1) { await pregen(c.id); await afficher(c); }
    await new Promise((res) => setTimeout(res, 150));
    expect(appels()).toBe(1);
    // Décision enregistrée de nouveau réclamée à contexte INCHANGÉ (ici : disparue) :
    // réévaluée au plus 3 fois dans la fenêtre anti-boucle, puis plus aucun appel.
    for (let i = 1; i <= 3; i += 1) {
      await sql`DELETE FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
      await pregen(c.id);
      expect(appels()).toBe(1 + i);
      expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED' });
    }
    expect((await sql<[{ n: number }]>`SELECT same_context_runs AS n FROM t6_evaluation_runs WHERE agenda_item_id = ${id}`)[0].n).toBe(3);
    await sql`DELETE FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    const p = await pregen(c.id);
    expect(appels()).toBe(4);
    expect(etat(p)).toBe('PENDING');
    // Au-delà du délai d'alerte : jamais présenté comme un examen en cours.
    await sql`UPDATE t6_evaluation_runs SET finished_at = now() - interval '2 hours' WHERE account_id = ${c.id}`;
    expect(etat(await pregen(c.id))).toBe('UNAVAILABLE');
    expect(appels()).toBe(4);
    // Fenêtre anti-boucle écoulée : nouvelle évaluation, compteur remis à zéro.
    await sql`UPDATE t6_evaluation_runs SET finished_at = now() - interval '21 hours' WHERE account_id = ${c.id}`;
    await pregen(c.id);
    expect(appels()).toBe(5);
    expect(await decision(c.id, id)).not.toBeNull();
    expect((await sql<[{ n: number }]>`SELECT same_context_runs AS n FROM t6_evaluation_runs WHERE agenda_item_id = ${id}`)[0].n).toBe(0);
  });

  it('L78C-11 — supervision : demande non prise au-delà du délai, tâche planifiée inactive distinguée ; migration 0616 idempotente', async () => {
    const c = await compte();
    const id = await echeance(c, 'Ravalement', await plus(40));
    const S = await RUNS();
    await S.requestT6Runs(c.id, [{ agendaItemId: id, fingerprint: 'v4:x', signature: null }]);
    await sql`UPDATE t6_evaluation_runs SET requested_at = now() - interval '2 hours' WHERE account_id = ${c.id}`;
    const etats = await S.loadT6Runs(c.id, [id]);
    expect(S.effectiveRunState(etats.get(id)!, new Date())).toMatchObject({ state: 'PENDING', stale: true, claimable: true });
    // Tâche planifiée silencieuse depuis une heure.
    await sql`INSERT INTO scheduled_task_state (code, last_started_at, last_finished_at) VALUES ('mascot-pregeneration', now() - interval '1 hour', now() - interval '1 hour')
              ON CONFLICT (code) DO UPDATE SET last_started_at = EXCLUDED.last_started_at, last_finished_at = EXCLUDED.last_finished_at`;
    const vus: Array<{ detail?: Record<string, unknown> | null }> = [];
    await S.superviseT6Evaluations({ onlyAccountId: c.id, report: async (a) => { vus.push(a); return 1; }, resolve: async () => false });
    expect(vus).toHaveLength(1);
    expect(vus[0].detail).toMatchObject({ stalePending: 1, schedulerActive: false });
    expect(vus[0].detail!.causes).toEqual(['scheduler_inactive']);
    // Tâche active : cause « non prise en charge ».
    await sql`UPDATE scheduled_task_state SET last_finished_at = now() WHERE code = 'mascot-pregeneration'`;
    vus.length = 0;
    await S.superviseT6Evaluations({ onlyAccountId: c.id, report: async (a) => { vus.push(a); return 1; }, resolve: async () => false });
    expect(vus[0].detail!.causes).toEqual(['not_picked_up']);
    // Migration rejouée deux fois sans erreur.
    const texte = await readFile(join(process.cwd(), 'src/db/migrations', '0616_l78c_t6_evaluation_runs.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = {
        unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown>,
        reserve: async () => {
          const r = await sql.reserve();
          return { unsafe: (q: string, p?: never[]) => r.unsafe(q, p as never) as unknown as Promise<unknown>, release: () => r.release() };
        },
      };
      for (let i = 0; i < 2; i += 1) await expect(runMigrationSql(runner, texte)).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    expect((await runs(c.id))).toHaveLength(1);
  });
});
