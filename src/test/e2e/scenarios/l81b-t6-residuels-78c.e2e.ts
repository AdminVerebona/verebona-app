/**
 * Lot 81B — ticket « [P1] T6 — Corriger les écarts résiduels du lot 78C et
 * garantir la reprise des évaluations » — de bout en bout sur PostgreSQL 16
 * réel : vrai collecteur, vraie décision, vraie passerelle IA (modèle SIMULÉ,
 * aucun réseau), vraie file de pré-génération, vrais rapports, vraie
 * supervision et vraie tâche planifiée. Assertions sur les ÉTATS PERSISTÉS
 * (t6_evaluation_runs, home_mascot_pregen_requests, t6_interpellation_assessments,
 * ai_execution_reports, admin_anomalies), limitées aux comptes de ce fichier.
 *
 *  L81B-A1  plafond quotidien de formulation atteint, évaluation incomplète :
 *           l'évaluation est exécutée et enregistrée, aucune formulation ;
 *           jamais « capped » avant de connaître l'état des évaluations
 *  L81B-A2  plafond atteint ET évaluation en échec : demande REPORTÉE
 *           (jamais close), puis close après la décision enregistrée
 *  L81B-B1  T6 désactivé puis réactivé SANS événement utilisateur : état
 *           UNAVAILABLE explicite (jamais PENDING, aucun appel IA), demande
 *           durable reportée, reprise par la tâche planifiée au rétablissement
 *  L81B-B2  affichage avec T6 indisponible : demande durable garantie
 *  L81B-B3  T6 devenu indisponible entre la décision et l'exécution : état
 *           UNAVAILABLE et rapport evaluate tracé
 *  L81B-C1  trois tentatives de pré-génération consommées sans progrès : état
 *           explicite `attempts_exhausted`, aucune évaluation PENDING orpheline,
 *           supervision, reprise automatique bornée puis décision enregistrée
 *  L81B-C2  épuisements répétés : demande close, reprise explicite (BO) ;
 *           migration 0629 idempotente
 *  L81B-D1  bail renouvelé pendant une exécution longue : aucune reprise
 *           concurrente
 *  L81B-D2  première exécution encore active après expiration du bail, reprise
 *           par une seconde instance : la première n'écrit RIEN, la décision la
 *           plus récente est conservée
 *  L81B-D3  deux connexions : la persistance sous verrou sérialise la reprise ;
 *           une exécution dépossédée ne détient plus rien
 *  L81B-E1  plus de 200 comptes bloqués : balayage paginé complet
 *  L81B-E2  supervision d'un compte absent des 200 premiers : anomalie
 *           conservée (filtre dans la requête), jamais résolue par absence
 *  L81B-E3  compteurs et causes consolidés sur les seules évaluations bloquées ;
 *           résolution après vérification positive
 *  L81B-F1  arrêt complet de mascot-pregeneration : scheduler_inactive produit
 *           par la tâche DISTINCTE mascot-t6-supervision, sans visite ;
 *           résolu au redémarrage
 *  L81B-G1  clôture technique en échec après persistance métier réussie :
 *           rapport PARTIAL (jamais SUCCESS), étape run_state en échec, puis
 *           clôture rattrapée sans appel IA
 *  L81B-G2  refus de prise tracé (NO_CHANGE, motif), sans rapport répété
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

interface Candidat { subjectId: string; title: string; evidence: Array<{ ref: string; kind: string }> }

const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Record<string, unknown> => ({}),
  /** Décisions imposées appel par appel (prioritaires sur `juger`). */
  file: [] as Array<Record<string, unknown>>,
  /** Latences imposées appel par appel (ms). */
  latences: [] as number[],
  panne: false,
  evaluate: [] as Candidat[][],
  formulate: 0,
}));

function provider() {
  return {
    name: 'simule-l81b',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        modele.evaluate.push(ctx.candidates);
        const latence = modele.latences.shift() ?? 0;
        const impose = modele.file.shift();
        if (latence) await new Promise((r) => setTimeout(r, latence));
        if (modele.panne) throw new Error('fournisseur indisponible (simulé)');
        const decisions = ctx.candidates.map((c) => ({
          subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, uncertainties: [],
          evidenceRefs: [c.evidence.find((x) => x.kind === 'DUE_DATE')?.ref ?? c.evidence[0].ref],
          ...AUCUNE, ...(impose ?? modele.juger(c)),
        }));
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      modele.formulate += 1;
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

interface Run {
  agenda_item_id: number; status: string; attempts: number; last_error_kind: string | null; next_attempt_at: Date | null;
  interrupted_count: number; run_id: string | null; last_outcome: string | null; lease_until: Date | null; requested_at: Date | null;
}

scenario('L81B-T6', 'Lot 81B — T6 : écarts résiduels du lot 78C (plafond, indisponibilité, tentatives, bail, supervision, rapports)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    Object.assign(modele, { juger: () => AGIR, panne: false, formulate: 0 });
    modele.evaluate.length = 0; modele.file.length = 0; modele.latences.length = 0;
    const R = await import('@/services/home/mascot/t6-runner');
    R.resetT6Breaker(); R.resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    // File de pré-génération propre à ce fichier : la tâche ne traite que nos comptes.
    await sql`DELETE FROM home_mascot_pregen_requests`;
    await sql`UPDATE ai_treatment_state SET state = 'ENABLED', updated_at = now() WHERE treatment = 'T6'`;
  });
  afterEach(async () => {
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    vi.unstubAllEnvs();
  });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');
  const Q = () => import('@/services/home/mascot/pregen-queue');
  const RUNS = () => import('@/services/home/mascot/t6-evaluation-runs');
  const I = () => import('@/services/home/mascot/t6-interpellation.service');
  const R = () => import('@/services/home/mascot/t6-runner');
  const afficher = async (c: { id: number; ownerUserId: number }) => (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
  const appels = () => modele.evaluate.length;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    SELECT agenda_item_id, status, attempts, last_error_kind, next_attempt_at, interrupted_count, run_id, last_outcome, lease_until, requested_at
      FROM t6_evaluation_runs WHERE account_id = ${accountId} ORDER BY agenda_item_id`)
    .map((r) => ({ ...r, next_attempt_at: date(r.next_attempt_at), lease_until: date(r.lease_until), requested_at: date(r.requested_at) }));
  const run = async (accountId: number, id: number) => (await runs(accountId)).find((r) => r.agenda_item_id === id) ?? null;
  const decision = async (accountId: number, id: number) =>
    (await sql<Array<{ decision: string; trace_id: string | null }>>`SELECT decision, trace_id FROM t6_interpellation_assessments WHERE account_id = ${accountId} AND agenda_item_id = ${id}`)[0] ?? null;
  const demande = async (accountId: number) => (await sql<Array<{
    traitee: boolean; en_attente: boolean; last_status: string | null; attempts: number; futur: boolean; exhausted_count: number; requested_at: Date; reason: string;
  }>>`
    SELECT processed_at IS NOT NULL AS traitee, (processed_at IS NULL OR requested_at > processed_at) AS en_attente, last_status, attempts,
           requested_at > now() AS futur, exhausted_count, requested_at, reason
      FROM home_mascot_pregen_requests WHERE account_id = ${accountId}`).map((r) => ({ ...r, requested_at: date(r.requested_at)! }))[0] ?? null;
  /** Horloge simulée : la demande reportée arrive à son heure (aucun nouvel événement). */
  // L'horloge avance jusqu'à l'heure de la demande (+ le délai de regroupement
  // des signaux, PREGEN_SETTLE_MS) : toutes ses dates reculent d'autant.
  const demandeDue = (accountId: number) => sql`
    UPDATE home_mascot_pregen_requests
       SET processed_at = processed_at - (requested_at - (now() - interval '10 seconds')), requested_at = now() - interval '10 seconds'
     WHERE account_id = ${accountId}`;
  const essaiDu = async (accountId: number) => {
    await sql`UPDATE t6_evaluation_runs SET next_attempt_at = now() - interval '1 second' WHERE account_id = ${accountId} AND next_attempt_at IS NOT NULL`;
    (await R()).resetT6EvaluationState();
  };
  const rapports = async (accountId: number, trigger: string) => sql<Array<{ id: number; status: string; counters: Record<string, number>; steps: Array<Record<string, unknown>>; sources: Record<string, unknown> }>>`
    SELECT id, status, counters, steps, sources FROM ai_execution_reports WHERE account_id = ${accountId} AND trigger_code = ${trigger} ORDER BY id`;
  const anomalie = async (fp: string) => (await sql<Array<{ id: number; status: string; technical_detail: Record<string, unknown>; resolution_source: string | null }>>`
    SELECT id, status, technical_detail, resolution_source FROM admin_anomalies WHERE fingerprint = ${fp} ORDER BY id DESC LIMIT 1`)[0] ?? null;
  const t6 = (state: 'ENABLED' | 'DISABLED') => sql`
    INSERT INTO ai_treatment_state (treatment, state, updated_at) VALUES ('T6', ${state}, now())
    ON CONFLICT (treatment) DO UPDATE SET state = ${state}, updated_at = now()`;
  async function preparer(accountId: number) {
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const S = await I();
    return S.prepareT6Interpellation({ accountId, userId: null, raw: await collectMascotData(accountId) }, {
      aiCapable: async () => true, thresholdDays: async () => 60, evaluationConfig: (await R()).t6EvaluationConfig, runs: S.T6_RUN_LOADERS,
    });
  }
  const rapporteur = (accountId: number, mode: 'pregen' | 'display', bundle: import('@/services/home/mascot/t6-interpellation').T6InterpellationBundle) =>
    async (o: import('@/services/home/mascot/t6-runner').T6EvaluationOutcome) => {
      const S = await I();
      return S.writeT6EvaluationReport({ accountId, mode, bundle, trace: S.t6EvaluationTraceOf(o) });
    };

  // ── A ──────────────────────────────────────────────────────────────────────

  it('L81B-A1 — plafond de formulation atteint, évaluation incomplète : évaluée et enregistrée, jamais close « capped » avant', async () => {
    vi.stubEnv('MASCOT_PREGEN_DAILY_MAX', '0');
    const c = await compte();
    const id = await echeance(c, 'Contrôle chaudière', await plus(20));
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    const o = await (await Q()).processMascotPregenerationFor(c.id);
    // Évaluation exécutée, décision VALIDÉE ENREGISTRÉE, état COMPLETED.
    expect(appels()).toBe(1);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    expect(await decision(c.id, id)).toMatchObject({ decision: 'SHOW_NOW' });
    // Seule la formulation est plafonnée : aucun appel FORMULATE.
    expect(modele.formulate).toBe(0);
    expect(o).toBe('capped');
    expect(await demande(c.id)).toMatchObject({ traitee: true, en_attente: false, last_status: 'capped' });
  });

  it('L81B-A2 — plafond atteint et évaluation en échec : demande reportée (jamais close), puis close après décision', async () => {
    vi.stubEnv('MASCOT_PREGEN_DAILY_MAX', '0');
    const c = await compte();
    const id = await echeance(c, 'Ramonage', await plus(15));
    modele.panne = true;
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    expect(await (await Q()).processMascotPregenerationFor(c.id)).toBe('evaluation_waiting');
    expect(await demande(c.id)).toMatchObject({ en_attente: true, last_status: 'evaluation_waiting', futur: true, attempts: 0 });
    expect(await run(c.id, id)).toMatchObject({ status: 'RETRY_WAIT', last_error_kind: 'model_unavailable' });
    // L'essai dû, sans nouvel événement : la tâche reprend la demande reportée.
    modele.panne = false;
    await essaiDu(c.id);
    await demandeDue(c.id);
    const t = await (await Q()).runMascotPregeneration({ batch: 50 });
    expect(t).toMatchObject({ claimed: 1, capped: 1 });
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(await demande(c.id)).toMatchObject({ en_attente: false, last_status: 'capped' });
    expect(modele.formulate).toBe(0);
  });

  // ── B ──────────────────────────────────────────────────────────────────────

  it('L81B-B1 — T6 désactivé puis réactivé sans événement utilisateur : UNAVAILABLE explicite, reprise par la tâche planifiée', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle gaz', await plus(14));
    await t6('DISABLED');
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    expect(await (await Q()).processMascotPregenerationFor(c.id)).toBe('evaluation_waiting');
    // Évaluation éligible ENREGISTRÉE avec un motif explicite — jamais absente, jamais PENDING.
    const r = (await run(c.id, id))!;
    expect(r).toMatchObject({ status: 'UNAVAILABLE', last_error_kind: 't6_unavailable', attempts: 0 });
    const recheck = (r.next_attempt_at!.getTime() - Date.now()) / 60_000;
    expect(recheck).toBeGreaterThan(13);
    expect(recheck).toBeLessThan(16);
    expect(appels()).toBe(0);
    // Demande durable REPORTÉE (tentative non consommée), jamais close.
    expect(await demande(c.id)).toMatchObject({ en_attente: true, futur: true, attempts: 0, last_status: 'evaluation_waiting' });
    // Indisponibilité persistante : passages répétés sans appel IA ni tentative consommée.
    await demandeDue(c.id);
    await (await Q()).runMascotPregeneration({ batch: 50 });
    expect(appels()).toBe(0);
    expect(await run(c.id, id)).toMatchObject({ status: 'UNAVAILABLE', attempts: 0 });
    expect(await demande(c.id)).toMatchObject({ en_attente: true, attempts: 0 });
    // Affichage : jamais « en cours d'examen » pour une exécution inexistante.
    const p = await afficher(c);
    expect(p.state?.evaluation).toBe('UNAVAILABLE');
    // Rétablissement : la demande reportée arrive à son heure — AUCUN événement utilisateur.
    await t6('ENABLED');
    await demandeDue(c.id);
    const t = await (await Q()).runMascotPregeneration({ batch: 50 });
    expect(t.claimed).toBe(1);
    expect(appels()).toBe(1);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    expect(await decision(c.id, id)).toMatchObject({ decision: 'SHOW_NOW' });
    expect(await demande(c.id)).toMatchObject({ en_attente: false });
  });

  it('L81B-B2 — affichage avec T6 indisponible : demande durable garantie (reprise sans nouvelle visite)', async () => {
    const c = await compte();
    const id = await echeance(c, 'Entretien pompe', await plus(25));
    await t6('DISABLED');
    expect(await demande(c.id)).toBeNull();
    const p = await afficher(c);
    expect(p.state?.evaluation).toBe('UNAVAILABLE');
    await pause(150);
    expect(await run(c.id, id)).toMatchObject({ status: 'UNAVAILABLE', last_error_kind: 't6_unavailable' });
    expect(await demande(c.id)).toMatchObject({ en_attente: true, reason: 't6-unavailable' });
    // Une demande en attente n'est pas avancée par une nouvelle visite.
    await sql`UPDATE home_mascot_pregen_requests SET requested_at = now() + interval '10 minutes' WHERE account_id = ${c.id}`;
    await afficher(c);
    await pause(150);
    expect(await demande(c.id)).toMatchObject({ futur: true });
    expect(appels()).toBe(0);
  });

  it('L81B-B3 — T6 devenu indisponible avant l’exécution : état UNAVAILABLE et rapport tracé', async () => {
    const c = await compte();
    const id = await echeance(c, 'Révision portail', await plus(18));
    const prep = await preparer(c.id);
    expect(prep.bundle).not.toBeNull();
    expect(await run(c.id, id)).toMatchObject({ status: 'PENDING' });
    const Rr = await R();
    const o = await Rr.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'pregen' }, {
      ...Rr.t6EvaluationDefaultDeps, available: async () => false, report: rapporteur(c.id, 'pregen', prep.bundle!),
    });
    expect(o).toMatchObject({ status: 'disabled', run: { claimed: false, refusal: { reason: 't6_unavailable' }, unavailable: [id] } });
    expect(await run(c.id, id)).toMatchObject({ status: 'UNAVAILABLE', last_error_kind: 't6_unavailable' });
    const [rap] = await rapports(c.id, 'evaluate:pregen');
    expect(rap.status).toBe('FAILED');
    expect(rap.counters).toMatchObject({ runT6Unavailable: 1 });
    expect(rap.steps.find((s) => s.step === 'run_state')).toMatchObject({ status: 'SKIPPED' });
  });

  // ── C ──────────────────────────────────────────────────────────────────────

  it('L81B-C1 — trois tentatives consommées sans progrès : état explicite, aucune évaluation PENDING orpheline, reprise automatique', async () => {
    const c = await compte();
    const id = await echeance(c, 'Vidange fosse', await plus(22));
    // La prise des évaluations échoue (base) : prenables mais sans progrès.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l81b_prise() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'RUNNING' AND NEW.account_id = ${c.id} THEN RAISE EXCEPTION 'prise refusée (l81b)'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER l81b_prise BEFORE UPDATE ON t6_evaluation_runs FOR EACH ROW EXECUTE FUNCTION l81b_prise()`);
    try {
      await (await Q()).requestMascotPregeneration(c.id, 'test');
      for (let n = 1; n <= 3; n += 1) {
        await demandeDue(c.id);
        expect(await (await Q()).processMascotPregenerationFor(c.id)).toBe('evaluation_waiting');
        expect(await demande(c.id)).toMatchObject({ attempts: n, en_attente: true });
      }
      // Demande non sélectionnable (tentatives épuisées)…
      await demandeDue(c.id);
      expect(await (await Q()).processMascotPregenerationFor(c.id)).toBeNull();
      expect(await run(c.id, id)).toMatchObject({ status: 'PENDING' });
      // … la tâche lui donne un état EXPLICITE et détectable.
      const t = await (await Q()).runMascotPregeneration({ batch: 50 });
      expect(t).toMatchObject({ exhausted: 1, exhaustedFinal: 0 });
      const d = (await demande(c.id))!;
      expect(d).toMatchObject({ last_status: 'attempts_exhausted', exhausted_count: 1, attempts: 0, en_attente: true, futur: true });
      const rearm = (d.requested_at.getTime() - Date.now()) / 3_600_000;
      expect(rearm).toBeGreaterThan(1.9);
      expect(rearm).toBeLessThan(2.1);
      // Aucune évaluation PENDING orpheline : état explicite, date de reprise.
      const r = (await run(c.id, id))!;
      expect(r).toMatchObject({ status: 'UNAVAILABLE', last_error_kind: 'pregen_exhausted' });
      expect(Math.abs(r.next_attempt_at!.getTime() - d.requested_at.getTime())).toBeLessThan(2_000);
      expect((await runs(c.id)).filter((x) => x.status === 'PENDING')).toEqual([]);
      expect(appels()).toBe(0);
      // Supervision : évaluations incomplètes signalées, cause distinguée.
      const S = await RUNS();
      const sup = await S.superviseT6Evaluations({ onlyAccountId: c.id });
      expect(sup.reported).toBe(1);
      const an = (await anomalie(S.t6EvaluationAnomalyFingerprint(c.id)))!;
      expect(an.status).toBe('open');
      expect(an.technical_detail).toMatchObject({ pregenExhausted: true, incomplete: 1 });
      expect(an.technical_detail.causes).toContain('pregen_exhausted');
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS l81b_prise ON t6_evaluation_runs`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS l81b_prise()`);
    }
    // Reprise AUTOMATIQUE à l'heure prévue (aucun événement) : décision enregistrée.
    await demandeDue(c.id);
    await essaiDu(c.id);
    const t2 = await (await Q()).runMascotPregeneration({ batch: 50 });
    expect(t2.claimed).toBe(1);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED' });
    expect((await demande(c.id))!.last_status).not.toBe('attempts_exhausted');
    // Retour à la normale vérifié : anomalie résolue.
    const S = await RUNS();
    await S.superviseT6Evaluations({ onlyAccountId: c.id });
    expect(await anomalie(S.t6EvaluationAnomalyFingerprint(c.id))).toMatchObject({ status: 'resolved', resolution_source: 'auto' });
  });

  it('L81B-C2 — épuisements répétés : demande close (aucune boucle), reprise explicite depuis le BO', async () => {
    const c = await compte();
    const id = await echeance(c, 'Taille des haies', await plus(16));
    const S = await RUNS();
    await S.requestT6Runs(c.id, [{ agendaItemId: id, fingerprint: 'v4:x', signature: null }]);
    await sql`INSERT INTO home_mascot_pregen_requests (account_id, requested_at, reason, attempts, exhausted_count)
              VALUES (${c.id}, now() - interval '1 minute', 'test', 3, 3)`;
    const e = await (await Q()).sweepExhaustedPregenRequests({ accountId: c.id });
    expect(e).toEqual([expect.objectContaining({ accountId: c.id, final: true, exhaustedCount: 4, retryAt: null, runsMarked: 1 })]);
    expect(await demande(c.id)).toMatchObject({ last_status: 'attempts_exhausted', en_attente: false, traitee: true });
    expect(await run(c.id, id)).toMatchObject({ status: 'UNAVAILABLE', last_error_kind: 'pregen_exhausted', next_attempt_at: null });
    // Plus rien ne la reprend seule : la tâche ne la prend plus.
    expect((await (await Q()).runMascotPregeneration({ batch: 50 })).claimed).toBe(0);
    // Supervision : bloquée (aucune reprise planifiée).
    const [b] = await S.blockedT6Accounts(30, { onlyAccountId: c.id });
    expect(b).toMatchObject({ accountId: c.id, overdueRetry: 1, pregenExhausted: true });
    // Reprise explicite (BO › Supervision) : évaluation relancée, épuisement remis à zéro.
    expect(await S.resetT6RunsForRetry(c.id)).toBe(1);
    expect(await run(c.id, id)).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await demande(c.id)).toMatchObject({ en_attente: true, exhausted_count: 0, attempts: 0 });
    // Migration 0629 rejouée deux fois sans erreur ni perte.
    const texte = await readFile(join(process.cwd(), 'src/db/migrations', '0629_l81b_pregen_tentatives_epuisees.sql'), 'utf-8');
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
    expect(await demande(c.id)).toMatchObject({ exhausted_count: 0, en_attente: true });
  });

  // ── D ──────────────────────────────────────────────────────────────────────

  it('L81B-D1 — bail renouvelé pendant une exécution longue : aucune reprise concurrente', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle extincteurs', await plus(12));
    const prep = await preparer(c.id);
    const Rr = await R();
    const S = await RUNS();
    modele.latences.push(2_200);
    const store = { ...Rr.t6RunDbStore, leaseMs: 1_000, renewEveryMs: 250 };
    const premiere = Rr.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'pregen' }, { ...Rr.t6EvaluationDefaultDeps, runs: store });
    await pause(1_500); // au-delà du bail initial (1 s) : renouvelé
    const autre = await S.claimT6Runs({ accountId: c.id, runId: 'instance-b', mode: 'pregen', subjects: [{ agendaItemId: id, fingerprint: prep.bundle!.refs.get('C1')!.fingerprint, signature: prep.bundle!.evaluationSignature ?? null }] });
    expect(autre).toMatchObject({ ok: false, reason: 'running_elsewhere' });
    const o = await premiere;
    expect(o.status).toBe('generated');
    expect(o.run!.renewals).toBeGreaterThanOrEqual(3);
    expect(o.run!.ownershipLost).toEqual([]);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 1, interrupted_count: 0 });
    expect(appels()).toBe(1);
  });

  it('L81B-D2 — première exécution active après expiration du bail, reprise par une seconde : la première n’écrit rien', async () => {
    const c = await compte();
    const id = await echeance(c, 'Entretien climatisation', await plus(25));
    const prep = await preparer(c.id);
    const Rr = await R();
    // Instance A : bail court, renouvellement impossible (instance figée), modèle lent.
    modele.latences.push(2_000, 0);
    modele.file.push(AGIR, AUCUNE);
    const storeA = { ...Rr.t6RunDbStore, leaseMs: 1_000, renew: undefined };
    const rapA = rapporteur(c.id, 'pregen', prep.bundle!);
    const a = Rr.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'pregen' }, { ...Rr.t6EvaluationDefaultDeps, runs: storeA, report: rapA });
    await pause(1_300);
    // Instance B (autre mémoire) : le bail de A a expiré — reprise, interruption tracée.
    Rr.resetT6EvaluationState();
    const b = await Rr.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'display' });
    expect(b.status).toBe('generated');
    expect(b.run).toMatchObject({ claimed: true, interrupted: [id] });
    const apresB = (await run(c.id, id))!;
    expect(apresB).toMatchObject({ status: 'COMPLETED', attempts: 2, interrupted_count: 1, run_id: b.run!.runId });
    expect(await decision(c.id, id)).toMatchObject({ decision: 'SUPPRESS' });
    // A se termine : sa décision (plus ancienne) n'est JAMAIS écrite, ni son état.
    const oa = await a;
    expect(oa.status).toBe('persist_failed');
    expect(oa.notPersisted).toEqual([{ subjectId: 'C1', reason: 'ownership_lost' }]);
    expect(oa.run).toMatchObject({ claimed: true, ownershipLost: [id], notClosed: [id] });
    expect(await decision(c.id, id)).toMatchObject({ decision: 'SUPPRESS' });
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    const rap = (await rapports(c.id, 'evaluate:pregen')).at(-1)!;
    expect(rap.status).toBe('FAILED');
    expect(rap.counters).toMatchObject({ runOwnershipLost: 1, persisted: 0 });
    expect(appels()).toBe(2);
  });

  it('L81B-D3 — deux connexions : persistance sous verrou, reprise sérialisée, instance dépossédée sans propriété', async () => {
    const c = await compte();
    const id = await echeance(c, 'Ravalement', await plus(40));
    const S = await RUNS();
    const sujets = [{ agendaItemId: id, fingerprint: 'v4:d3', signature: null }];
    const a = await S.claimT6Runs({ accountId: c.id, runId: 'run-a', mode: 'pregen', subjects: sujets, leaseMs: 1_000 });
    expect(a.ok).toBe(true);
    await pause(1_100); // bail de A expiré
    const cnx = await sql.reserve();
    try {
      await cnx.unsafe('BEGIN');
      const tq = async (q: string, p: unknown[]) => (await cnx.unsafe(q, p as never)) as unknown as Array<Record<string, unknown>>;
      // A écrit sous verrou (connexion 1) : il détient encore la ligne.
      expect([...await S.lockOwnedT6Runs(tq, { accountId: c.id, runId: 'run-a', ids: [id] })]).toEqual([id]);
      // B tente la reprise (connexion 2) : bloquée tant que A n'a pas validé.
      let fini = false;
      const b = S.claimT6Runs({ accountId: c.id, runId: 'run-b', mode: 'pregen', subjects: sujets }).finally(() => { fini = true; });
      await pause(300);
      expect(fini).toBe(false);
      await cnx.unsafe('COMMIT');
      // A a prolongé le bail en écrivant : B est refusée (aucune double exécution).
      expect(await b).toMatchObject({ ok: false, reason: 'running_elsewhere' });
      // Bail expiré de nouveau : B reprend, A ne détient plus rien.
      await sql`UPDATE t6_evaluation_runs SET lease_until = now() - interval '1 second' WHERE agenda_item_id = ${id}`;
      expect(await S.claimT6Runs({ accountId: c.id, runId: 'run-b', mode: 'pregen', subjects: sujets })).toMatchObject({ ok: true, interrupted: [id] });
      await cnx.unsafe('BEGIN');
      expect([...await S.lockOwnedT6Runs(tq, { accountId: c.id, runId: 'run-a', ids: [id] })]).toEqual([]);
      await cnx.unsafe('ROLLBACK');
      expect(await S.renewT6Runs({ accountId: c.id, runId: 'run-a', ids: [id] })).toEqual([]);
      expect(await S.finishT6Runs({ accountId: c.id, runId: 'run-a', results: [{ agendaItemId: id, outcome: 'COMPLETED' }] })).toEqual([]);
      expect(await run(c.id, id)).toMatchObject({ status: 'RUNNING', run_id: 'run-b' });
    } finally {
      // Jamais une connexion rendue au pool au milieu d'une transaction.
      await cnx.unsafe('ROLLBACK').catch(() => undefined);
      cnx.release();
    }
  });

  // ── E ──────────────────────────────────────────────────────────────────────

  /** `n` comptes dont une évaluation est en échec définitif (FAILED). */
  async function comptesBloques(n: number): Promise<number[]> {
    const ids: number[] = [];
    const owner = await make.user();
    for (let i = 0; i < n; i += 1) {
      const a = await make.account({ owner });
      const [e] = await sql<Array<{ id: number }>>`INSERT INTO agenda_items (account_id, title, start_date) VALUES (${a.id}, 'Échéance', current_date + 20) RETURNING id`;
      await sql`INSERT INTO t6_evaluation_runs (agenda_item_id, account_id, status, attempts, last_error_kind, finished_at)
                VALUES (${e.id}, ${a.id}, 'FAILED', 3, 'rejected', now() - interval '1 hour')`;
      ids.push(a.id);
    }
    return ids;
  }
  const actif = async () => ({ state: 'active' as const });

  it('L81B-E1 — plus de 200 comptes bloqués : balayage paginé complet, aucun compte perdu', async () => {
    const mes = await comptesBloques(205);
    const S = await RUNS();
    const vus = new Set<number>();
    const res = await S.superviseT6Evaluations({ report: async (x) => { vus.add(Number(x.accountId)); return 1; }, resolve: async () => false, scheduler: actif });
    expect(res.complete).toBe(true);
    expect(res.pages).toBeGreaterThanOrEqual(2);
    expect(mes.filter((x) => !vus.has(x))).toEqual([]);
  });

  it('L81B-E2 — compte absent des 200 premiers résultats : jamais résolu par absence, filtre dans la requête', async () => {
    const mes = await comptesBloques(203);
    const dernier = mes[mes.length - 1];
    const S = await RUNS();
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({ domain: 'ai', fingerprint: S.t6EvaluationAnomalyFingerprint(dernier), accountId: dernier, title: 'T6 bloquée', detail: { kind: 't6_evaluation' } });
    // Filtre du compte DANS la requête : trouvé même au-delà des 200 premiers.
    expect(await S.blockedT6Accounts(30, { onlyAccountId: dernier })).toEqual([expect.objectContaining({ accountId: dernier, failed: 1 })]);
    const r1 = await S.superviseT6Evaluations({ onlyAccountId: dernier, scheduler: actif });
    expect(r1).toMatchObject({ blockedAccounts: 1, reported: 1, resolved: 0 });
    expect(await anomalie(S.t6EvaluationAnomalyFingerprint(dernier))).toMatchObject({ status: 'open' });
    // Balayage global INCOMPLET (une page de 200) : l'anomalie du compte non lu
    // est vérifiée positivement — toujours bloqué, elle reste ouverte.
    const resolus: string[] = [];
    const r2 = await S.superviseT6Evaluations({ pageSize: 200, maxPages: 1, scheduler: actif, resolve: async (fp) => { resolus.push(fp); return true; } });
    expect(r2.complete).toBe(false);
    expect(resolus).not.toContain(S.t6EvaluationAnomalyFingerprint(dernier));
    expect(await anomalie(S.t6EvaluationAnomalyFingerprint(dernier))).toMatchObject({ status: 'open' });
  });

  it('L81B-E3 — compteurs et causes des seules évaluations bloquées ; résolution après vérification positive', async () => {
    const c = await compte();
    const ids = [] as number[];
    for (let i = 0; i < 4; i += 1) ids.push(await echeance(c, `Échéance ${i}`, await plus(20 + i)));
    await sql`INSERT INTO t6_evaluation_runs (agenda_item_id, account_id, status, attempts, last_error_kind, finished_at, next_attempt_at) VALUES
      (${ids[0]}, ${c.id}, 'FAILED', 3, 'rejected', now(), NULL),
      (${ids[1]}, ${c.id}, 'FAILED', 3, 'rejected', now(), NULL),
      (${ids[2]}, ${c.id}, 'FAILED', 3, 'invalid_output', now(), NULL),
      (${ids[3]}, ${c.id}, 'RETRY_WAIT', 1, 'model_unavailable', now(), now() + interval '10 minutes')`;
    const S = await RUNS();
    const [b] = await S.blockedT6Accounts(30, { onlyAccountId: c.id });
    expect(b).toMatchObject({ failed: 3, overdueRetry: 0, incomplete: 4, kinds: { rejected: 2, invalid_output: 1 } });
    expect(b.kinds.model_unavailable).toBeUndefined();
    await S.superviseT6Evaluations({ onlyAccountId: c.id, scheduler: actif });
    const an = (await anomalie(S.t6EvaluationAnomalyFingerprint(c.id)))!;
    expect(an.technical_detail.causes).toEqual(['invalid_output', 'rejected']);
    // Encore bloqué : maintenue ; retour réel à la normale : résolue.
    await sql`UPDATE t6_evaluation_runs SET status = 'COMPLETED' WHERE agenda_item_id IN (${ids[0]}, ${ids[1]})`;
    await S.superviseT6Evaluations({ onlyAccountId: c.id, scheduler: actif });
    expect(await anomalie(S.t6EvaluationAnomalyFingerprint(c.id))).toMatchObject({ status: 'open' });
    await sql`UPDATE t6_evaluation_runs SET status = 'COMPLETED' WHERE agenda_item_id = ${ids[2]}`;
    const r = await S.superviseT6Evaluations({ onlyAccountId: c.id, scheduler: actif });
    expect(r.resolved).toBe(1);
    expect(await anomalie(S.t6EvaluationAnomalyFingerprint(c.id))).toMatchObject({ status: 'resolved', resolution_source: 'auto' });
  });

  // ── F ──────────────────────────────────────────────────────────────────────

  it('L81B-F1 — arrêt complet de mascot-pregeneration : scheduler_inactive produit par la tâche de supervision, sans visite', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrat entretien', await plus(30));
    const S = await RUNS();
    await S.requestT6Runs(c.id, [{ agendaItemId: id, fingerprint: 'v4:f', signature: null }]);
    await sql`UPDATE t6_evaluation_runs SET requested_at = now() - interval '2 hours' WHERE account_id = ${c.id}`;
    await (await Q()).requestMascotPregeneration(c.id, 'test');
    // Tâche ARRÊTÉE (suspendue depuis le BO, plus aucun passage).
    await sql`INSERT INTO scheduled_task_state (code, last_started_at, last_finished_at, admin_disabled)
              VALUES ('mascot-pregeneration', now() - interval '3 hours', now() - interval '3 hours', true)
              ON CONFLICT (code) DO UPDATE SET last_started_at = EXCLUDED.last_started_at, last_finished_at = EXCLUDED.last_finished_at, admin_disabled = true`;
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const tache = findTask('mascot-t6-supervision')!;
    expect(tache.critical).toBeTruthy();
    const res = await tache.run({ deadline: Date.now() + 60_000, trigger: 'schedule' });
    expect(res && 'error' in res ? res.error : undefined).toBeUndefined();
    // Anomalie du compte : cause scheduler_inactive.
    const an = (await anomalie(S.t6EvaluationAnomalyFingerprint(c.id)))!;
    expect(an.status).toBe('open');
    expect(an.technical_detail).toMatchObject({ schedulerActive: false, stalePending: 1 });
    expect(an.technical_detail.causes).toEqual(['scheduler_inactive']);
    // Anomalie globale : tâche inactive, comptes en attente identifiés.
    const g = (await anomalie(S.T6_PREGEN_SCHEDULER_ANOMALY))!;
    expect(g.status).toBe('open');
    expect(g.technical_detail).toMatchObject({ kind: 't6_pregen_scheduler', cause: 'scheduler_inactive', adminDisabled: true });
    expect(Number(g.technical_detail.accountsWaiting)).toBeGreaterThanOrEqual(1);
    expect(Number(g.technical_detail.pendingRequests)).toBeGreaterThanOrEqual(1);
    // La tâche redémarre : l'anomalie globale est résolue (preuve d'activité).
    await sql`UPDATE scheduled_task_state SET admin_disabled = false, last_started_at = now(), last_finished_at = now() WHERE code = 'mascot-pregeneration'`;
    await tache.run({ deadline: Date.now() + 60_000, trigger: 'schedule' });
    expect(await anomalie(S.T6_PREGEN_SCHEDULER_ANOMALY)).toMatchObject({ status: 'resolved', resolution_source: 'auto' });
    expect((await anomalie(S.t6EvaluationAnomalyFingerprint(c.id)))!.technical_detail.causes).toEqual(['not_picked_up']);
  });

  // ── G ──────────────────────────────────────────────────────────────────────

  it('L81B-G1 — clôture technique en échec après persistance métier : rapport PARTIAL, puis clôture rattrapée sans appel IA', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle toiture', await plus(19));
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l81b_cloture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'COMPLETED' AND OLD.status = 'RUNNING' AND NEW.account_id = ${c.id} THEN RAISE EXCEPTION 'clôture refusée (l81b)'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER l81b_cloture BEFORE UPDATE ON t6_evaluation_runs FOR EACH ROW EXECUTE FUNCTION l81b_cloture()`);
    try {
      await (await Q()).requestMascotPregeneration(c.id, 'test');
      await (await Q()).processMascotPregenerationFor(c.id);
      // Persistance métier réussie…
      expect(await decision(c.id, id)).toMatchObject({ decision: 'SHOW_NOW' });
      // … clôture technique en échec : jamais COMPLETED inventé.
      expect(await run(c.id, id)).toMatchObject({ status: 'RUNNING' });
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS l81b_cloture ON t6_evaluation_runs`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS l81b_cloture()`);
    }
    const [rap] = await rapports(c.id, 'evaluate:pregen');
    expect(rap.status).toBe('PARTIAL');
    expect(rap.counters).toMatchObject({ persisted: 1, runNotClosed: 1 });
    const etape = rap.steps.find((s) => s.step === 'run_state')!;
    expect(etape).toMatchObject({ status: 'FAILED' });
    expect(String(etape.error)).toContain('clôture refusée');
    // Reprise durable programmée après l'expiration du bail (sans visite).
    await pause(100);
    const d = (await demande(c.id))!;
    expect(d).toMatchObject({ en_attente: true, reason: 't6-close-retry', futur: true });
    // Le bail expire ; la pré-génération rattrape la clôture SANS appel IA.
    await sql`UPDATE t6_evaluation_runs SET lease_until = now() - interval '1 second' WHERE account_id = ${c.id}`;
    await demandeDue(c.id);
    expect((await (await Q()).runMascotPregeneration({ batch: 50 })).claimed).toBe(1);
    expect(await run(c.id, id)).toMatchObject({ status: 'COMPLETED', run_id: null });
    expect((await run(c.id, id))!.last_outcome).toContain('clôture rattrapée');
    expect(appels()).toBe(1);
  });

  it('L81B-G2 — refus de prise tracé (NO_CHANGE, motif, instant attendu), sans rapport répété', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle ascenseur', await plus(13));
    const prep = await preparer(c.id);
    await sql`UPDATE t6_evaluation_runs SET status = 'RUNNING', run_id = 'ailleurs', attempts = 1, started_at = now(), lease_until = now() + interval '4 minutes'
              WHERE account_id = ${c.id}`;
    const Rr = await R();
    const deps = { ...Rr.t6EvaluationDefaultDeps, report: rapporteur(c.id, 'display', prep.bundle!) };
    const o = await Rr.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'display' }, deps);
    expect(o).toMatchObject({ status: 'skipped', run: { claimed: false, refusal: { reason: 'running_elsewhere', agendaItemId: id } } });
    Rr.resetT6EvaluationState();
    await Rr.evaluateWithT6({ accountId: c.id, bundle: prep.bundle!, mode: 'display' }, deps);
    const liste = await rapports(c.id, 'evaluate:display');
    expect(liste).toHaveLength(1);
    expect(liste[0].status).toBe('NO_CHANGE');
    const etape = liste[0].steps.find((s) => s.step === 'evaluate')!;
    expect(etape).toMatchObject({ status: 'SKIPPED', detail: { refusal: { reason: 'running_elsewhere' } } });
    expect(appels()).toBe(0);
  });
});
