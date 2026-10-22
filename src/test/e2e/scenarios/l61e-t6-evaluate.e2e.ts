/**
 * Lot 61 — ticket « [P2] T6 — Implémenter le nouveau contrat de décision IA
 * et fiabiliser la composition de la bulle d'accueil » — de bout en bout sur
 * PostgreSQL 16 réel : vrai collecteur, vraie décision, vraie passerelle IA,
 * vraie mascotte (`getMascotPresentation`), vrai reporting. Modèle SIMULÉ
 * (aucun réseau) : en MODE=EVALUATE il rend les décisions que le scénario lui
 * confie (contrat `t6-evaluation-v1`) ; en MODE=FORMULATE il recopie les
 * textes de secours (contrat `t6-output-v2`).
 *
 *  T6-EV-06 / 12 / 16  deux assurances à 78 jours sans action : rien dit ni montré ; cache des
 *                      décisions réutilisé ; questions sans l'échéance écartée ; deux contrats distincts
 *  T6-EV-07 / 13 / 15  démarche établie au-delà du seuil + vérification justifiée : deux cartes,
 *                      actions distinctes, résumé et pose cohérents
 *  T6-EV-04 / 11 / 19  sortie invalide ou panne : rien d'accepté en silence (rapport motivé),
 *                      aucune échéance artificielle, état dégradé explicite
 *  T6-EV-20            affichage jamais bloqué par EVALUATE ; décision servie à l'affichage suivant
 *  T6-EV-09 / 10       « À traiter » prioritaire et document en analyse correctement présentés
 *  T6-EV-18            préférences de rappel respectées ; isolation intercomptes des évaluations
 *  T6-EV-21            migration 0447 rejouable ; contraintes du contrat
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

interface Candidat { subjectId: string; title: string; description: string | null; evidence: Array<{ ref: string }> }
type Jugement = Record<string, unknown> | null;

/** IA simulée : le scénario dit ce qu'elle décide, candidat par candidat. */
const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Record<string, unknown> | null => null,
  /** Sortie EVALUATE brute imposée (sortie invalide), ou null. */
  brute: null as unknown,
  panne: false,
  latenceEvaluateMs: 0,
  evaluate: [] as string[],
  formulate: [] as string[],
}));

function provider() {
  return {
    name: 'simule-l61e',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        modele.evaluate.push(input.prompt);
        if (modele.latenceEvaluateMs) await new Promise((r) => setTimeout(r, modele.latenceEvaluateMs));
        if (modele.panne) throw new Error('fournisseur indisponible (simulation)');
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        const decisions = ctx.candidates.map((c) => {
          const e = modele.juger(c) ?? AUCUNE;
          const { preuve, ...reste } = e as { preuve?: string };
          const refs = c.evidence.map((x) => x.ref);
          return {
            subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, priorityHint: null, uncertainties: [],
            evidenceRefs: [refs.find((r) => r.endsWith(`.${preuve ?? 'dueDate'}`)) ?? refs[0]], ...reste,
          };
        });
        return { rawText: JSON.stringify(modele.brute ?? { schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      modele.formulate.push(input.prompt);
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return {
        rawText: JSON.stringify({
          schemaVersion: 't6-output-v2',
          messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
          suggestions: [{ question: 'Quels documents ai-je pour ma maison ?', assetRef: null }],
        }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

const AUCUNE: Jugement = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', preuve: 'title' };
const AGIR = (o: Record<string, unknown> = {}): Jugement => ({
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.',
  expectedAction: 'Prendre rendez-vous', priorityHint: 'MEDIUM', ...o,
});
const INTERDITS = /Tout est à jour|Aucune échéance dépassée|aucun document en attente|échéances dépassées sont à vérifier/i;

scenario('L61E-T6EV', 'Lot 61 — contrat de décision T6 (EVALUATE) et composition de la bulle d’accueil', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    Object.assign(modele, { juger: () => null, brute: null, panne: false, latenceEvaluateMs: 0 });
    modele.evaluate.length = 0;
    modele.formulate.length = 0;
    const r = await import('@/services/home/mascot/t6-runner');
    r.resetT6Breaker();
    r.resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
  });
  afterEach(async () => { (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations(); });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');
  const B = () => import('@/services/home/mascot/bubble');

  async function compte() {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    const f = await make.assetFile(a, { assetId: maison.id });
    await sql`UPDATE asset_files SET retained_title = 'Contrat habitation', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return { ...a, maison: maison.id };
  }
  async function echeance(c: { id: number; maison: number }, titre: string, date: string, o: { description?: string } = {}) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action', description = ${o.description ?? null} WHERE id = ${e.id}`;
    return e.id;
  }
  const pregen = async (accountId: number, userId: number | null = null) => (await svc()).getMascotPresentation(accountId, 'pregen', userId);
  const sujets = (p: import('@/services/home/mascot/types').MascotPresentation) => p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR');
  const ids = (p: import('@/services/home/mascot/types').MascotPresentation) => sujets(p).map((x) => x.reminder?.agendaItemId ?? null);
  const parler = async (p: import('@/services/home/mascot/types').MascotPresentation) => (await B()).composeSpeech({ presentation: p, empty: false }).text;

  it('T6-EV-06 / T6-EV-12 / T6-EV-16 — deux assurances à 78 jours sans action : aucune interpellation, décisions réutilisées, questions cohérentes, deux contrats distincts', async () => {
    const c = await compte();
    const a1 = await echeance(c, 'Échéance assurance habitation', await plus(78));
    const a2 = await echeance(c, 'Échéance assurance auto', await plus(78));
    modele.juger = () => AUCUNE;
    const p = await pregen(c.id);
    expect(modele.evaluate).toHaveLength(1);
    // EVALUATE reçoit les candidats (et rien d'autre) ; FORMULATE n'en reçoit jamais.
    expect(modele.evaluate[0]).toMatch(/Entrée structurée : null\n/);
    expect(JSON.parse(/Candidats à évaluer : (.*)\n/.exec(modele.evaluate[0])![1])).toMatchObject({ schemaVersion: 't6-evaluation-input-v1', thresholdDays: 60 });
    for (const f of modele.formulate) expect(f).toMatch(/Candidats à évaluer : null\n/);
    const evals = await sql<Array<{ agenda_item_id: number; decision: string; reason_code: string; contract_version: string }>>`
      SELECT agenda_item_id, decision, reason_code, contract_version FROM t6_interpellation_assessments WHERE account_id = ${c.id} ORDER BY agenda_item_id`;
    expect(evals.map((e) => [e.agenda_item_id, e.decision, e.reason_code, e.contract_version])).toEqual([
      [a1, 'SUPPRESS', 'NO_ACTION_REQUIRED', 't6-evaluation-v1'], [a2, 'SUPPRESS', 'NO_ACTION_REQUIRED', 't6-evaluation-v1']]);
    expect(sujets(p)).toEqual([]);
    expect(p.state).toMatchObject({ kind: 'NOTHING_TO_REPORT', evaluation: 'OK' });
    expect(await parler(p)).toBe('Rien de particulier à vous signaler pour le moment.');
    expect((await B()).homeItems(p, false)).toEqual([]);
    expect((await B()).homePose(p, false)).toBe('success-check');
    // Affichage suivant : décisions valides RÉUTILISÉES (aucune nouvelle évaluation), toujours rien.
    const d = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(modele.evaluate).toHaveLength(1);
    expect(sujets(d)).toEqual([]);
    expect(await parler(d)).not.toMatch(/assurance|janvier|mérite|1er/i);
    // Questions : l'échéance écartée n'est pas transmise au contexte des questions.
    for (const f of modele.formulate) {
      const ctx = JSON.parse(/Contexte des questions suggérées : (.*)\n/.exec(f)![1]) as { nextDeadlines: Array<{ label: string }>; bubble: { speech: string } } | null;
      if (!ctx) continue;
      expect(ctx.nextDeadlines).toEqual([]);
      expect(ctx.bubble.speech).toBe('Rien de particulier à vous signaler pour le moment.');
    }
    // Modification significative de l'échéance : la décision obsolète n'est plus servie (réévaluation).
    modele.juger = () => AGIR();
    await sql`UPDATE agenda_items SET start_date = ${await plus(20)} WHERE id = ${a1}`;
    const apres = await pregen(c.id);
    expect(modele.evaluate).toHaveLength(2);
    expect(ids(apres)).toEqual([a1]);
  });

  it('T6-EV-07 / T6-EV-13 / T6-EV-15 — démarche établie au-delà du seuil et vérification justifiée : deux cartes distinctes, résumé et pose cohérents', async () => {
    const c = await compte();
    const gaz = await echeance(c, 'Fin du contrat de gaz', await plus(90), { description: 'Résiliation possible avec un préavis de deux mois avant la fin du contrat.' });
    const ramonage = await echeance(c, 'Ramonage cheminée', await plus(-4));
    const assurance = await echeance(c, 'Échéance assurance habitation', await plus(78));
    const actionDeadline = await plus(25);
    modele.juger = (x) => (x.title === 'Fin du contrat de gaz'
      ? AGIR({ reasonCode: 'NOTICE_PERIOD_RUNNING', expectedAction: 'Envoyer la demande de résiliation', actionDeadline, priorityHint: 'HIGH', preuve: 'description', reason: 'La description indique un préavis de deux mois.' })
      : x.title === 'Ramonage cheminée'
        ? AGIR({ reasonCode: 'VERIFICATION_REQUIRED', expectedAction: 'Vérifier si le ramonage a été réalisé', reason: 'La date est passée et la description ne permet pas de savoir si le passage a eu lieu.' })
        // Même SHOW_NOW sans preuve concrète au-delà du seuil : écarté par le serveur.
        : AGIR({ priorityHint: 'HIGH' }));
    const p = await pregen(c.id);
    expect(ids(p)).toEqual([gaz, ramonage]);
    expect(ids(p)).not.toContain(assurance);
    expect(p.state).toMatchObject({ kind: 'ACTIONS', actions: 2 });
    const texte = await parler(p);
    // Lot 68 : plus d'introduction de comptage ; action distincte gardée, sans « À prévoir : ».
    expect(texte).not.toMatch(/méritent votre attention|À prévoir :/);
    expect(texte).toContain('Envoyer la demande de résiliation.');
    expect(texte).not.toMatch(INTERDITS);
    expect((await B()).actionTiles(p).map((x) => x.label)).toEqual(['Fin du contrat de gaz', 'Ramonage cheminée']);
    const cartes = (await B()).subjectBlocks(p);
    expect(cartes.map((x) => x.badge)).toEqual(['Action à prévoir', 'À vérifier']);
    expect(cartes.map((x) => x.actions[0].action.target)).toEqual([
      expect.objectContaining({ kind: 'drawer', id: gaz }), expect.objectContaining({ kind: 'drawer', id: ramonage })]);
    expect((await B()).homePose(p, false)).toBe('questioning');
    // Rapport d'affichage : l'écart IA (SHOW_NOW) / serveur (seuil) est tracé pour l'assurance.
    const repo = await import('@/services/ai/execution-report/repository');
    await vi.waitFor(async () => {
      const [r] = await sql<[{ id: number }?]>`SELECT id FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND trigger_code = 'pregen' ORDER BY id DESC LIMIT 1`;
      expect(r).toBeDefined();
      const rapport = await repo.getExecutionReport(Number(r!.id));
      const { entries } = await repo.readReportEntries(rapport!, { section: 'INTERPELLATION' });
      expect(entries.find((e) => e.entityId === assurance)?.value).toMatchObject({ decision: 'SUPPRESS', aiDecision: 'SHOW_NOW', divergence: true });
      const f = (await repo.readReportEntries(rapport!, { section: 'FORMULATE' })).entries[0];
      expect(f?.value).toMatchObject({ mode: 'FORMULATE', contract: 't6-output-v2', transmitted: [`DATE-NEXT:${gaz}`, `MASC-EXT-ACTION:${ramonage}`] });
    }, { timeout: 10_000 });
  });

  it('T6-EV-04 / T6-EV-11 / T6-EV-19 — sortie invalide ou panne : rien d’accepté en silence, aucune échéance artificielle, état dégradé explicite', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision chaudière', await plus(15));
    // 1. Décision non justifiée (SHOW_NOW sans action) : rejetée, motif tracé.
    modele.juger = () => AGIR({ expectedAction: null });
    const p = await pregen(c.id);
    expect(ids(p)).toEqual([]);
    expect((await sql`SELECT 1 FROM t6_interpellation_assessments WHERE account_id = ${c.id}`).length).toBe(0);
    expect(p.state).toMatchObject({ evaluation: 'UNAVAILABLE' });
    expect(await parler(p)).toBe('Je ne peux pas examiner vos échéances pour le moment : elles restent consultables dans l’agenda.');
    expect(await parler(p)).not.toMatch(INTERDITS);
    expect((await B()).homePose(p, false)).toBe('neutral');
    const repo = await import('@/services/ai/execution-report/repository');
    await vi.waitFor(async () => {
      const [r] = await sql<[{ id: number }?]>`SELECT id FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND trigger_code = 'evaluate:pregen' ORDER BY id DESC LIMIT 1`;
      expect(r).toBeDefined();
      const rapport = await repo.getExecutionReport(Number(r!.id));
      expect(rapport).toMatchObject({ status: 'PARTIAL', counters: { evaluated: 1, accepted: 0, rejected: 1 } });
      const { entries } = await repo.readReportEntries(rapport!, { section: 'EVALUATE' });
      expect(entries[0]).toMatchObject({ entityId: e, recordStatus: 'REJECTED', reasonCode: 'VALIDATION:show_now_without_action', writeResult: 'NOT_PERSISTED' });
      expect(JSON.stringify(entries)).not.toMatch(/chaudière|Lilas/i);
    }, { timeout: 10_000 });
    // 2. Sortie hors contrat (ordre / nombre) : rejetée EN ENTIER.
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    modele.brute = { schemaVersion: 't6-evaluation-v1', decisions: [] };
    const q = await pregen(c.id);
    expect(ids(q)).toEqual([]);
    expect((await sql`SELECT 1 FROM t6_interpellation_assessments WHERE account_id = ${c.id}`).length).toBe(0);
    // 3. Panne du fournisseur : même état explicite, jamais « Tout est à jour ».
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    modele.brute = null;
    modele.panne = true;
    const r = await pregen(c.id);
    expect(ids(r)).toEqual([]);
    expect(await parler(r)).toMatch(/Je ne peux pas examiner vos échéances/);
    // Pas de nouvel essai immédiat (plafond de coût) : l'affichage suivant n'appelle pas EVALUATE.
    const n = modele.evaluate.length;
    await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    await new Promise((x) => setTimeout(x, 50));
    expect(modele.evaluate).toHaveLength(n);
  });

  it('T6-EV-20 — l’affichage n’attend jamais EVALUATE ; la décision validée sert l’affichage suivant', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision chaudière', await plus(15));
    modele.juger = () => AGIR();
    modele.latenceEvaluateMs = 1_500;
    const t0 = performance.now();
    const p = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(performance.now() - t0).toBeLessThan(1_200);
    expect(ids(p)).toEqual([]);
    expect(p.state).toMatchObject({ evaluation: 'PENDING' });
    expect(await parler(p)).toBe('J’examine encore vos prochaines échéances : elles restent consultables dans l’agenda.');
    await vi.waitFor(async () => {
      expect((await sql`SELECT 1 FROM t6_interpellation_assessments WHERE account_id = ${c.id}`).length).toBe(1);
    }, { timeout: 10_000 });
    const d = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(ids(d)).toEqual([e]);
    expect(modele.evaluate).toHaveLength(1);
  });

  it('T6-EV-09 / T6-EV-10 — « À traiter » prioritaire signalé, document en analyse présenté, sans affirmation non fondée', async () => {
    const c = await compte();
    const [doc] = await sql<[{ id: number }]>`SELECT id FROM asset_files WHERE account_id = ${c.id} LIMIT 1`;
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZING', upload_status = 'COMPLETED', updated_at = now() WHERE id = ${doc.id}`;
    const p = await pregen(c.id);
    expect(sujets(p).map((x) => x.sourceCode)).toEqual(['PROC-DOC-ANALYSIS']);
    expect(p.state).toMatchObject({ kind: 'INFORMATION' });
    expect(await parler(p)).toMatch(/^Le document « Contrat habitation » est en cours d’analyse\./);
    expect(await parler(p)).not.toMatch(INTERDITS);
    // Lot 78C : documents en cours d'analyse — mascotte « au travail » (jamais la pose de réussite).
    expect((await B()).homePose(p, false)).toBe('document-analysis-pdf');
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, priority)
              VALUES (${c.id}, 'ASSET', ${c.maison}, 'purchasePriceCents', 'COMPLETE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?', 'DO_FIRST')`;
    const q = await pregen(c.id);
    // Lot 71F : plus d'introduction de comptage — le document directement, la carte « À traiter » à part.
    expect(await parler(q)).toMatch(/^Le document « Contrat habitation »/);
    expect(await parler(q)).not.toMatch(/votre attention/);
    // Lot 68 : « À traiter » en carte, le document dans son bloc.
    expect((await B()).homeItems(q, false).map((x) => x.kind)).toEqual(['todo']);
    expect((await B()).subjectBlocks(q).map((x) => x.paragraph.sourceCode)).toEqual(['PROC-DOC-ANALYSIS']);
    expect((await B()).homePose(q, false)).toBe('reminder-bell');
  });

  it('T6-EV-18 — préférences de rappel respectées malgré une décision SHOW_NOW ; évaluations cloisonnées par compte', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision chaudière', await plus(15));
    const revue = await plus(30);
    modele.juger = () => AGIR({ suggestedReviewAt: revue });
    await pregen(c.id);
    expect(ids(await pregen(c.id, c.ownerUserId))).toEqual([e]);
    // La réévaluation suggérée par l'IA n'est jamais un rappel utilisateur.
    expect((await sql`SELECT 1 FROM t6_reminder_preferences WHERE account_id = ${c.id}`).length).toBe(0);
    await sql`INSERT INTO t6_reminder_preferences (account_id, user_id, subject_key, scope, agenda_item_id, decision, remind_at, context_fingerprint)
              VALUES (${c.id}, ${c.ownerUserId}, ${`agenda:${e}`}, 'OCCURRENCE', ${e}, 'SNOOZED', ${await plus(5)}, NULL)`;
    const p = await pregen(c.id, c.ownerUserId);
    expect(ids(p)).toEqual([]);
    expect(await parler(p)).not.toMatch(/chaudière|mérite/i);
    // Isolation : une décision rattachée à l'échéance d'un AUTRE compte n'est jamais écrite.
    const y = await compte();
    const ey = await echeance(y, 'Échéance du compte Y', await plus(10));
    const { persistT6Assessments } = await import('@/services/home/mascot/t6-interpellation.service');
    const n = await persistT6Assessments(c.id, await jour(), new Map([['C1', { subjectKey: `agenda:${ey}`, agendaItemId: ey, fingerprint: 'x', daysUntilDue: 10 }]]), [{
      subjectId: 'C1', decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Tentative intercomptes.', expectedAction: 'Agir',
      actionDeadline: null, suggestedReviewAt: null, priorityHint: 'HIGH', evidenceRefs: ['C1.title'], uncertainties: [],
    }], { promptVersion: 'v', traceId: null });
    expect(n).toBe(0);
    expect((await sql`SELECT 1 FROM t6_interpellation_assessments WHERE agenda_item_id = ${ey}`).length).toBe(0);
    // Le compte Y est évalué pour lui-même : ses décisions restent les siennes.
    modele.juger = () => AUCUNE;
    expect(ids(await pregen(y.id))).toEqual([]);
    expect(await sql`SELECT account_id FROM t6_interpellation_assessments WHERE agenda_item_id = ${ey}`).toEqual([{ account_id: y.id }]);
    expect(ids(await pregen(c.id, c.ownerUserId))).toEqual([]);
  });

  it('T6-EV-21 — migration 0447 rejouable ; contraintes du contrat ; évaluation du lot 60 jamais réutilisée', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0447_t6_evaluation_contract.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    const c = await compte();
    const e = await echeance(c, 'Révision chaudière', await plus(15));
    const insert = (cols: string) => sql.unsafe(`INSERT INTO t6_interpellation_assessments
        (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority, reason${cols ? `, ${cols.split('=')[0]}` : ''})
      VALUES (${c.id}, ${e}, 'agenda:${e}', 'fp', CURRENT_DATE, 'ACT_NOW', TRUE, 'HIGH', 'r'${cols ? `, ${cols.split('=')[1]}` : ''})`);
    await expect(insert(`decision='PEUT-ETRE'`)).rejects.toThrow(/decision_check/);
    await expect(insert(`contract_version='t6-evaluation-v1'`)).rejects.toThrow(/contract_check/);
    // Évaluation du lot 60 (sans contrat), même empreinte : jamais réutilisée → réévaluation.
    const { agendaFingerprint } = await import('@/services/home/mascot/t6-interpellation.service');
    const fp = agendaFingerprint({ title: 'Révision chaudière', date: await plus(15), forecast: false, requiresQualification: false });
    await sql`INSERT INTO t6_interpellation_assessments (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority, reason)
              VALUES (${c.id}, ${e}, ${`agenda:${e}`}, ${fp}, CURRENT_DATE, 'ACT_NOW', TRUE, 'HIGH', 'R13 lot 60')`;
    modele.juger = () => AUCUNE;
    const p = await pregen(c.id);
    expect(modele.evaluate).toHaveLength(1);
    expect(ids(p)).toEqual([]);
    const [row] = await sql<[{ contract_version: string; decision: string }]>`SELECT contract_version, decision FROM t6_interpellation_assessments WHERE agenda_item_id = ${e}`;
    expect(row).toEqual({ contract_version: 't6-evaluation-v1', decision: 'SUPPRESS' });
  });
});
