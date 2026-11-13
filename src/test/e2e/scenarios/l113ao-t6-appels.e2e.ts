/**
 * Lot 113AO — Trello #748 « [P1][Pré-MEP] T6 — Supprimer les appels Gemini
 * inutiles et fiabiliser l'attribution, l'idempotence et les erreurs » — de
 * bout en bout sur PostgreSQL 16 réel : vrai collecteur, vraie décision, vraie
 * passerelle IA (fournisseur SIMULÉ avec compteur d'appels, aucun réseau),
 * vraie file de pré-génération, vraies traces d'appels (`ai_usage_event`),
 * vraie projection des exécutions métier, vrai rattrapage.
 *
 *  AC01  1 document en analyse : état visible tout de suite, 0 appel t6_formulate
 *  AC02  3 documents puis fin d'une analyse : compteur exact, 0 appel, aucun message perdu
 *  AC03  échéance à texte déterministe vérifié (rappel informatif) : 0 appel de formulation
 *  AC04  échéance à traiter (reformulation utile) : un appel autorisé, texte validé
 *  AC05  2 sujets dont un déterministe : seul l'autre part à FORMULATE, ordre stable
 *  AC06  fin d'une analyse T1 (contexte du travail hérité par la minuterie) :
 *        EVALUATE hors connexion ; appels rattachés à T6F / T6E, T1 = déclencheur
 *  AC07  rattrapage historique (appel 15112) : prouvé, idempotent, restaurable ;
 *        compteurs T1 / T6 de la projection cohérents, aucun double compte
 *  AC10  EVALUATE tronquée : fractionnement sans perte, puis échec loyal OUTPUT_TRUNCATED
 *  AC11  refus 403 simulé : cause provider_refused, RETRY borné, aucune boucle
 *  AC12  compte inéligible : aucun appel ; réactivé : reprise ; actif déconnecté : EVALUATE
 *  AC13  Duo : préférences de l'utilisateur à l'affichage, pré-génération commune neutre
 *  AC08  deux « workers » (deux instances de modules, deux pools) à ~50 ms sur la
 *        même demande (scénario 15150 / 15151) : 1 seul appel, le second sert le cache
 *  AC09  demandes distinctes : 2 appels ; bail vivant : aucun appel ; bail expiré
 *        (arrêt brutal) : reprise, 1 appel
 *  AC14  aucun appel supplémentaire au réaffichage, affichage non retardé ;
 *        changement de prompt : nouvelle clé, nouvel appel
 * (AC08, AC09 et AC14 en fin de fichier : ils rechargent les modules.)
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

interface Candidat { subjectId: string; title: string; evidence: Array<{ ref: string; kind: string }> }

const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Record<string, unknown> => ({}),
  evaluate: [] as Candidat[][],
  formulate: [] as Array<Array<{ subjectId: string; sourceCode: string }>>,
  /** Taille de lot au-delà de laquelle la sortie EVALUATE est tronquée (MAX_TOKENS). */
  tronqueAuDela: Infinity,
  refus403: false,
}));

function provider() {
  return {
    name: 'simule-l113ao',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        modele.evaluate.push(ctx.candidates);
        if (modele.refus403) throw Object.assign(new Error('[403 Forbidden] PERMISSION_DENIED: Permission denied on resource (simulé)'), { status: 403 });
        if (ctx.candidates.length > modele.tronqueAuDela) {
          return { rawText: '{"schemaVersion":"t6-evaluation-v1","decisions":[{"subjectId":"C1","decision":"SUPP', inputTokens: 200, outputTokens: 512, meta: { finishReason: 'MAX_TOKENS' } };
        }
        const decisions = ctx.candidates.map((c) => ({
          subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, uncertainties: [],
          evidenceRefs: [c.evidence.find((x) => x.kind === 'DUE_DATE')?.ref ?? c.evidence[0].ref],
          ...AUCUNE, ...modele.juger(c),
        }));
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; sourceCode: string; fallbackText: string }> };
      modele.formulate.push(entree.subjects.map((s) => ({ subjectId: s.subjectId, sourceCode: s.sourceCode })));
      return {
        rawText: JSON.stringify({ schemaVersion: 't6-output-v2', messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })), suggestions: [] }),
        inputTokens: 4000, outputTokens: 90,
      };
    },
  };
}

const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', priorityHint: 'LOW' };
const AGIR = { decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.', expectedAction: 'Prendre rendez-vous avec le prestataire', priorityHint: 'MEDIUM' };
const RAPPEL = { decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER', reason: 'La visite est prévue dans quelques jours : le rappel est utile, aucune démarche n’est attendue.', priorityHint: 'LOW' };

scenario('L113AO-T6', 'Lot 113AO — T6 : appels évitables, attribution T1/T6, idempotence interinstances, erreurs EVALUATE', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    Object.assign(modele, { juger: () => AGIR, tronqueAuDela: Infinity, refus403: false });
    modele.evaluate.length = 0; modele.formulate.length = 0;
    const R = await import('@/services/home/mascot/t6-runner');
    R.resetT6Breaker(); R.resetT6EvaluationState(); R.resetT6RecentFailures();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
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
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type P = import('@/services/home/mascot/types').MascotPresentation;
  const sujets = (p: P) => p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR');

  async function compte(plan: 'premium' | 'premium_duo' = 'premium') {
    const a = await make.account({ plan });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    // Un document déjà analysé : pas de sujet d'accompagnement (« premier document »).
    const f = await make.assetFile(a, { assetId: maison.id });
    await sql`UPDATE asset_files SET retained_title = 'Diagnostic termites', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return { ...a, maison: maison.id };
  }
  async function enAnalyse(c: { maison: number } & Parameters<typeof make.assetFile>[0], titre: string, ilYaS = 0) {
    const f = await make.assetFile(c, { assetId: c.maison });
    await sql`UPDATE asset_files SET retained_title = ${titre}, analysis_state = 'ANALYZING', upload_status = 'COMPLETED',
                     updated_at = now() - make_interval(secs => ${ilYaS}) WHERE id = ${f.id}`;
    return f.id;
  }
  async function echeance(c: { id: number; maison: number }, titre: string, date: string) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action' WHERE id = ${e.id}`;
    return e.id;
  }
  const appels = async (accountId: number, op: string) =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_usage_event WHERE account_id = ${accountId} AND operation_type = ${op}`)[0].n;
  const pregen = async (accountId: number) => {
    await (await Q()).requestMascotPregeneration(accountId, 'e2e');
    return (await Q()).processMascotPregenerationFor(accountId);
  };
  const afficher = async (c: { id: number; ownerUserId: number }) => (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
  const presentationPregen = async (accountId: number) => (await svc()).getMascotPresentation(accountId, 'pregen', null);

  // ── A : appels FORMULATE évitables ─────────────────────────────────────────

  it('AC01 — 1 document en cours d’analyse : état visible immédiatement, 0 appel t6_formulate (affichage et pré-génération)', async () => {
    const c = await compte();
    await enAnalyse(c, 'Facture chaudière');
    const t0 = Date.now();
    const p = await afficher(c);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(sujets(p).map((x) => x.sourceCode)).toEqual(['PROC-DOC-ANALYSIS']);
    expect(sujets(p)[0].text).toMatch(/^Le document « Facture chaudière » est en cours d’analyse\.$/);
    expect(p.source).toBe('deterministic');
    expect(await pregen(c.id)).toBe('deterministic');
    await pause(200);
    expect(modele.formulate).toHaveLength(0);
    expect(await appels(c.id, 't6_formulate')).toBe(0);
    // Demande close (jamais relancée comme un « secours ») ; formulation évitée mesurée.
    const [d] = await sql<{ last_status: string; traitee: boolean }[]>`
      SELECT last_status, processed_at >= requested_at AS traitee FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`;
    expect(d).toEqual({ last_status: 'deterministic', traitee: true });
    const [m] = await sql<{ status: string; source_codes: string[]; hits: number }[]>`
      SELECT status, source_codes, hits FROM t6_formulate_reservations WHERE account_id = ${c.id}`;
    expect(m).toMatchObject({ status: 'DETERMINISTIC', source_codes: ['PROC-DOC-ANALYSIS'] });
  });

  it('AC02 — plusieurs documents, uploads et fin d’analyse rapprochés : compteur exact, 0 appel de formulation, aucun message perdu', async () => {
    const c = await compte();
    const a = await enAnalyse(c, 'Contrat assurance', 30);
    await enAnalyse(c, 'Devis toiture', 20);
    await enAnalyse(c, 'Facture chaudière', 10);
    const p1 = await afficher(c);
    expect(sujets(p1)[0].text).toBe('3 documents sont en cours d’analyse, dont « Facture chaudière ».');
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED' WHERE id = ${a}`;
    expect(await pregen(c.id)).toBe('deterministic');
    const p2 = await afficher(c);
    expect(sujets(p2)[0].text).toBe('2 documents sont en cours d’analyse, dont « Facture chaudière ».');
    await pause(200);
    expect(modele.formulate).toHaveLength(0);
    expect(await appels(c.id, 't6_formulate')).toBe(0);
  });

  it('AC03 — échéance à texte déterministe vérifié (rappel informatif) : 0 appel de formulation, date et ancrage identiques', async () => {
    modele.juger = () => RAPPEL;
    const c = await compte();
    const date = await plus(6);
    const id = await echeance(c, 'Visite annuelle de la chaudière', date);
    await presentationPregen(c.id);
    const p = await presentationPregen(c.id);
    const s = sujets(p);
    expect(s.map((x) => x.reminder?.agendaItemId)).toEqual([id]);
    expect(modele.evaluate.length).toBeGreaterThanOrEqual(1);
    expect(modele.formulate).toHaveLength(0);
    expect(await appels(c.id, 't6_formulate')).toBe(0);
    const { formatDateFr } = await import('@/services/home/mascot/signals');
    expect(s[0].text).toContain(formatDateFr(date));
    expect(s[0].highlight).not.toBeNull();
    expect(p.source).toBe('deterministic');
  });

  it('AC04 / AC05 — échéance à traiter + document en analyse : seul le sujet contextuel part à FORMULATE ; bulle à 2 sujets, ordre stable', async () => {
    modele.juger = () => AGIR;
    const c = await compte();
    await enAnalyse(c, 'Facture chaudière');
    const id = await echeance(c, 'Ramonage', await plus(20));
    await presentationPregen(c.id);
    const p = await presentationPregen(c.id);
    expect(sujets(p).map((x) => x.sourceCode)).toEqual(['PROC-DOC-ANALYSIS', 'DATE-NEXT']);
    expect(sujets(p)[1].reminder?.agendaItemId).toBe(id);
    expect(modele.formulate.length).toBeGreaterThanOrEqual(1);
    for (const lot of modele.formulate) expect(lot.map((x) => x.sourceCode)).toEqual(['DATE-NEXT']);
    expect(p.source).toBe('t6');
    expect(sujets(p)[0].text).toBe('Le document « Facture chaudière » est en cours d’analyse.');
  });

  // ── B : attribution T1 / T6 ────────────────────────────────────────────────

  it('AC06 — fin d’une analyse T1 (contexte du travail hérité par la minuterie) : EVALUATE hors connexion, appels rattachés à T6F / T6E, T1 = déclencheur', async () => {
    modele.juger = () => AGIR;
    const c = await compte();
    await echeance(c, 'Contrôle chaudière', await plus(15));
    const { runInJobContext } = await import('@/services/ai/queue/job-context');
    // Même chemin que `notifyLotCompleted` : la pré-génération est programmée DEPUIS le travail T1.
    await runInJobContext({ jobId: null, treatment: 'T1', configVersionId: null, businessExecutionId: 'T1:job:3575', triggerCode: 'UPLOAD' }, async () => {
      (await svc()).scheduleMascotPregeneration(c.id, 50, 'DOCUMENT_ANALYSIS_COMPLETED');
    });
    for (let i = 0; i < 200 && (await appels(c.id, 't6_formulate')) === 0; i++) await pause(100);
    for (let i = 0; i < 50; i++) {
      const [r] = await sql<{ fini: boolean }[]>`SELECT processed_at IS NOT NULL AS fini FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`;
      if (r?.fini) break;
      await pause(100);
    }
    const lignes = await sql<Array<{ op: string; bex: string | null; cause: string | null; job: number | null; trace: string; ids: unknown }>>`
      SELECT operation_type AS op, business_execution_id AS bex, metadata->>'causedByExecutionId' AS cause, job_id AS job,
             metadata->>'traceId' AS trace, metadata->'businessExecutionIds' AS ids
        FROM ai_usage_event WHERE account_id = ${c.id} AND operation_type IN ('t6_formulate', 't6_evaluate') ORDER BY id`;
    expect(lignes.map((l) => l.op)).toEqual(expect.arrayContaining(['t6_evaluate', 't6_formulate']));
    for (const l of lignes) {
      expect(l.bex ?? '').not.toMatch(/^T1:/);
      expect(l.cause).toBe('T1:job:3575');
      expect(l.job).toBeNull();
      if (l.op === 't6_formulate') expect(l.bex).toBe(`T6F:${l.trace}`);
      else expect(l.bex).toMatch(/^T6E:\d+:\d+$/);
    }
    const [d] = await sql<{ t: string | null }[]>`SELECT trigger_execution_id AS t FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`;
    expect(d.t).toBe('T1:job:3575');
    // Projection BO : l'exécution T6F compte son appel ; T1:job:3575 n'en compte aucun.
    const { callsOfExecutions } = await import('@/services/ai/business-execution/repository');
    const f = lignes.find((l) => l.op === 't6_formulate')!;
    const m = await callsOfExecutions([{ id: `T6F:${f.trace}`, traceIds: [f.trace] }, { id: 'T1:job:3575', traceIds: [] }]);
    expect(m.get(`T6F:${f.trace}`)?.calls).toBe(1);
    expect(m.get('T1:job:3575')?.calls).toBe(0);
  });

  it('AC07 — rattrapage de l’historique (cas de l’appel 15112) : prouvé, idempotent, audité, restaurable ; appels T1 légitimes intacts', async () => {
    modele.juger = () => AGIR;
    const c = await compte();
    await echeance(c, 'Révision chaudière', await plus(15));
    await presentationPregen(c.id);
    await presentationPregen(c.id);
    const [f] = await sql<{ id: number; trace: string }[]>`
      SELECT id, metadata->>'traceId' AS trace FROM ai_usage_event WHERE account_id = ${c.id} AND operation_type = 't6_formulate' ORDER BY id LIMIT 1`;
    expect(f).toBeDefined();
    // Historique d'avant le correctif : appel T6 rattaché à l'exécution T1 qui avait demandé la pré-génération.
    await sql`UPDATE ai_usage_event SET business_execution_id = 'T1:job:3575', metadata = metadata - 'causedByExecutionId' WHERE id = ${f.id}`;
    // Appel T6 sans génération correspondante (non prouvable) et appel T1 légitime : jamais touchés.
    const [nonProuve] = await sql<{ id: number }[]>`
      INSERT INTO ai_usage_event (account_id, operation_type, provider, model, is_billable, input_tokens, output_tokens, duration_ms, status, metadata, business_execution_id)
      VALUES (${c.id}, 't6_formulate', 'gemini', 'm', false, 10, 1, 5, 'success', ${JSON.stringify({ traceId: 'trace-sans-generation' })}::jsonb, 'T1:job:3575') RETURNING id`;
    const [t1] = await sql<{ id: number }[]>`
      INSERT INTO ai_usage_event (account_id, operation_type, provider, model, is_billable, input_tokens, output_tokens, duration_ms, status, metadata, business_execution_id)
      VALUES (${c.id}, 't1_analyze_document', 'gemini', 'm', true, 10, 1, 5, 'success', ${JSON.stringify({ traceId: 'trace-t1' })}::jsonb, 'T1:job:3575') RETURNING id`;
    const M = await import('@/services/home/mascot/t6-attribution-repair');
    const q = async (t: string, p?: unknown[]) => (await sql.unsafe(t, (p ?? []) as never[])) as unknown as Array<Record<string, unknown>>;
    const sim = await M.runT6AttributionRepair({ q, apply: false, accountId: c.id });
    expect(sim).toMatchObject({ examined: 2, proven: { formulate: 1, evaluate: 0 }, unproven: 1, written: 0, runId: null });
    expect((await sql`SELECT business_execution_id AS b FROM ai_usage_event WHERE id = ${f.id}`)[0].b).toBe('T1:job:3575');
    const app = await M.runT6AttributionRepair({ q, apply: true, accountId: c.id, reason: 'recette 113AO' });
    expect(app.written).toBe(1);
    const [apres] = await sql<{ b: string; cause: string; rep: { runId: string; previous: string } }[]>`
      SELECT business_execution_id AS b, metadata->>'causedByExecutionId' AS cause, metadata->'t6AttributionRepair' AS rep FROM ai_usage_event WHERE id = ${f.id}`;
    expect(apres).toMatchObject({ b: `T6F:${f.trace}`, cause: 'T1:job:3575', rep: { runId: app.runId, previous: 'T1:job:3575' } });
    expect((await sql`SELECT business_execution_id AS b FROM ai_usage_event WHERE id = ${nonProuve.id}`)[0].b).toBe('T1:job:3575');
    expect((await sql`SELECT business_execution_id AS b FROM ai_usage_event WHERE id = ${t1.id}`)[0].b).toBe('T1:job:3575');
    // Idempotent : relancé, rien n'est réécrit.
    expect((await M.runT6AttributionRepair({ q, apply: true, accountId: c.id, reason: 'relance' })).written).toBe(0);
    // Compteurs de la projection : T6F retrouve son appel, T1 garde seulement les siens (aucun double compte).
    const { callsOfExecutions } = await import('@/services/ai/business-execution/repository');
    const m = await callsOfExecutions([{ id: `T6F:${f.trace}`, traceIds: [f.trace] }, { id: 'T1:job:3575', traceIds: [] }]);
    expect(m.get(`T6F:${f.trace}`)?.usageEventIds).toEqual([f.id]);
    expect(m.get('T1:job:3575')?.usageEventIds).toEqual([nonProuve.id, t1.id].sort((x, y) => x - y));
    // Restauration exacte.
    const r = await M.restoreT6AttributionRepair(app.runId!, q);
    expect(r).toMatchObject({ restored: 1, skipped: 0 });
    expect((await sql`SELECT business_execution_id AS b, metadata ? 't6AttributionRepair' AS rep FROM ai_usage_event WHERE id = ${f.id}`)[0]).toEqual({ b: 'T1:job:3575', rep: false });
    // Rapport BO du rattrapage (même résumé que la page Rattrapages).
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    expect(summarizeBackfill('t6-execution-attribution', 'simulate', null, { result: sim }).headline).toMatch(/1 rattachable\(s\) avec preuve, 1 non prouvé/);
  });

  // ── D : EVALUATE, troncature et refus ──────────────────────────────────────

  it('AC10 — sortie EVALUATE tronquée : lot fractionné sans perte (toutes les décisions enregistrées) ; un seul candidat tronqué : échec loyal OUTPUT_TRUNCATED', async () => {
    modele.juger = () => AUCUNE;
    const c = await compte();
    const ids = [await echeance(c, 'Assurance habitation', await plus(10)), await echeance(c, 'Ramonage', await plus(12)), await echeance(c, 'Révision chaudière', await plus(14))];
    modele.tronqueAuDela = 2;
    await presentationPregen(c.id);
    // Appels fournisseur : le lot de 3 (tronqué, secours compris), puis 2 + 1 — aucun candidat supprimé.
    expect(new Set(modele.evaluate.map((x) => x.length))).toEqual(new Set([3, 2, 1]));
    expect(new Set(modele.evaluate.filter((x) => x.length < 3).flatMap((x) => x.map((c) => c.title)))).toEqual(new Set(['Assurance habitation', 'Ramonage', 'Révision chaudière']));
    const runs = await sql<{ agenda_item_id: number; status: string }[]>`SELECT agenda_item_id, status FROM t6_evaluation_runs WHERE account_id = ${c.id} ORDER BY agenda_item_id`;
    expect(runs).toEqual(ids.map((id) => ({ agenda_item_id: id, status: 'COMPLETED' })));
    // Troncature persistante jusqu'à un candidat : aucune suppression, aucune boucle, cause primaire explicite.
    const d = await compte();
    const id = await echeance(d, 'Contrôle technique', await plus(9));
    modele.tronqueAuDela = 0;
    modele.evaluate.length = 0;
    await presentationPregen(d.id);
    const [r] = await sql<{ status: string; last_error_kind: string; last_error: string; last_outcome: string }[]>`
      SELECT status, last_error_kind, last_error, last_outcome FROM t6_evaluation_runs WHERE account_id = ${d.id} AND agenda_item_id = ${id}`;
    expect(r).toMatchObject({ status: 'FAILED', last_error_kind: 'output_truncated' });
    expect(r.last_outcome).toMatch(/sortie tronquée/);
    expect(r.last_outcome).toMatch(/1 candidat/);
    const n = modele.evaluate.length;
    await presentationPregen(d.id);
    expect(modele.evaluate.length).toBe(n);
    // Projection BO : jamais T6_EVALUATE_MODEL_UNAVAILABLE pour une troncature.
    const { qualifyT6Evaluate } = await import('@/services/ai/business-execution/mapping');
    const [x] = await sql<Array<Record<string, unknown>>>`SELECT * FROM t6_evaluation_runs WHERE account_id = ${d.id} AND agenda_item_id = ${id}`;
    const qual = qualifyT6Evaluate({
      agendaItemId: id, status: String(x.status), attempts: Number(x.attempts), requestedAt: x.requested_at as Date, startedAt: x.started_at as Date, finishedAt: x.finished_at as Date,
      updatedAt: x.updated_at as Date, leaseUntil: null, nextAttemptAt: null, lastErrorKind: String(x.last_error_kind), lastError: String(x.last_error), lastOutcome: String(x.last_outcome), mode: null,
    }, new Date());
    expect(JSON.stringify(qual)).toMatch(/T6_EVALUATE_OUTPUT_TRUNCATED/);
    expect(JSON.stringify(qual)).not.toMatch(/MODEL_UNAVAILABLE/);
  });

  it('AC11 — refus 403 simulé : cause provider_refused tracée, nouvel essai planifié (borné), aucune boucle ni troncature', async () => {
    modele.refus403 = true;
    const c = await compte();
    const id = await echeance(c, 'Assurance auto', await plus(10));
    await presentationPregen(c.id);
    const [r] = await sql<{ status: string; last_error_kind: string; last_error: string; futur: boolean }[]>`
      SELECT status, last_error_kind, last_error, next_attempt_at > now() AS futur FROM t6_evaluation_runs WHERE account_id = ${c.id} AND agenda_item_id = ${id}`;
    expect(r).toMatchObject({ status: 'RETRY_WAIT', last_error_kind: 'provider_refused', futur: true });
    expect(r.last_error).toMatch(/403|PERMISSION_DENIED/);
    const n = modele.evaluate.length;
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    await presentationPregen(c.id);
    expect(modele.evaluate.length).toBe(n);
  });

  // ── E : éligibilité, hors connexion, Duo ───────────────────────────────────

  it('AC12 — compte inéligible (impayé) : aucune génération ; réactivé : reprise ; compte actif sans session : EVALUATE exécutée', async () => {
    const E = await import('@/services/account/processing-eligibility');
    const L = await import('@/services/account/processing-lifecycle');
    const c = await compte();
    await L.syncAccountEligibility(c.id, { source: 'e2e', now: new Date() });
    await enAnalyse(c, 'Facture chaudière');
    await echeance(c, 'Ramonage', await plus(15));
    await sql`UPDATE account_subscriptions SET status = 'past_due' WHERE account_id = ${c.id}`;
    E.invalidateProcessingEligibility();
    await afficher(c);
    await presentationPregen(c.id);
    await pause(300);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_usage_event WHERE account_id = ${c.id}`)[0].n).toBe(0);
    expect(modele.evaluate).toHaveLength(0);
    expect(modele.formulate).toHaveLength(0);
    // Réactivation : reprise par la pré-génération (aucune session, aucune visite).
    await sql`UPDATE account_subscriptions SET status = 'active' WHERE account_id = ${c.id}`;
    E.invalidateProcessingEligibility();
    await pregen(c.id);
    expect(await appels(c.id, 't6_evaluate')).toBeGreaterThanOrEqual(1);
    expect((await sql`SELECT 1 FROM user_sessions WHERE user_id = ${c.ownerUserId}`.catch(() => [])).length).toBe(0);
  });

  it('AC13 — Duo : préférences de l’utilisateur appliquées à SON affichage, pré-génération commune sans préférence figée', async () => {
    modele.juger = () => AGIR;
    const c = await compte('premium_duo');
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;
    const id = await echeance(c, 'Ramonage', await plus(15));
    await presentationPregen(c.id);
    await sql`INSERT INTO t6_reminder_preferences (account_id, user_id, subject_key, scope, agenda_item_id, decision, occurrence_date)
              VALUES (${c.id}, ${c.ownerUserId}, ${`agenda:${id}`}, 'OCCURRENCE', ${id}, 'DISMISSED', ${await plus(15)})`;
    const commune = await presentationPregen(c.id);
    expect(sujets(commune).map((x) => x.reminder?.agendaItemId)).toEqual([id]);
    const titulaire = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    const autre = await (await svc()).getMascotPresentation(c.id, 'display', membre.id);
    expect(sujets(titulaire).map((x) => x.reminder?.agendaItemId ?? null)).not.toContain(id);
    expect(sujets(autre).map((x) => x.reminder?.agendaItemId)).toEqual([id]);
    // Le cache T6 ne porte aucune donnée d'utilisateur (clé = sujets et faits du compte).
    const entrees = await sql<{ messages: unknown }[]>`SELECT messages FROM home_mascot_cache WHERE account_id = ${c.id}`;
    expect(JSON.stringify(entrees)).not.toMatch(new RegExp(`"userId"|${membre.email}`));
  });

  // ── C : concurrence entre instances (rechargent les modules : en fin de fichier) ──

  const input = (titre: string) => ({
    schemaVersion: 't6-input-v1' as const, language: 'fr' as const,
    subjects: [{ subjectId: `X:${titre}`, sourceCode: 'DATE-NEXT', intent: 'act' as const, facts: { title: titre }, fallbackText: `${titre} : une démarche est à organiser.`, allowedHighlight: null }],
  });
  /** Instance indépendante (modules et pool PostgreSQL propres), comme un second conteneur. */
  async function instance() {
    vi.resetModules();
    const R = await import('@/services/home/mascot/t6-runner');
    const S = await import('@/services/home/mascot/t6-formulate-reservation');
    return { R, S };
  }
  const compteur = { n: 0, latence: 300, version: 'v-e2e-113ao' };
  const deps = (x: Awaited<ReturnType<typeof instance>>, o: { waitMs?: number } = {}) => ({
    treatmentAvailable: async () => true, promptVersion: async () => compteur.version, previousBubbles: async () => [],
    reservations: x.S.t6ReservationDbStore, reservationWaitMs: o.waitMs ?? 5_000, displayWaitMs: () => 0,
    execute: (async (req: { promptVariables: { INPUT_JSON: string } }) => {
      compteur.n += 1;
      await pause(compteur.latence);
      const e = JSON.parse(req.promptVariables.INPUT_JSON) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return { data: { schemaVersion: 't6-output-v2', messages: e.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText })) }, model: 'simule', usedFallback: false, fromCache: false, costMicros: 0, traceId: `tr-${compteur.n}` };
    }) as never,
  });

  it('AC08 — deux workers à ~50 ms sur la MÊME demande (scénario 15150 / 15151) : 1 seul appel fournisseur, le second sert le résultat', async () => {
    const c = await compte();
    const A = await instance();
    const B = await instance();
    expect(A.R).not.toBe(B.R);
    compteur.n = 0;
    const pa = A.R.formulateWithT6({ accountId: c.id, input: input('Contrôle technique'), contextHash: 'h1', mode: 'pregen' }, deps(A));
    await pause(50);
    const pb = B.R.formulateWithT6({ accountId: c.id, input: input('Contrôle technique'), contextHash: 'h1', mode: 'pregen' }, deps(B));
    const [oa, ob] = await Promise.all([pa, pb]);
    expect(compteur.n).toBe(1);
    expect(oa.status).toBe('generated');
    expect(ob).toMatchObject({ status: 'cache_hit', adjustments: ['reservation_waited'] });
    expect(ob.messages).toEqual(oa.messages);
    const [r] = await sql<{ status: string; contended: number; attempts: number; trace_id: string }[]>`
      SELECT status, contended, attempts, trace_id FROM t6_formulate_reservations WHERE account_id = ${c.id} AND status <> 'DETERMINISTIC'`;
    expect(r).toMatchObject({ status: 'DONE', contended: 1, attempts: 1, trace_id: 'tr-1' });
    // Deux affichages simultanés (deux conteneurs) d'un nouveau contexte : texte déterministe tout de suite, 1 appel en arrière-plan.
    const t0 = Date.now();
    const [da, db] = await Promise.all([
      A.R.formulateWithT6({ accountId: c.id, input: input('Assurance'), contextHash: 'h2', mode: 'display' }, deps(A)),
      B.R.formulateWithT6({ accountId: c.id, input: input('Assurance'), contextHash: 'h2', mode: 'display' }, deps(B)),
    ]);
    expect(Date.now() - t0).toBeLessThan(compteur.latence);
    expect([da.status, db.status]).toEqual(['fallback', 'fallback']);
    await pause(compteur.latence + 400);
    expect(compteur.n).toBe(2);
  });

  it('AC09 — demandes distinctes : aucun écrasement ; bail vivant d’une instance arrêtée : aucun appel ; bail expiré : reprise sûre, 1 appel', async () => {
    const c = await compte();
    const A = await instance();
    const B = await instance();
    compteur.n = 0;
    const [x, y] = await Promise.all([
      A.R.formulateWithT6({ accountId: c.id, input: input('Ramonage'), contextHash: 'a', mode: 'pregen' }, deps(A)),
      B.R.formulateWithT6({ accountId: c.id, input: input('Vidange'), contextHash: 'b', mode: 'pregen' }, deps(B)),
    ]);
    expect(compteur.n).toBe(2);
    expect([x.status, y.status]).toEqual(['generated', 'generated']);
    expect(x.messages?.[0].text).toMatch(/^Ramonage/);
    expect(y.messages?.[0].text).toMatch(/^Vidange/);
    // Instance arrêtée en pleine génération : réservation RUNNING au bail vivant.
    const cle = A.R.t6CacheKey({ accountId: c.id, input: input('Chaudière'), promptVersion: compteur.version, outputSchema: 't6-output-v2' });
    await sql`INSERT INTO t6_formulate_reservations (account_id, cache_key, status, owner_id, lease_until, attempts)
              VALUES (${c.id}, ${cle}, 'RUNNING', gen_random_uuid(), now() + interval '1 minute', 1)`;
    const vivant = await B.R.formulateWithT6({ accountId: c.id, input: input('Chaudière'), contextHash: 'c', mode: 'pregen' }, deps(B, { waitMs: 400 }));
    expect(vivant).toMatchObject({ status: 'fallback', messages: null });
    expect(compteur.n).toBe(2);
    // Bail expiré (arrêt brutal) : reprise par la demande suivante, compteur de reprises.
    await sql`UPDATE t6_formulate_reservations SET lease_until = now() - interval '1 second' WHERE account_id = ${c.id} AND cache_key = ${cle}`;
    const repris = await A.R.formulateWithT6({ accountId: c.id, input: input('Chaudière'), contextHash: 'c', mode: 'pregen' }, deps(A));
    expect(repris.status).toBe('generated');
    expect(compteur.n).toBe(3);
    expect((await sql`SELECT attempts, status FROM t6_formulate_reservations WHERE account_id = ${c.id} AND cache_key = ${cle}`)[0]).toEqual({ attempts: 2, status: 'DONE' });
  });

  it('AC14 — aucun appel supplémentaire au réaffichage ; affichage jamais retardé ; changement de prompt : nouvelle clé, un appel', async () => {
    const c = await compte();
    const A = await instance();
    compteur.n = 0;
    await A.R.formulateWithT6({ accountId: c.id, input: input('Entretien'), contextHash: 'e', mode: 'pregen' }, deps(A));
    expect(compteur.n).toBe(1);
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const o = await A.R.formulateWithT6({ accountId: c.id, input: input('Entretien'), contextHash: 'e', mode: 'display' }, deps(A));
      expect(o.status).toBe('cache_hit');
      expect(Date.now() - t0).toBeLessThan(compteur.latence);
    }
    expect(compteur.n).toBe(1);
    compteur.version = 'v-e2e-113ao-2';
    await A.R.formulateWithT6({ accountId: c.id, input: input('Entretien'), contextHash: 'e', mode: 'pregen' }, deps(A));
    expect(compteur.n).toBe(2);
    compteur.version = 'v-e2e-113ao';
    // Mesure (BO) : formulations évitées, doublons refusés, rattachement — des nombres seulement.
    const { t6EfficiencyReport } = await import('@/services/home/mascot/t6-efficiency-report');
    const q = async (t: string, p?: unknown[]) => (await sql.unsafe(t, (p ?? []) as never[])) as unknown as Array<Record<string, unknown>>;
    const rep = await t6EfficiencyReport(q, { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000) });
    expect(rep.missing).toEqual([]);
    expect(rep.avoided.deterministicContexts).toBeGreaterThanOrEqual(1);
    expect(rep.duplicates.reservationRefusals).toBeGreaterThanOrEqual(1);
    expect(rep.formulate.calls).toBeGreaterThanOrEqual(1);
    expect(rep.attribution.find((x) => x.operation === 't6_formulate' && x.execution === 'T6F')?.calls).toBeGreaterThanOrEqual(1);
  });
});
