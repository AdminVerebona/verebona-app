/**
 * Lot 72A — ticket « [P1] T6 — Corriger les écarts résiduels du contrat
 * EVALUATE et fiabiliser la bulle d'accueil » — de bout en bout sur
 * PostgreSQL 16 réel : vrai collecteur, vraie décision, vraie passerelle IA,
 * vraie persistance, vrais rapports. Modèle SIMULÉ (aucun réseau).
 *
 *  AC01  description / pièce justificative modifiée : nouvelle évaluation ;
 *        relecture sans changement : aucun appel IA
 *  AC02  version BO du prompt dont la branche EVALUATE change : décisions
 *        invalidées (signature 0510), réévaluées ; FORMULATE seule : aucune
 *  AC05  écriture refusée par la base : rien d'enregistré, statut FAILED,
 *        accueil « indisponible » (jamais « rien à signaler ») ; transaction
 *        réelle : une ligne fautive annule le lot
 *  AC06  question contradictoire (échéance écartée) jamais proposée ;
 *        contexte transmis sans l'échéance écartée, avec références
 *  AC07  propriété inconnue dans la sortie EVALUATE : rejet explicite, rien
 *        d'enregistré
 *  AC08  rapport EVALUATE (statut, persistées, mode) et mode d'appel tracé
 *        (`ai_usage_event.metadata.callerMode`) : affichage / pré-génération
 *
 * Lot 87C (questions fondées, version du prompt porteuse du contrat SIMULÉE) :
 *  AC06  revu — une question « préparer » sur une échéance signalée dont la
 *        démarche n'est étayée par aucune preuve concrète n'est plus publiée
 *  L87C-E2E-AC13  contrôle de cohérence COH-T6-SUGGESTIONS : fait modifié ou
 *        échéance refusée après la génération → constat (à blanc), puis
 *        retrait et invalidation (correctif) tracés sur la génération ;
 *        aucune donnée métier modifiée, aucun appel IA
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { activerContratQuestions, fondee } from '../t6-suggestions-v3';

interface Candidat { subjectId: string; title: string; description: string | null; documents: string[]; evidence: Array<{ ref: string; kind: string }> }

const modele = vi.hoisted(() => ({
  /** Décision rendue pour un candidat (null : SUPPRESS). */
  juger: (_c: Candidat): Record<string, unknown> | null => null,
  /** Propriété en trop ajoutée à chaque décision (AC07). */
  enTrop: null as Record<string, unknown> | null,
  /** Questions rendues par FORMULATE (AC06) — lot 87C : liste, ou fonction du contexte transmis. */
  questions: [] as unknown[] | ((ctx: Record<string, unknown>) => unknown[]),
  candidats: [] as Candidat[][],
  contextesQuestions: [] as unknown[],
}));

function provider() {
  return {
    name: 'simule-l72a',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        modele.candidats.push(ctx.candidates);
        const decisions = ctx.candidates.map((c) => ({
          subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, uncertainties: [],
          evidenceRefs: [c.evidence.find((x) => x.kind === 'DUE_DATE')?.ref ?? c.evidence[0].ref],
          ...(modele.juger(c) ?? AUCUNE), ...(modele.enTrop ?? {}),
        }));
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      const q = /Contexte des questions suggérées : (.*)\n/.exec(input.prompt)?.[1];
      if (q && q !== 'null') modele.contextesQuestions.push(JSON.parse(q));
      return {
        rawText: JSON.stringify({
          schemaVersion: 't6-output-v2', messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
          suggestions: typeof modele.questions === 'function' ? (q && q !== 'null' ? modele.questions(JSON.parse(q)) : []) : modele.questions,
        }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', priorityHint: 'LOW' };
const AGIR = { decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.', expectedAction: 'Prendre rendez-vous avec le prestataire', priorityHint: 'MEDIUM' };

scenario('L72A-T6', 'Lot 72A — écarts résiduels du contrat EVALUATE et bulle d’accueil', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.juger = () => AGIR; modele.enTrop = null; modele.questions = [];
    modele.candidats.length = 0; modele.contextesQuestions.length = 0;
    (await import('@/services/home/mascot/t6-runner')).resetT6Breaker();
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    await sql`DELETE FROM home_mascot_pregen_requests`;
    (await import('@/services/home/mascot/t6-runner')).resetT6SuggestionReportProbe();
  });
  afterEach(async () => {
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');
  const passer = async (accountId: number, userId: number | null = null) => (await svc()).getMascotPresentation(accountId, 'pregen', userId);
  const echeancesAffichees = (p: import('@/services/home/mascot/types').MascotPresentation) =>
    p.paragraphs.filter((x) => x.reminder != null).map((x) => x.reminder!.agendaItemId);
  const evalues = () => modele.candidats.flat();

  async function compte() {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    return { ...a, maison: maison.id };
  }
  async function echeance(c: { id: number; ownerUserId: number; maison: number }, titre: string, date: string, description: string | null = null) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action', description = ${description} WHERE id = ${e.id}`;
    return e.id;
  }
  async function document(c: { id: number; ownerUserId: number; maison: number }, agendaItemId: number, titre: string) {
    const f = await make.assetFile(c as never, { assetId: c.maison });
    await sql`UPDATE asset_files SET retained_title = ${titre}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${agendaItemId}, ${f.id})`;
    return f.id;
  }
  const evaluation = async (accountId: number, agendaItemId: number) => (await sql<Array<{ decision: string; evaluation_signature: string | null; prompt_version: string | null; context_fingerprint: string }>>`
    SELECT decision, evaluation_signature, prompt_version, context_fingerprint FROM t6_interpellation_assessments WHERE account_id = ${accountId} AND agenda_item_id = ${agendaItemId}`)[0] ?? null;
  const rapportsEvaluate = async (accountId: number) => sql<Array<{ status: string; trigger_code: string; counters: Record<string, number>; sources: Record<string, unknown>; steps: Array<Record<string, unknown>> }>>`
    SELECT status, trigger_code, counters, sources, steps FROM ai_execution_reports WHERE account_id = ${accountId} AND treatment = 'T6' AND trigger_code LIKE 'evaluate:%' ORDER BY id`;
  const master = async () => (await import('@/services/ai/governance/master-corpus/cases')).readMasterFileFromRepo('t6_master_v1');
  const activerPrompt = async (texte: string, id: number) =>
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests([{ id, treatment: 'T6' as never, versionNumber: id, content: texte }]);

  it('AC01 — description et pièce justificative : nouvelle évaluation ; relecture sans changement : aucun appel IA', async () => {
    const c = await compte();
    const id = await echeance(c, 'Entretien chaudière', await plus(20), 'Entretien annuel.');
    await passer(c.id);
    expect(evalues()).toHaveLength(1);
    const fp0 = (await evaluation(c.id, id))!.context_fingerprint;
    // Relecture sans modification : aucune nouvelle évaluation.
    await passer(c.id);
    expect(evalues()).toHaveLength(1);
    // Description modifiée : réévaluée (contexte transmis à jour).
    await sql`UPDATE agenda_items SET description = 'Entretien annuel ; contrat d’entretien résilié par le prestataire.' WHERE id = ${id}`;
    await passer(c.id);
    expect(evalues()).toHaveLength(2);
    expect(evalues()[1].description).toContain('résilié');
    // Pièce ajoutée puis supprimée : réévaluée à chaque fois.
    const f = await document(c, id, 'Contrat d’entretien');
    await passer(c.id);
    expect(evalues()).toHaveLength(3);
    expect(evalues()[2].documents).toEqual(['Contrat d’entretien']);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f}`;
    await passer(c.id);
    expect(evalues()).toHaveLength(4);
    expect((await evaluation(c.id, id))!.context_fingerprint).not.toBe(fp0);
  });

  it('AC02 — activation BO : branche EVALUATE changée → décisions invalidées puis réévaluées ; FORMULATE seule → aucune réévaluation', async () => {
    const c = await compte();
    const id = await echeance(c, 'Révision chaudière', await plus(15));
    const p0 = await passer(c.id);
    expect(echeancesAffichees(p0)).toEqual([id]);
    const e0 = (await evaluation(c.id, id))!;
    // Lot 76A : signature complète (replis, raisonnement, limite de sortie).
    expect(e0.evaluation_signature).toMatch(/^e2:/);
    // Nouvelle version BO : seule la branche FORMULATE change.
    const texte = await master();
    await activerPrompt(texte.replace('R12 — Questions suggérées.', 'R12 — Questions suggérées (révision PO).'), 9101);
    await passer(c.id);
    expect(evalues()).toHaveLength(1);
    // Nouvelle version BO : la branche EVALUATE change → décision INVALIDÉE (jamais réutilisée).
    await activerPrompt(texte.replace('E5 —', 'E5 (révision PO) —'), 9102);
    const S = await import('@/services/home/mascot/t6-interpellation.service');
    const R = await import('@/services/home/mascot/t6-runner');
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const prep = await S.prepareT6Interpellation({ accountId: c.id, userId: c.ownerUserId, raw: await collectMascotData(c.id) }, {
      aiCapable: R.t6InterpellationAvailable, thresholdDays: S.t6ThresholdDays, evaluationConfig: R.t6EvaluationConfig,
    });
    expect(prep.decisions.find((d) => d.agendaItemId === id)).toMatchObject({ code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONFIG_CHANGED' });
    expect(prep.shown).toEqual([]);
    // Pré-génération : réévaluée, nouvelle signature conservée.
    const p2 = await passer(c.id);
    expect(evalues()).toHaveLength(2);
    expect(echeancesAffichees(p2)).toEqual([id]);
    const e2 = (await evaluation(c.id, id))!;
    expect(e2.evaluation_signature).not.toBe(e0.evaluation_signature);
    expect(e2.prompt_version).toMatch(/@pv9102:/);
    // Contexte et configuration inchangés : aucun appel de plus.
    await passer(c.id);
    expect(evalues()).toHaveLength(2);
  });

  it('AC05 / AC08 — écriture refusée par la base : rien d’enregistré, rapport FAILED, accueil « indisponible » ; puis reprise réussie et mode tracé', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle installation gaz', await plus(10));
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l72a_refus() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.account_id = ${Number(c.id)} THEN RAISE EXCEPTION 'écriture refusée (e2e l72a)'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER l72a_refus BEFORE INSERT ON t6_interpellation_assessments FOR EACH ROW EXECUTE FUNCTION l72a_refus()`);
    try {
      const p = await passer(c.id);
      expect(evalues()).toHaveLength(1);
      expect(await evaluation(c.id, id)).toBeNull();
      expect(echeancesAffichees(p)).toEqual([]);
      expect(p.state).toMatchObject({ evaluation: 'UNAVAILABLE' });
      const B = await import('@/services/home/mascot/bubble');
      expect(B.composeSpeech({ presentation: p, empty: false }).text).not.toBe(B.NOTHING_TO_REPORT_SPEECH);
      const [r] = await rapportsEvaluate(c.id);
      expect(r).toMatchObject({ status: 'FAILED', trigger_code: 'evaluate:pregen', counters: { accepted: 1, persisted: 0, notPersisted: 1 } });
      // Lot 78C : + clôture durable de l'exécution (état réel : nouvel essai planifié).
      expect(r.steps.map((s) => [s.step, s.status])).toEqual([['evaluate', 'OK'], ['persist', 'FAILED'], ['run_state', 'OK']]);
      expect(r.sources).toMatchObject({ callerMode: 'pregeneration', executionMode: 'PREGENERATION' });
      const [ligne] = await sql<Array<{ write_result: string; record_status: string }>>`
        SELECT e.write_result, e.record_status FROM ai_execution_report_entries e JOIN ai_execution_reports r ON r.id = e.report_id
         WHERE r.account_id = ${c.id} AND r.trigger_code = 'evaluate:pregen' AND e.section = 'EVALUATE'`;
      expect(ligne).toMatchObject({ write_result: 'NOT_PERSISTED', record_status: 'NOT_PERSISTED' });
      // Reprise bornée : pas de nouvel appel immédiat sur la même entrée.
      await passer(c.id);
      expect(evalues()).toHaveLength(1);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS l72a_refus ON t6_interpellation_assessments`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS l72a_refus()`);
    }
    // Base rétablie (délai de reprise écoulé) : décision enregistrée, rapport SUCCESS.
    // Lot 78C : le délai avant le nouvel essai est porté par la base (t6_evaluation_runs).
    await sql`UPDATE t6_evaluation_runs SET next_attempt_at = now() - interval '1 second' WHERE account_id = ${c.id}`;
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    const p2 = await passer(c.id);
    expect(echeancesAffichees(p2)).toEqual([id]);
    expect((await rapportsEvaluate(c.id)).at(-1)).toMatchObject({ status: 'SUCCESS', counters: { persisted: 1, notPersisted: 0 } });
    // Mode d'appel tracé par la passerelle, pour EVALUATE comme pour FORMULATE.
    const traces = await sql<Array<{ operation_type: string; caller_mode: string | null }>>`
      SELECT operation_type, metadata->>'callerMode' AS caller_mode FROM ai_usage_event WHERE account_id = ${c.id} AND operation_type = 't6_evaluate'`;
    expect(traces.length).toBeGreaterThan(0);
    expect(new Set(traces.map((t) => t.caller_mode))).toEqual(new Set(['pregeneration']));
    // À l'affichage : évaluation déclenchée en arrière-plan, tracée « displayed ».
    await sql`UPDATE agenda_items SET description = 'Contrôle obligatoire, rendez-vous à prendre.' WHERE id = ${id}`;
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    for (let i = 0; i < 50 && evalues().length < 3; i += 1) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    const modes = await sql<Array<{ m: string }>>`SELECT metadata->>'callerMode' AS m FROM ai_usage_event WHERE account_id = ${c.id} AND operation_type = 't6_evaluate' ORDER BY id`;
    expect(modes.at(-1)!.m).toBe('displayed');
    // Le rapport est écrit en arrière-plan : attente bornée de son écriture (machine chargée).
    for (let i = 0; i < 100 && (await rapportsEvaluate(c.id)).at(-1)?.trigger_code !== 'evaluate:display'; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect((await rapportsEvaluate(c.id)).at(-1)).toMatchObject({ trigger_code: 'evaluate:display', sources: { callerMode: 'displayed', executionMode: 'DISPLAY' } });
  });

  it('AC05 — transaction réelle : une ligne fautive annule tout le lot accepté', async () => {
    const c = await compte();
    const a = await echeance(c, 'Échéance A', await plus(10));
    const b = await echeance(c, 'Échéance B', await plus(11));
    const S = await import('@/services/home/mascot/t6-interpellation.service');
    const refs = new Map([
      ['C1', { subjectKey: `agenda:${a}`, agendaItemId: a, fingerprint: 'v2:a', daysUntilDue: 10 }],
      ['C2', { subjectKey: `agenda:${b}`, agendaItemId: b, fingerprint: 'v2:b', daysUntilDue: 11 }],
    ]);
    const d = (subjectId: string, priorityHint: string) => ({
      subjectId, decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire.',
      expectedAction: 'Prendre rendez-vous', actionDeadline: null, suggestedReviewAt: null, priorityHint, evidenceRefs: [`${subjectId}.dueDate`], uncertainties: [],
    }) as never;
    await expect(S.persistT6AssessmentsDetailed(c.id, await jour(), refs, [d('C1', 'HIGH'), d('C2', 'URGENTISSIME')], { promptVersion: 'v', traceId: null })).rejects.toThrow();
    expect(await evaluation(c.id, a)).toBeNull();
    expect(await evaluation(c.id, b)).toBeNull();
    const ok = await S.persistT6AssessmentsDetailed(c.id, await jour(), refs, [d('C1', 'HIGH'), d('C2', 'LOW')], { promptVersion: 'v', traceId: null, evaluationSignature: 'e1:test' });
    expect(ok).toEqual({ persisted: 2, persistedSubjectIds: ['C1', 'C2'] });
    expect((await evaluation(c.id, b))!.evaluation_signature).toBe('e1:test');
  });

  it('AC06 — question contradictoire sur une échéance écartée : jamais proposée ; contexte sans elle, avec références', async () => {
    const c = await compte();
    const ct = await echeance(c, 'Contrôle technique', await plus(12));
    await echeance(c, 'Assurance habitation', await plus(14));
    modele.juger = (x) => (x.title === 'Contrôle technique' ? AGIR : AUCUNE);
    await activerContratQuestions(true);
    modele.questions = (ctx) => [
      fondee(ctx, 'Comment préparer le renouvellement de l’assurance habitation ?', ['ACC.DEADLINES']),
      fondee(ctx, 'Que dois-je préparer pour le contrôle technique ?', ['D1', 'D1.ACTION'], { purpose: 'PREPARE' }),
      fondee(ctx, 'Quelles sont mes prochaines échéances ?', ['ACC.DEADLINES']),
    ];
    await passer(c.id);
    const p = await passer(c.id);
    expect(echeancesAffichees(p)).toEqual([ct]);
    const questions = p.secondaries.filter((s) => s.action.target.kind === 'ask').map((s) => s.action.label);
    // Lot 87C : la démarche du contrôle technique (décision fondée sur la seule date) n'est pas ÉTABLIE —
    // « préparer » n'est plus publiée sur le seul signalement ; la consultation reste.
    expect(questions).toEqual(['Quelles sont mes prochaines échéances ?']);
    const ctx = modele.contextesQuestions.at(-1) as { schemaVersion: string; nextDeadlines: Array<{ ref: string; label: string; signaled: boolean; identifiedAction: { basis: string } | null }> };
    expect(ctx.schemaVersion).toBe('t6-suggestions-v3');
    expect(JSON.stringify(ctx)).not.toMatch(/Assurance/i);
    expect(ctx.nextDeadlines[0]).toMatchObject({ ref: 'D1', signaled: true, identifiedAction: { basis: 'NOT_ESTABLISHED' } });
  });

  // ══ Lot 87C — contrôle de cohérence des questions (AC13, AC08) ═══════════

  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const today = await jour();
    const now = new Date();
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e-l87c', mode, scopeAccountIds: scope, now });
    for (let i = 0; i < 60; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today, now });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const preuveT6 = async (accountId: number) => (await sql<Array<{ last_result: string; finding: Record<string, unknown> | null }>>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = 'COH-T6-SUGGESTIONS' AND object_id = ${accountId}`)[0];
  const cacheAvecQuestions = async (accountId: number) => (await sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM home_mascot_cache WHERE account_id = ${accountId} AND jsonb_typeof(suggestions) = 'array' AND jsonb_array_length(suggestions) > 0`)[0].n;

  it('L87C-E2E-AC13 — fondement modifié puis échéance refusée : constat à blanc, retrait et invalidation en correctif, trace sur la génération, données métier intactes', async () => {
    const c = await compte();
    const ct = await echeance(c, 'Contrôle technique', await plus(12));
    const ramonage = await echeance(c, 'Ramonage', await plus(15));
    const fichier = await document(c, ct, 'Procès-verbal de contrôle');
    const [x] = await sql<[{ id: number }]>`INSERT INTO document_extractions (account_id, file_id, title) VALUES (${c.id}, ${fichier}, 'PV') RETURNING id`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt)
              VALUES (${c.id}, ${fichier}, ${x.id}, 'next_inspection', 'Prochain contrôle', 'contre-visite sous deux mois', 'contre-visite sous deux mois', 'certain', 'Contre-visite à prévoir.')`;
    // Contrôle technique : démarche établie par le fait extrait ; ramonage : rappel informatif signalé (aucune démarche).
    modele.juger = (cand) => (cand.title === 'Contrôle technique'
      ? { ...AGIR, evidenceRefs: [cand.evidence.find((e) => e.kind === 'DOCUMENT_FACT')?.ref ?? cand.evidence[0].ref] }
      : { decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER', reason: 'Rappel utile : le ramonage approche.', expectedAction: null, priorityHint: 'LOW' });
    await activerContratQuestions(true);
    modele.questions = (ctx) => {
      const d = (ctx.nextDeadlines as Array<{ ref: string; label: string; facts: Array<{ ref: string }>; identifiedAction: { ref: string } | null }>);
      const ctRef = d.find((y) => y.label === 'Contrôle technique');
      const ram = d.find((y) => y.label === 'Ramonage');
      return [
        ...(ctRef ? [fondee(ctx, 'Que dois-je préparer pour le contrôle technique ?', [ctRef.ref, ...(ctRef.identifiedAction ? [ctRef.identifiedAction.ref] : []), ...ctRef.facts.map((f) => f.ref)], { purpose: 'PREPARE' })] : []),
        ...(ram ? [fondee(ctx, 'Quand est prévu le ramonage ?', [ram.ref])] : []),
      ];
    };
    await passer(c.id);
    const p = await passer(c.id);
    expect(p.secondaries.filter((s) => s.action.target.kind === 'ask').map((s) => s.action.label))
      .toEqual(['Que dois-je préparer pour le contrôle technique ?', 'Quand est prévu le ramonage ?']);
    expect(await cacheAvecQuestions(c.id)).toBeGreaterThan(0);
    // Cohérent tant que les fondements sont actuels.
    await campagne([c.id], 'CORRECTIVE');
    expect((await preuveT6(c.id)).last_result).toBe('CONSISTENT');

    // Le fait justificatif change (mêmes compteurs), sans nouvel affichage.
    const metier = async () => sql`SELECT (SELECT jsonb_agg(to_jsonb(i) - 'updated_at' ORDER BY id) FROM agenda_items i WHERE account_id = ${c.id}) AS a,
      (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM document_facts f WHERE account_id = ${c.id}) AS f,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM t6_interpellation_assessments t WHERE account_id = ${c.id}) AS t`;
    await sql`UPDATE document_facts SET value_text = 'contre-visite sous un mois', normalized_value = 'contre-visite sous un mois' WHERE account_id = ${c.id}`;
    const avant = await metier();
    const appels = modele.contextesQuestions.length;
    // À blanc : constat, rien de retiré.
    await campagne([c.id], 'DRY_RUN');
    expect(await preuveT6(c.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'T6_SUGGESTION_GROUND_INVALID' }) });
    expect(await cacheAvecQuestions(c.id)).toBeGreaterThan(0);
    // Correctif : retrait + invalidation tracée sur la génération d'origine.
    await campagne([c.id], 'CORRECTIVE');
    expect((await preuveT6(c.id)).last_result).toBe('REPAIRED');
    expect(await cacheAvecQuestions(c.id)).toBe(0);
    const [rep] = await sql<Array<{ service: string; ai_calls: number; result: Record<string, number> }>>`
      SELECT service, ai_calls, result FROM coherence_repairs WHERE account_id = ${c.id} AND check_id = 'COH-T6-SUGGESTIONS' ORDER BY id DESC LIMIT 1`;
    expect(rep).toMatchObject({ service: 'invalidateT6SuggestionCache', ai_calls: 0 });
    const [g] = await sql<Array<{ r: { invalidations: Array<{ source: string; reasons: Record<string, number>; removed: number }> } }>>`
      SELECT suggestion_report AS r FROM home_mascot_generations WHERE account_id = ${c.id} AND suggestion_report ? 'invalidations' ORDER BY id DESC LIMIT 1`;
    // Fait modifié : la décision T6 qui s'appuyait dessus devient elle-même caduque (démarche indisponible)
    // ou le fait a changé — un seul motif par question, la question « préparer » seule est retirée.
    expect(g.r.invalidations.at(-1)).toMatchObject({ source: 'COHERENCE', removed: 1 });
    expect(Object.keys(g.r.invalidations.at(-1)!.reasons)).toEqual([expect.stringMatching(/^ground_(changed|unavailable)$/)]);
    // Aucune donnée métier modifiée, aucun appel IA déclenché par la cohérence.
    expect(await metier()).toEqual(avant);
    expect(modele.contextesQuestions.length).toBe(appels);

    // Nouvelle génération sur le contexte courant au passage suivant ; puis le ramonage est REFUSÉ par l'utilisateur.
    await passer(c.id);
    await passer(c.id);
    expect(await cacheAvecQuestions(c.id)).toBeGreaterThan(0);
    await sql`INSERT INTO t6_reminder_preferences (account_id, user_id, subject_key, scope, agenda_item_id, decision)
              VALUES (${c.id}, ${c.ownerUserId}, ${`agenda:${ramonage}`}, 'OCCURRENCE', ${ramonage}, 'DISMISSED')`;
    await campagne([c.id], 'CORRECTIVE');
    expect((await preuveT6(c.id)).last_result).toBe('REPAIRED');
    const [g2] = await sql<Array<{ r: { invalidations: Array<{ reasons: Record<string, number> }> } }>>`
      SELECT suggestion_report AS r FROM home_mascot_generations WHERE account_id = ${c.id} AND suggestion_report ? 'invalidations' ORDER BY id DESC LIMIT 1`;
    expect(g2.r.invalidations.at(-1)!.reasons).toMatchObject({ ground_unavailable: 1 });
    // AC08 : l'échéance refusée n'est plus jamais proposée en question (affichage de cet utilisateur).
    const vue = await passer(c.id, c.ownerUserId);
    expect(vue.secondaries.filter((s) => s.action.target.kind === 'ask').map((s) => s.action.label).join(' ')).not.toMatch(/ramonage/i);
  });

  it('AC07 — propriété inconnue dans la sortie EVALUATE : rejet explicite, rien d’enregistré, jamais affiché', async () => {
    const c = await compte();
    const id = await echeance(c, 'Ramonage', await plus(9));
    modele.enTrop = { urgency: 'HIGH' };
    const p = await passer(c.id);
    expect(evalues().length).toBeGreaterThanOrEqual(1);
    expect(await evaluation(c.id, id)).toBeNull();
    expect(echeancesAffichees(p)).toEqual([]);
    const [r] = await rapportsEvaluate(c.id);
    expect(r.status).toBe('FAILED');
    expect(r.counters).toMatchObject({ accepted: 0, persisted: 0 });
  });
});
