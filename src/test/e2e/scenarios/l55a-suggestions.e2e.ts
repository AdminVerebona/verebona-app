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
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';
import { dansJours, evaluerEcheance } from '../t6-assessment';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

type Compte = { id: number; ownerUserId: number };
type Q = { question: string; assetRef: string | null };

/** Modèle simulé : T6 piloté par le scénario ; T2 sans compréhension modèle. */
const modele = vi.hoisted(() => ({
  t6Prompts: [] as string[],
  questions: (_ctx: Record<string, unknown>): Q[] => [],
  t6Down: false,
}));

function provider() {
  return {
    name: 'simule-l55a',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      // Lot 61 : MODE=EVALUATE (pertinence des interpellations) — rien à signaler.
      if (/^MODE = EVALUATE$/m.test(input.prompt)) {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Array<{ subjectId: string }> };
        return {
          rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions: ctx.candidates.map((c) => ({
            subjectId: c.subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
            reason: 'Échéance connue et suivie dans l’agenda.', expectedAction: null, actionDeadline: null, suggestedReviewAt: null,
            priorityHint: null, evidenceRefs: [`${c.subjectId}.title`], uncertainties: [],
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
    (await import('@/services/home/mascot/t6-runner')).resetT6Breaker();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
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
      const assets = ctx.assets as Array<{ ref: string; name: string }>;
      return [
        { question: 'Quelle est ma prochaine échéance ?', assetRef: null },
        { question: `Quels sont les documents de ${assets[0].name} ?`, assetRef: assets[0].ref },
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
    expect(ctx.assets).toEqual([{ ref: 'A1', name: 'Cupra', hasDocuments: true, hasDeadlinesNext30Days: false }]);
    expect(ctx.nextDeadlines).toEqual([{ label: 'Contrôle technique', assetRef: 'A1', dateLabel: '18 avril 2028', dateNature: 'confirmée' }]);

    expect(questionsDe(p)).toEqual(['Quelle est ma prochaine échéance ?', 'Quels sont les documents de Cupra ?']);
    expect(questionsDe(p)).not.toContain('Que dois-je traiter en priorité ?');
    expect(homeSuggestions(p, false, []).map((x) => x.label)).toEqual(questionsDe(p));

    // Affichage suivant : même contexte → cache (aucun nouvel appel), mêmes questions, même empreinte.
    const d = await getMascotPresentation(c.id, 'display');
    expect(modele.t6Prompts).toHaveLength(1);
    expect(questionsDe(d)).toEqual(questionsDe(p));
    expect(d.contextHash).toBe(p.contextHash);
    const [cache] = await sql<{ s: unknown }[]>`SELECT suggestions AS s FROM home_mascot_cache WHERE account_id = ${c.id}`;
    expect(cache.s).toEqual([{ question: 'Quelle est ma prochaine échéance ?', assetRef: null }, { question: 'Quels sont les documents de Cupra ?', assetRef: 'A1' }]);
  });

  it('L55A-E2E-02 — questions cliquées : T2 les exécute comme aujourd’hui (bien revalidé, sources du compte, aucun repli)', async () => {
    const { c, cupra } = await compteDuTicket();
    modele.questions = () => [
      { question: 'Quelle est ma prochaine échéance ?', assetRef: null },
      { question: 'Quels sont les documents de Cupra ?', assetRef: 'A1' },
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
      ? [{ question: 'Quelle est ma prochaine échéance ?', assetRef: null }]
      : [{ question: 'Quels sont les documents de Cupra ?', assetRef: 'A1' }]);
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
    const { homeItems } = await import('@/services/home/mascot/bubble');
    expect(homeItems(p, false).length).toBeGreaterThan(0);
  });

  it('L55A-E2E-05 — isolation : contexte, cache et biens propres au compte ; référence inconnue écartée', async () => {
    const a = await compteDuTicket('Cupra');
    const b = await compteDuTicket('Twingo');
    modele.questions = () => [
      { question: 'Quels sont les documents de Cupra ?', assetRef: 'A1' },
      { question: 'Et le bien A2 ?', assetRef: 'A2' },
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
    const { homeItems } = await import('@/services/home/mascot/bubble');
    const { formatDateFr } = await import('@/services/home/mascot/signals');
    const carte = homeItems(p, false).find((x) => x.kind === 'subject');
    expect(carte).toMatchObject({ title: 'Contrôle technique', sub: `Cupra · Action à prévoir · ${formatDateFr(date)}`, cta: 'Voir' });
    expect(carte?.kind === 'subject' && carte.tile.paragraph.actions[0].target).toEqual({ kind: 'drawer', drawer: 'echeance', id: echeance, mode: 'view' });
  });
});
