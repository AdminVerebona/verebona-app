/**
 * Lot 55A — ticket « T6 / T2 — Cohérence des suggestions IA et correction des
 * cartes d'échéance » — de bout en bout sur PostgreSQL 16 réel : vrai
 * collecteur, vraie mascotte (`getMascotPresentation`), vraie passerelle IA,
 * vrai T2 (`runAssistant` + ports réels). Modèle SIMULÉ (aucun réseau) :
 *   · T6 (`MODE = FORMULATE`) : recopie les textes de secours et rend les
 *     questions que le scénario lui confie ; le prompt reçu est conservé ;
 *   · T2 : UNDERSTAND ne comprend rien (les questions doivent être routées
 *     sans lui), ANSWER cite la première source.
 *
 *  L55A-E2E-01  constat du ticket (« Aucun sujet à traiter en priorité »)
 *               → questions de T6, contexte = message affiché + compte ;
 *               jamais « Que dois-je traiter en priorité ? » du catalogue ;
 *  L55A-E2E-02  questions cliquées → T2 répond (sources du compte, sans repli) ;
 *  L55A-E2E-03  actualisation : changement du compte → nouvelles questions,
 *               jamais celles de l'ancien état sous le nouveau message ;
 *  L55A-E2E-04  IA indisponible : accueil fonctionnel, aucune question ;
 *  L55A-E2E-05  isolation stricte des comptes (contexte, cache, biens) ;
 *  L55A-E2E-06  cartes d'échéance : intitulé métier, « bien · date complète »,
 *               une seule action « Voir », même cible.
 *
 * Lot 87C (contrat des questions fondées `t6-suggestions-v3`) : les questions
 * simulées portent sujet, finalité, décision et fondements ; la version du
 * prompt porteuse du contrat est SIMULÉE (`activerContratQuestions`, aucun
 * prompt modifié). L87C-E2E-01 à 05 : AC01, AC02, AC06, AC07, AC09, AC10,
 * AC12, AC14 de bout en bout (Homiris en non-régression, sans règle propre).
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';
import { dansJours, evaluerEcheance } from '../t6-assessment';
import { activerContratQuestions, fondee, premiereEcheance } from '../t6-suggestions-v3';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

type Compte = { id: number; ownerUserId: number };
type Q = Record<string, unknown>;
type Candidat = { subjectId: string; title: string; evidence: Array<{ ref: string; kind: string }> };

/** Modèle simulé : T6 piloté par le scénario ; T2 sans compréhension modèle. */
const modele = vi.hoisted(() => ({
  t6Prompts: [] as string[],
  questions: (_ctx: Record<string, unknown>): Q[] => [],
  t6Down: false,
  /** Lot 87C : décision EVALUATE d'un candidat (null : SUPPRESS « aucune démarche »). */
  juger: (_c: Candidat): Record<string, unknown> | null => null,
}));

function provider() {
  return {
    name: 'simule-l55a',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      // Lot 61 : MODE=EVALUATE (pertinence des interpellations) — rien à signaler.
      if (/^MODE = EVALUATE$/m.test(input.prompt)) {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        return {
          rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions: ctx.candidates.map((c) => ({
            subjectId: c.subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
            reason: 'Échéance connue et suivie dans l’agenda.', expectedAction: null, actionDeadline: null, suggestedReviewAt: null,
            priorityHint: null, evidenceRefs: [`${c.subjectId}.title`], uncertainties: [],
            ...(modele.juger(c) ?? {}),
          })) }),
          inputTokens: 100, outputTokens: 20,
        };
      }
      if (/^MODE = FORMULATE$/m.test(input.prompt)) {
        if (modele.t6Down) throw new Error('T6 indisponible (simulation)');
        modele.t6Prompts.push(input.prompt);
        const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
        const brut = /Contexte des questions suggérées : (.*)\n/.exec(input.prompt)?.[1] ?? 'null';
        const ctx = JSON.parse(brut) as Record<string, unknown> | null;
        return {
          rawText: JSON.stringify({
            schemaVersion: 't6-output-v2',
            messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
            suggestions: ctx ? modele.questions(ctx) : [],
          }),
          inputTokens: 200, outputTokens: 40,
        };
      }
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\b(?:document|agenda_item|help)_[A-Za-z0-9_-]+\b/g) ?? [])];
        return {
          rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [{ text: 'Voici ce que j’ai trouvé.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }] }),
          inputTokens: 100, outputTokens: 20,
        };
      }
      return {
        rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }),
        inputTokens: 50, outputTokens: 10,
      };
    },
  };
}

scenario('L55A-SUGG', 'Lot 55A — questions suggérées par T6, cohérentes avec la bulle ; cartes d’échéance', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.t6Prompts.length = 0;
    modele.t6Down = false;
    modele.questions = () => [];
    modele.juger = () => null;
    (await import('@/services/home/mascot/t6-runner')).resetT6Breaker();
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    // Lot 87C : version du prompt T6 porteuse du contrat des questions fondées (simulée, activée « au BO »).
    await activerContratQuestions(true);
  });
  afterEach(async () => {
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    await activerContratQuestions(false);
  });

  const svc = () => import('@/services/home/mascot/mascot.service');
  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  /** Compte du ticket : Cupra (voiture), un document, contrôle technique à venir, un « À traiter » non prioritaire. */
  async function compteDuTicket(nom = 'Cupra') {
    const c = await compte();
    const cupra = await make.asset(c as never, { category: 'VEHICULE', name: nom });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Voiture' WHERE id = ${cupra.id}`;
    const f = await make.assetFile(c as never, { assetId: cupra.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture entretien garage', original_filename = 'facture.pdf', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const ech = await make.agendaItem(c as never, { title: `Prochain contrôle technique — ${nom.toUpperCase()} LEON`, startDate: '2028-04-18', assetIds: [cupra.id] });
    await sql`UPDATE agenda_items SET is_automatic = TRUE, origin_type = 'asset_field', event_nature = 'DEADLINE', manual_status = NULL WHERE id = ${ech.id}`;
    // « À traiter » qui n'est pas « À faire en premier » : la bulle dit « Aucun sujet… ».
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, priority)
              VALUES (${c.id}, 'ASSET', ${cupra.id}, 'purchasePriceCents', 'COMPLETE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?', 'CAN_WAIT')`;
    return { c, cupra: cupra.id, echeance: ech.id };
  }
  const questionsDe = (p: import('@/services/home/mascot/types').MascotPresentation) =>
    p.secondaries.filter((s) => s.action.target.kind === 'ask').map((s) => s.action.label);
  const contexteDu = (prompt: string) => JSON.parse(/Contexte des questions suggérées : (.*)\n/.exec(prompt)![1]);

  it('L55A-E2E-01 — « Aucun sujet à traiter en priorité » : questions rédigées par T6 à partir du message affiché, jamais le catalogue', async () => {
    const { c } = await compteDuTicket();
    modele.questions = (ctx) => {
      const assets = ctx.assets as Array<{ ref: string; name: string; documentsRef: string }>;
      return [
        fondee(ctx, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES']),
        fondee(ctx, `Quels sont les documents de ${assets[0].name} ?`, [assets[0].ref, assets[0].documentsRef], { assetRef: assets[0].ref }),
      ];
    };
    const { getMascotPresentation } = await svc();
    const p = await getMascotPresentation(c.id, 'pregen');
    const { composeSpeech, NOTHING_PRIORITY, homeSuggestions } = await import('@/services/home/mascot/bubble');
    expect(composeSpeech({ presentation: p, empty: false }).text.startsWith(NOTHING_PRIORITY)).toBe(true);

    // Un seul appel T6 : bulle + questions, avec le message affiché et le compte.
    expect(modele.t6Prompts).toHaveLength(1);
    const ctx = contexteDu(modele.t6Prompts[0]);
    expect(ctx.bubble.speech.startsWith(NOTHING_PRIORITY)).toBe(true);
    expect(ctx.bubble.attentionToday).toBe(false);
    expect(ctx.account).toMatchObject({ hasDocuments: true, hasPendingToProcess: true, hasUpcomingDeadlines: true });
    expect(ctx.assets).toEqual([{ ref: 'A1', name: 'Cupra', hasDocuments: true, hasDeadlinesNext30Days: false, documentsRef: 'A1.DOCS' }]);
    // Lot 72A : référence opaque et statut « signalé » ; lot 87C : décision T6, démarche, faits, documents.
    expect(ctx.schemaVersion).toBe('t6-suggestions-v3');
    expect(ctx.nextDeadlines).toMatchObject([{ ref: 'D1', label: 'Contrôle technique', assetRef: 'A1', dateLabel: '18 avril 2028', dateNature: 'confirmée', signaled: false, identifiedAction: null }]);

    expect(questionsDe(p)).toEqual(['Quelle est ma prochaine échéance ?', 'Quels sont les documents de Cupra ?']);
    expect(questionsDe(p)).not.toContain('Que dois-je traiter en priorité ?');
    expect(homeSuggestions(p, false, []).map((x) => x.label)).toEqual(questionsDe(p));

    // Affichage suivant : même contexte → cache (aucun nouvel appel), mêmes questions, même empreinte.
    const d = await getMascotPresentation(c.id, 'display');
    expect(modele.t6Prompts).toHaveLength(1);
    expect(questionsDe(d)).toEqual(questionsDe(p));
    expect(d.contextHash).toBe(p.contextHash);
    const [cache] = await sql<{ s: Array<Record<string, unknown>>; contrat: string | null; trace: string | null }[]>`
      SELECT suggestions AS s, suggestion_contract AS contrat, trace_id AS trace FROM home_mascot_cache WHERE account_id = ${c.id}`;
    // Lot 87C : contrat, trace et fondements conservés avec les questions (revalidés à la relecture).
    expect(cache.contrat).toBe('t6-suggestions-v3');
    expect(cache.trace).toBeTruthy();
    expect(cache.s).toMatchObject([
      { question: 'Quelle est ma prochaine échéance ?', subject: 'DEADLINES', groundRefs: ['ACC.DEADLINES'], grounds: [{ key: 'account:hasUpcomingDeadlines' }] },
      { question: 'Quels sont les documents de Cupra ?', subject: 'ASSET', assetRef: 'A1', groundRefs: ['A1', 'A1.DOCS'] },
    ]);
  });

  it('L55A-E2E-02 — questions cliquées : T2 les exécute comme aujourd’hui (bien revalidé, sources du compte, aucun repli)', async () => {
    const { c, cupra } = await compteDuTicket();
    modele.questions = (ctx) => [
      fondee(ctx, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES']),
      fondee(ctx, 'Quels sont les documents de Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }),
    ];
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen');
    const asks = p.secondaries.filter((s) => s.action.target.kind === 'ask');
    expect(asks).toHaveLength(2);
    const docs = asks[1].action.target;
    expect(docs.kind === 'ask' && docs.context.assetId).toBe(cupra);
    for (const s of asks) {
      const t = s.action.target;
      if (t.kind !== 'ask') continue;
      // Contexte que la mascotte envoie au clic (MascotSpeaks → space.ask).
      const r = await demander(c, t.question, { pageContext: { route: '/accueil', intent: t.context.intent, ...(t.context.assetId ? { assetId: String(t.context.assetId) } : {}) } });
      expect(r.clarification ?? null, t.question).toBeNull();
      expect(r.cascade?.fallbackUsed ?? false, t.question).toBe(false);
      expect((r.sources ?? []).length, t.question).toBeGreaterThan(0);
      expect(String(r.answer ?? ''), t.question).not.toMatch(/Je n’ai rien trouvé|semblent liés|Résultats proches/);
    }
  });

  it('L55A-E2E-03 — actualisation : le compte change → contexte, bulle et questions changent ensemble ; jamais les anciennes', async () => {
    const { c, echeance } = await compteDuTicket();
    modele.questions = (ctx) => ((ctx.nextDeadlines as unknown[]).length
      ? [fondee(ctx, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES'])]
      : [fondee(ctx, 'Quels sont les documents de Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' })]);
    const { getMascotPresentation } = await svc();
    const avant = await getMascotPresentation(c.id, 'pregen');
    expect(questionsDe(avant)).toEqual(['Quelle est ma prochaine échéance ?']);

    // L'échéance est réalisée : plus de prochaine échéance.
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${echeance}`;
    // Affichage immédiat (aucune attente) : la génération part en arrière-plan,
    // l'ancienne question n'est JAMAIS servie sous le nouveau message.
    const immediat = await getMascotPresentation(c.id, 'display');
    expect(questionsDe(immediat)).not.toContain('Quelle est ma prochaine échéance ?');
    const apres = await getMascotPresentation(c.id, 'pregen');
    expect(questionsDe(apres)).toEqual(['Quels sont les documents de Cupra ?']);
    expect(apres.contextHash).not.toBe(avant.contextHash);
    const derniers = contexteDu(modele.t6Prompts.at(-1)!);
    expect(derniers.nextDeadlines).toEqual([]);
  });

  it('L55A-E2E-04 — IA indisponible : accueil fonctionnel (texte de secours, cartes), aucune question', async () => {
    const { c, echeance } = await compteDuTicket();
    // Lot 60 : échéance proche, déjà jugée « à traiter » par T6 — seule une
    // échéance DÉCIDÉE est présentée (le contrôle de 2028 ne l'est plus).
    await sql`UPDATE agenda_items SET start_date = ${dansJours(20)} WHERE id = ${echeance}`;
    await evaluerEcheance(sql, echeance);
    modele.t6Down = true;
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen');
    expect(p.status).toBe('ok');
    expect(p.paragraphs.length).toBeGreaterThan(0);
    expect(questionsDe(p)).toEqual([]);
    // Lot 68 : le sujet est présenté dans son bloc (texte de secours + « Voir »).
    const { subjectBlocks } = await import('@/services/home/mascot/bubble');
    expect(subjectBlocks(p).length).toBeGreaterThan(0);
  });

  it('L55A-E2E-05 — isolation : contexte, cache et biens propres au compte ; référence inconnue écartée', async () => {
    const a = await compteDuTicket('Cupra');
    const b = await compteDuTicket('Twingo');
    modele.questions = (ctx) => [
      fondee(ctx, 'Quels sont les documents de Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }),
      // Lot 87C (AC11) : références d'un autre compte (A2, fondement inexistant ici) — rejet systématique.
      fondee(ctx, 'Et le bien A2 ?', ['A2'], { assetRef: 'A2', informationNature: ['ASSET_DATA'] }),
    ];
    const { getMascotPresentation } = await svc();
    await getMascotPresentation(a.c.id, 'pregen');
    const pb = await getMascotPresentation(b.c.id, 'pregen');
    const ctxB = contexteDu(modele.t6Prompts.at(-1)!);
    expect(JSON.stringify(ctxB)).not.toContain('Cupra');
    expect(ctxB.assets.map((x: { name: string }) => x.name)).toEqual(['Twingo']);
    // A1 du compte B désigne SON bien ; A2 n'existe pas : question abandonnée.
    const asks = pb.secondaries.filter((s) => s.action.target.kind === 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0].action.target.kind === 'ask' && asks[0].action.target.context.assetId).toBe(b.cupra);
    const cles = await sql<{ account_id: number }[]>`SELECT DISTINCT account_id FROM home_mascot_cache WHERE account_id IN (${a.c.id}, ${b.c.id})`;
    expect(cles.map((x) => Number(x.account_id)).sort()).toEqual([a.c.id, b.c.id].sort());
  });

  it('L55A-E2E-06 — carte d’échéance : « Contrôle technique » / « Cupra · 18 avril 2028 » / « Voir → », tiroir de l’échéance', async () => {
    const { c, echeance } = await compteDuTicket();
    // Lot 60 : le contrôle de 2028 n'est plus présenté d'office (au-delà du
    // seuil, aucune démarche) ; une échéance proche, jugée « à traiter » par
    // T6, garde la même carte — l'état d'interpellation s'ajoute au statut.
    const date = dansJours(20);
    await sql`UPDATE agenda_items SET start_date = ${date} WHERE id = ${echeance}`;
    await evaluerEcheance(sql, echeance);
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen');
    // Lot 68 : métadonnées de tuile conservées (nature, fenêtre de rappel) ; l'accueil affiche un bloc « Voir ».
    const { actionTiles, subjectBlocks } = await import('@/services/home/mascot/bubble');
    const { formatDateFr } = await import('@/services/home/mascot/signals');
    expect(actionTiles(p)[0]).toMatchObject({ label: 'Contrôle technique', sub: `Cupra · Action à prévoir · ${formatDateFr(date)}` });
    const [bloc] = subjectBlocks(p);
    expect(bloc.actions.map((a) => a.label)).toEqual(['Voir']);
    expect(bloc.actions[0].action.target).toEqual({ kind: 'drawer', drawer: 'echeance', id: echeance, mode: 'view' });
  });

  // ══ Lot 87C — questions fondées ═══════════════════════════════════════════

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  /** Compte « Homiris » : maison, fin de contrat signalée par T6 (démarche identifiée). */
  async function compteHomiris() {
    const c = await compte();
    const maison = await make.asset(c as never, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    const e = await make.agendaItem(c as never, { title: 'Fin de contrat Homiris', startDate: await plus(20), assetIds: [maison.id] });
    await sql`UPDATE agenda_items SET home_category = 'action' WHERE id = ${e.id}`;
    return { c, maison: maison.id, echeance: e.id };
  }
  /** Contrat lié à l'échéance, avec un fait de préavis extrait (T1). */
  async function contratAvecPreavis(x: { c: Compte; maison: number; echeance: number }, valeur = '2 mois avant l’échéance') {
    const f = await make.assetFile(x.c as never, { assetId: x.maison });
    await sql`UPDATE asset_files SET retained_title = 'Contrat de télésurveillance', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${x.echeance}, ${f.id})`;
    const [d] = await sql<[{ id: number }]>`INSERT INTO document_extractions (account_id, file_id, title) VALUES (${x.c.id}, ${f.id}, 'Contrat de télésurveillance') RETURNING id`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt)
              VALUES (${x.c.id}, ${f.id}, ${d.id}, 'notice_period', 'Préavis de résiliation', ${valeur}, ${valeur}, 'certain', 'Préavis de résiliation : deux mois.')`;
    return f.id;
  }
  /** T6 EVALUATE : fin de contrat à signaler, démarche identifiée ; cite le fait de préavis s'il est transmis. */
  const signalerAvecDemarche = (c: Candidat) => ({
    decision: 'SHOW_NOW', category: 'TO_ANTICIPATE', reasonCode: 'NOTICE_PERIOD_RUNNING', reason: 'La fin du contrat approche : la démarche de résiliation est à anticiper.',
    expectedAction: 'Vérifier les conditions de résiliation', priorityHint: 'MEDIUM',
    evidenceRefs: [c.evidence.find((e) => e.kind === 'DOCUMENT_FACT')?.ref ?? `${c.subjectId}.title`],
  });
  /** Générations réussies du compte — le journal T6 est écrit en arrière-plan (`void logT6`) : attendu. */
  const generations = async (accountId: number, au_moins = 1) => vi.waitFor(async () => {
    const r = await sql<Array<{ status: string; trace_id: string | null; report: Record<string, unknown> | null }>>`
      SELECT status, trace_id, suggestion_report AS report FROM home_mascot_generations WHERE account_id = ${accountId} AND status = 'generated' ORDER BY id`;
    if (r.length < au_moins) throw new Error('journal T6 pas encore écrit');
    return r;
  }, { timeout: 5_000, interval: 50 });
  /** Questions Homiris rendues par T6 FORMULATE (préparer + consulter), fondements recopiés du contexte. */
  const questionsHomiris = (ctx: Record<string, unknown>) => {
    const d = premiereEcheance(ctx) as { ref: string; label: string; identifiedAction: { ref: string } | null; facts: Array<{ ref: string }> };
    const preparer = [d.ref, ...(d.identifiedAction ? [d.identifiedAction.ref] : []), ...d.facts.map((f) => f.ref)];
    return [
      fondee(ctx, `Comment préparer la ${d.label.toLowerCase()} ?`, preparer, { purpose: 'PREPARE' }),
      fondee(ctx, `Quand a lieu la ${d.label.toLowerCase()} ?`, [d.ref]),
    ];
  };

  it('L87C-E2E-01 — AC01 / AC02 / AC12 (Homiris, non-régression) : échéance signalée sans preuve → aucune question « préparer » ; contrat et préavis extraits → « préparer » proposée', async () => {
    const x = await compteHomiris();
    modele.juger = signalerAvecDemarche;
    modele.questions = questionsHomiris;
    const { getMascotPresentation } = await svc();
    await getMascotPresentation(x.c.id, 'pregen');
    const p = await getMascotPresentation(x.c.id, 'pregen');
    // La fin de contrat est SIGNALÉE (décision T6), sa démarche identifiée mais NON établie.
    expect(p.paragraphs.some((b) => b.reminder?.agendaItemId === x.echeance)).toBe(true);
    const ctx = contexteDu(modele.t6Prompts.at(-1)!);
    expect(premiereEcheance(ctx)).toMatchObject({ signaled: true, evaluation: { status: 'EVALUATED', reasonCode: 'NOTICE_PERIOD_RUNNING' }, identifiedAction: { basis: 'NOT_ESTABLISHED' }, facts: [] });
    // AC01 : la question « préparer » n'est pas publiée ; la consultation légitime reste (AC12), jamais convertie.
    expect(questionsDe(p)).toEqual([expect.stringMatching(/^Quand a lieu/)]);
    const [g1] = (await generations(x.c.id)).slice(-1);
    expect(g1.report).toMatchObject({ contract: 't6-suggestions-v3', produced: 2, accepted: 1, rejected: 1, reasons: { prepare_without_concrete_ground: 1 } });

    // AC02 : le contrat et son préavis (fait prouvé) sont disponibles — T6 réévalue sur cette preuve.
    await contratAvecPreavis(x);
    await getMascotPresentation(x.c.id, 'pregen');
    const q = await getMascotPresentation(x.c.id, 'pregen');
    const ctx2 = contexteDu(modele.t6Prompts.at(-1)!);
    expect(premiereEcheance(ctx2)).toMatchObject({
      identifiedAction: { basis: 'ESTABLISHED' }, facts: [{ ref: 'D1.F1', nature: 'DOCUMENT_FACT', status: 'PROVEN', value: '2 mois avant l’échéance' }],
      documents: [{ ref: 'D1.DOC1', title: 'Contrat de télésurveillance' }],
    });
    expect(JSON.stringify(ctx2)).not.toMatch(/"fileId"|"factKey"|notice_period/);
    expect(questionsDe(q)).toEqual([expect.stringMatching(/^Comment préparer la /), expect.stringMatching(/^Quand a lieu/)]);
    expect(questionsDe(q)[0].toLowerCase()).toContain(String((premiereEcheance(ctx2) as { label: string }).label).toLowerCase());
    const [g2] = (await generations(x.c.id, 2)).slice(-1);
    expect(g2.report).toMatchObject({ accepted: 2, rejected: 0 });
    expect((g2.report!.acceptedGrounds as Array<{ keys: string[] }>)[0].keys).toEqual(expect.arrayContaining([`agenda:${x.echeance}`, `t6:agenda:${x.echeance}`]));
  });

  it('L87C-E2E-02 — AC07 : source modifiée sans changement des compteurs → question périmée jamais resservie, renouvellement sur le contexte courant', async () => {
    const x = await compteHomiris();
    await contratAvecPreavis(x);
    modele.juger = signalerAvecDemarche;
    modele.questions = (ctx) => {
      const d = premiereEcheance(ctx) as { ref: string; label: string; facts: Array<{ ref: string; value: string }> };
      return [fondee(ctx, `Que prévoit le préavis de la ${d.label.toLowerCase()} (${d.facts[0]?.value ?? '?'}) ?`, [d.ref, ...d.facts.map((f) => f.ref)])];
    };
    const { getMascotPresentation } = await svc();
    await getMascotPresentation(x.c.id, 'pregen');
    const avant = await getMascotPresentation(x.c.id, 'pregen');
    expect(questionsDe(avant)).toEqual([expect.stringContaining('(2 mois avant l’échéance)')]);
    const appels = modele.t6Prompts.length;
    // Même nombre de biens, documents, échéances : seule la valeur du fait change.
    await sql`UPDATE document_facts SET value_text = '3 mois avant l’échéance', normalized_value = '3 mois avant l’échéance' WHERE account_id = ${x.c.id}`;
    await getMascotPresentation(x.c.id, 'pregen');
    const apres = await getMascotPresentation(x.c.id, 'pregen');
    expect(modele.t6Prompts.length).toBeGreaterThan(appels);
    expect(questionsDe(apres)).toEqual([expect.stringContaining('(3 mois avant l’échéance)')]);
    expect(questionsDe(apres).join(' ')).not.toContain('2 mois');
    // Relecture sans changement : aucun nouvel appel (aucune régénération inutile).
    const n = modele.t6Prompts.length;
    expect(questionsDe(await getMascotPresentation(x.c.id, 'display'))).toEqual(questionsDe(apres));
    expect(modele.t6Prompts.length).toBe(n);
  });

  it('L87C-E2E-03 — AC10 / AC06 : prompt sans le contrat → aucun contexte ni question ; avec le contrat, zéro question est une issue normale', async () => {
    const { c } = await compteDuTicket();
    await activerContratQuestions(false);
    modele.questions = (ctx) => [fondee(ctx, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES'])];
    const { getMascotPresentation } = await svc();
    const p = await getMascotPresentation(c.id, 'pregen');
    expect(questionsDe(p)).toEqual([]);
    expect(p.status).toBe('ok');
    // Aucun contexte de questions transmis à un prompt qui ne porte pas le contrat (fichier du dépôt).
    for (const prompt of modele.t6Prompts) expect(/Contexte des questions suggérées : (.*)\n/.exec(prompt)?.[1]).toBe('null');
    // Avec le contrat : T6 ne propose rien → aucune question, génération réussie, aucun complément.
    await activerContratQuestions(true);
    modele.questions = () => [];
    const q = await getMascotPresentation(c.id, 'pregen');
    expect(questionsDe(q)).toEqual([]);
    expect(q.status).toBe('ok');
    const [g] = (await generations(c.id)).slice(-1);
    expect(g.report).toMatchObject({ contract: 't6-suggestions-v3', produced: 0, accepted: 0, rejected: 0 });
  });

  it('L87C-E2E-04 — AC09 : entrée de cache d’un contrat antérieur jamais servie, renouvellement conforme', async () => {
    const { c } = await compteDuTicket();
    modele.questions = (ctx) => [fondee(ctx, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES'])];
    const { getMascotPresentation } = await svc();
    await getMascotPresentation(c.id, 'pregen');
    const n = modele.t6Prompts.length;
    // Entrée ramenée à l'état d'une version antérieure (sans contrat, questions sans fondements).
    await sql`UPDATE home_mascot_cache SET suggestion_contract = NULL,
                suggestions = '[{"question":"Que dois-je préparer ?","assetRef":null,"deadlineRef":null,"purpose":null}]'::jsonb WHERE account_id = ${c.id}`;
    const p = await getMascotPresentation(c.id, 'pregen');
    expect(modele.t6Prompts.length).toBe(n + 1);
    expect(questionsDe(p)).toEqual(['Quelle est ma prochaine échéance ?']);
    expect(questionsDe(p)).not.toContain('Que dois-je préparer ?');
  });

  it('L87C-E2E-05 — AC05 / AC14 : génération partiellement valide — une seule question, rejets tracés au journal, au BO et au rapport T6', async () => {
    const { c } = await compteDuTicket();
    modele.questions = (ctx) => [
      fondee(ctx, 'Comment préparer le contrôle technique ?', ['D1'], { purpose: 'PREPARE' }),
      fondee(ctx, 'Quels sont les documents de Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }),
      fondee(ctx, 'Où sont mes factures ?', ['D9'], { informationNature: ['DEADLINE_DATA'], subject: 'DOCUMENTS', deadlineRef: null }),
      fondee(ctx, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES']),
    ];
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen');
    expect(questionsDe(p)).toEqual(['Quels sont les documents de Cupra ?']);
    const [g] = (await generations(c.id)).slice(-1);
    expect(g.report).toMatchObject({ produced: 4, accepted: 1, rejected: 3, reasons: { prepare_not_signaled: 1, unknown_ground_ref: 1, over_limit: 1 } });
    expect(JSON.stringify(g.report)).not.toMatch(/factures|Cupra/);
    // BO « Exécutions & logs » : génération réussie, rejets visibles dans le résultat natif.
    const { getBusinessExecution } = await import('@/services/ai/business-execution/repository');
    const x = await getBusinessExecution(`T6F:${g.trace_id}`);
    expect(x).toMatchObject({ outcome: 'SUCCEEDED', native: { result: expect.stringMatching(/1 acceptée\(s\), 3 rejetée\(s\)/) } });
    // Rapport d'exécution T6 : ligne « questions » distincte.
    const [r] = await sql<Array<{ counters: Record<string, number> }>>`
      SELECT counters FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND counters ? 'suggestionsRejected' ORDER BY id DESC LIMIT 1`;
    expect(r.counters).toMatchObject({ suggestionsProduced: 4, suggestionsAccepted: 1, suggestionsRejected: 3 });
  });
});
