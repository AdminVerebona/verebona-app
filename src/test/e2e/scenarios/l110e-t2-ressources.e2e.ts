/**
 * Lot 110E — T2 : réponses issues des Ressources, couverture effective des
 * suggestions, journal BO « Questions sans réponse », de bout en bout sur
 * PostgreSQL réel (CA01–CA11).
 *
 *   suggestion (stock) → clic revalidé côté serveur (`resolveSuggestionForMessage`,
 *   comme la route POST /api/verebona/messages) → T2 réel (ports réels,
 *   persistance de la trace) → réponse, citations, « Lire la Ressource »
 *   → journal BO lu dans les traces.
 *
 * Corpus : instantanés publiés (Centre d'aide ; Ressources = tag `pub108p`).
 * Modèle SIMULÉ (aucun réseau) : UNDERSTAND ne comprend rien ; ANSWER cite la
 * première source. Les réponses Ressources attendues sont déterministes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };
type Reponse = Awaited<ReturnType<typeof demander>>;
type ResArticle = { id: string; revision: number; sections: Array<{ anchor: string; heading: string; text: string }> };

function modeleSimule() {
  const calls: Array<{ task?: string }> = [];
  const provider = {
    name: 'simule',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      calls.push({ task: input.task });
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\bhelp_[A-Z0-9-]+__[a-z0-9-]+\b/g) ?? [])];
        return { rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered',
          claims: [{ text: 'Voici ce que dit l’article.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }] }), inputTokens: 1200, outputTokens: 80 };
      }
      if (input.task === 'UNDERSTAND') {
        return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 300, outputTokens: 20 };
      }
      throw new Error(`[simulé] tâche inattendue ${input.task}`);
    },
  };
  return { calls, provider };
}

const QUESTION = 'Quand faire la révision d’une voiture ?';
const E03_PATH = '/ressources/quand-faire-revision-voiture';

scenario('L110E-T2RES', 'Lot 110E — T2 : réponses issues des Ressources, couverture des suggestions, journal BO', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let sim: ReturnType<typeof modeleSimule>;
  const FIX = join(__dirname, '../fixtures');
  let snapshot: { version: string; articles: ResArticle[] } & Record<string, unknown>;

  beforeAll(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    const help = hc.parseHelpCorpus(JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8')));
    if (!help) throw new Error('instantané du Centre d’aide illisible');
    hc.setHelpCorpusForTests(help);
    snapshot = JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8'));
    sim = modeleSimule();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(sim.provider as never);
  });
  const corpus = async (c: unknown) => {
    const rc = await import('@/services/verebona-assistant/core/resources-corpus.service');
    rc.setResourcesCorpusForTests(c == null ? null : rc.parseResourcesCorpus(c));
    (await import('@/services/suggestions/shared/service')).resetSharedSuggestionsCache();
    (await import('@/services/suggestions/shared/resource-questions')).resetResourceEvidenceMemo();
    (await import('@/services/suggestions/shared/answerability')).resetAnswerabilityMemo();
  };
  beforeEach(async () => { await corpus(snapshot); sim.calls.length = 0; });

  const variante = (id: string, f: (a: ResArticle) => ResArticle | null, version: string) => ({
    ...snapshot, version, articles: snapshot.articles.map((a) => (a.id === id ? f(a) : a)).filter(Boolean),
  });
  const compte = async (plan: 'standard' | 'premium' | 'premium_duo' = 'premium'): Promise<Compte> => { const a = await make.account({ plan }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  /** Compte établi (guide « Découvrir » : Ressources). */
  const etabli = async (plan: 'premium' | 'premium_duo' = 'premium') => {
    const c = await compte(plan);
    const a = await make.asset(c as never, { name: 'Cupra', category: 'VEHICULE' });
    for (let i = 0; i < 6; i += 1) {
      const f = await make.assetFile(c as never, { assetId: a.id });
      await sql`UPDATE asset_files SET retained_title = ${`Facture ${i + 1}`}, analysis_state = 'ANALYZED', user_id = ${c.ownerUserId} WHERE id = ${f.id}`;
    }
    return c;
  };
  /** Clic : même enchaînement que POST /api/verebona/messages. */
  const cliquer = async (c: Compte, id: string, label: string, userId = c.ownerUserId) => {
    const { resolveSuggestionForMessage } = await import('@/services/suggestions/shared/service');
    const v = await resolveSuggestionForMessage(c.id, userId, id, label, null);
    expect(v, `${id} revalidée`).not.toBeNull();
    return { v: v!, r: await demander({ id: c.id, ownerUserId: userId }, label, { suggestion: v!.suggestion, pageContext: { route: '/accueil', platform: 'web' } }) };
  };
  const ids = (r: Reponse) => (r.sources ?? []).map((s: { id: string }) => s.id);
  const lien = (r: Reponse) => (r.actions ?? []).find((x: { type: string }) => x.type === 'OPEN_HELP') as { href?: string; label?: string } | undefined;
  const traceDe = async (c: Compte) => (await sql`SELECT retrieval_methods_json AS t, intent FROM verebona_request_runs WHERE account_id = ${c.id} ORDER BY id DESC LIMIT 1`)[0] as { t: Record<string, any>; intent: string };

  it('CA01-CA03 — clic « Quand faire la révision d’une voiture ? » : E03 (périodicité) en source prioritaire revalidée, réponse directe, citations exactes, « Lire la Ressource » en complément', async () => {
    const c = await etabli();
    const { v, r } = await cliquer(c, 'res_car_service', QUESTION);
    // Référence canonique retrouvée CÔTÉ SERVEUR depuis l'identifiant, revalidée sur le corpus servi.
    expect(v.suggestion.evidence).toMatchObject({ status: 'VERIFIED', articleId: 'RES-E03', revision: 2, corpusVersion: snapshot.version });
    expect(r.route?.intent).toBe('PRODUCT_HELP_EXPLAIN');
    const texte = String(r.answer);
    expect(texte).toMatch(/^La prochaine révision de votre voiture ne se déduit pas d’une règle unique/);
    expect(texte).toMatch(/programme du constructeur/);
    expect(texte).toMatch(/premier seuil atteint/);
    expect(texte).toMatch(/À noter : /);
    expect(texte).not.toMatch(/Combien coûte|additionnez|procédure complète|Voir aussi/i);
    // Citations : passages E03 réellement utilisés, jamais C01.
    expect(ids(r).length).toBeGreaterThan(0);
    expect(ids(r).every((x: string) => x.startsWith('help_RES-E03__'))).toBe(true);
    expect(lien(r)).toMatchObject({ label: 'Lire la Ressource', href: E03_PATH });
    // Déterministe : aucun appel ANSWER.
    expect(sim.calls.filter((x) => x.task === 'ANSWER')).toHaveLength(0);
    // Trace T2 persistée : origine, preuve, sélection, issue — sans texte d'article.
    const t = (await traceDe(c)).t;
    expect(t.resources).toMatchObject({ origin: 'SUGGESTION', suggestionId: 'res_car_service', selection: 'EVIDENCE', outcome: 'ANSWERED', selected: { articleId: 'RES-E03' } });
    expect(JSON.stringify(t.resources)).not.toMatch(/La prochaine révision de votre voiture/);
    expect(t.resources.examined.find((x: { id: string }) => x.id === 'help_RES-C01__presentation')).toMatchObject({ kept: false, reason: 'KIND_MISMATCH' });
  });

  it('CA05 — question LIBRE : Ressources pour un sujet documentaire, compte pour un fait personnel, Centre d’aide pour l’usage de Verebona', async () => {
    const c = await etabli();
    const libre = await demander(c, QUESTION);
    expect(libre.route?.intent).toBe('PRODUCT_HELP_EXPLAIN');
    expect(ids(libre)[0]).toMatch(/^help_RES-E03__/);
    expect(lien(libre)?.href).toBe(E03_PATH);
    expect((await traceDe(c)).t.resources).toMatchObject({ origin: 'FREE', routing: { decision: 'RESOURCES', previousIntent: 'ACCOUNT_SEARCH_AGENDA' } });

    const voisin = await demander(c, 'Quand passer le contrôle technique d’une voiture ?');
    expect(ids(voisin)[0]).toMatch(/^help_RES-E01__/);

    const perso = await demander(c, 'Quand faire la révision de ma voiture ?');
    expect(perso.route?.intent).not.toMatch(/^PRODUCT_HELP_/);
    expect(ids(perso).some((x: string) => x.startsWith('help_RES-'))).toBe(false);

    const aide = await demander(c, 'Comment ajouter un document ?');
    expect(aide.route?.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(ids(aide)[0]).toMatch(/^help_AID-/);
  });

  it('CA04 — suggestions : seules les questions couvertes ; article retiré ou modifié → retirée, jamais d’écran vide, aucune IA à l’affichage (CA11)', async () => {
    const c = await etabli();
    const svc = await import('@/services/suggestions/shared/service');
    const ok = await svc.getSharedSuggestions(c.id, c.ownerUserId);
    expect(ok.selection.items).toHaveLength(3);
    expect(ok.diagnostic.resourceCoverage?.every((x) => x.status === 'VERIFIED')).toBe(true);

    await corpus(variante('E03', () => null, 'v-retrait'));
    const sans = await svc.getSharedSuggestions(c.id, c.ownerUserId);
    expect(sans.selection.items).toHaveLength(3);
    expect([...sans.selection.items, ...sans.selection.reserve].map((x) => x.id)).not.toContain('res_car_service');
    expect(sans.diagnostic.notAnswerable).toContain('res_car_service');
    expect(sans.diagnostic.resourceCoverage?.find((x) => x.id === 'res_car_service')?.status).toBe('ARTICLE_MISSING');

    await corpus(variante('E03', (a) => ({ ...a, revision: 3, sections: a.sections.map((s) => (s.anchor === 'rechercher-le-bon-programme-constructeur' ? { ...s, text: 'Relevez le modèle précis.' } : s)) }), 'v-maj'));
    const maj = await svc.getSharedSuggestions(c.id, c.ownerUserId);
    expect([...maj.selection.items, ...maj.selection.reserve].map((x) => x.id)).not.toContain('res_car_service');
    expect(maj.diagnostic.resourceCoverage?.find((x) => x.id === 'res_car_service')).toMatchObject({ status: 'PARTIAL', revision: 3, revisionChanged: true });
    expect(sim.calls).toEqual([]);
  });

  it('CA03/CA07 — ancienne suggestion cliquée après retrait / mise à jour / panne : aucune réponse forcée ni faux lien ; partiel dit le manque', async () => {
    const c = await etabli();
    // Mise à jour qui retire le seuil : réponse partielle explicite.
    await corpus(variante('E03', (a) => ({ ...a, revision: 3, sections: a.sections.map((s) => (s.anchor === 'rechercher-le-bon-programme-constructeur' ? { ...s, text: 'Relevez le modèle précis.' } : s)) }), 'v-maj'));
    const partiel = await cliquer(c, 'res_car_service', QUESTION);
    expect(partiel.v.suggestion.evidence?.status).toBe('PARTIAL');
    expect(String(partiel.r.answer)).toMatch(/Les Ressources publiées ne précisent pas le seuil qui déclenche la révision/);
    expect((await traceDe(c)).t.resources).toMatchObject({ outcome: 'PARTIAL', motive: 'PARTIAL_COVERAGE' });

    // Article retiré : E03 n'est plus cité ; C01 (coût) ne le remplace jamais.
    await corpus(variante('E03', () => null, 'v-retrait'));
    const retrait = await cliquer(c, 'res_car_service', QUESTION);
    expect(ids(retrait.r).some((x: string) => /RES-(E03|C01)__/.test(x))).toBe(false);
    expect(lien(retrait.r)?.href ?? '').not.toBe(E03_PATH);

    // Corpus Ressources indisponible : repli explicite, motif juste, aucune source.
    await corpus(null);
    const panne = await cliquer(c, 'res_car_service', QUESTION);
    expect(String(panne.r.answer)).toMatch(/Ressources Verebona sont momentanément indisponibles/);
    expect(ids(panne.r)).toEqual([]);
    expect((await traceDe(c)).t.resources).toMatchObject({ motive: 'CORPUS_UNAVAILABLE', outcome: 'FALLBACK' });
  });

  it('CA06/CA10 — Duo et isolation : même réponse pour le second membre, traces bornées à leur compte, aucune donnée d’un autre compte', async () => {
    const c = await etabli('premium_duo');
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;
    const a = await cliquer(c, 'res_car_service', QUESTION, membre.id);
    expect(ids(a.r).every((x: string) => x.startsWith('help_RES-E03__'))).toBe(true);
    const autre = await compte();
    const b = await cliquer(autre, 'res_car_service', QUESTION);
    expect(b.r.answer).toBe(a.r.answer);
    // Sources : Ressources publiées seulement (jamais un document, un bien ou une échéance du compte).
    expect((a.r.sources ?? []).every((s: { type: string }) => s.type === 'help_entry')).toBe(true);
    const runs = await sql`SELECT account_id, user_id FROM verebona_request_runs WHERE account_id IN (${c.id}, ${autre.id}) ORDER BY id`;
    expect(runs.map((x) => x.account_id)).toEqual([c.id, autre.id]);
    expect(runs[0].user_id).toBe(membre.id);
  });

  it('CA08/CA09 — journal BO : occurrences lues dans les traces, motifs distincts, regroupement, statuts, rétention, sans compte ni texte d’article', async () => {
    const c = await etabli();
    await corpus(null);
    await cliquer(c, 'res_car_service', QUESTION);
    await cliquer(c, 'res_car_service', QUESTION);
    await corpus(snapshot);
    await demander(c, 'Quand repeindre une clôture en bois ?');
    const j = await import('@/services/verebona-assistant/core/unanswered-journal');
    const avant = await sql`SELECT count(*)::int AS n FROM verebona_request_runs`;
    const journal = await j.listUnansweredJournal({ days: 1 });
    // Lecture seule : aucune ligne de trace écrite par le journal.
    expect((await sql`SELECT count(*)::int AS n FROM verebona_request_runs`)[0].n).toBe(avant[0].n);
    const panne = journal.groups.find((g) => g.question === QUESTION && g.motives.some((m) => m.motive === 'CORPUS_UNAVAILABLE'));
    expect(panne, JSON.stringify(journal.groups.map((g) => [g.question, g.motives]))).toBeTruthy();
    expect(panne!.count).toBeGreaterThanOrEqual(2);
    expect(panne!.origins).toContain('SUGGESTION');
    expect(panne!.occurrences[0]).toMatchObject({ corpus: 'RESOURCES', suggestionId: 'res_car_service' });
    expect(panne!.occurrences[0].requestId).toMatch(/\S/);
    const s = JSON.stringify(journal);
    expect(s).not.toMatch(/"accountId"|"userId"|La prochaine révision de votre voiture/);
    // Filtres et statut.
    expect((await j.listUnansweredJournal({ days: 1, motive: 'CORPUS_UNAVAILABLE' })).groups.every((g) => g.motives.some((m) => m.motive === 'CORPUS_UNAVAILABLE'))).toBe(true);
    expect(await j.setReviewStatus({ groupKey: panne!.groupKey, status: 'TO_FIX', note: 'Corpus à republier — contact jean.dupont@example.com', adminUserId: 1 })).toBe(true);
    const apres = await j.listUnansweredJournal({ days: 1, status: 'TO_FIX' });
    expect(apres.groups.map((g) => g.groupKey)).toContain(panne!.groupKey);
    expect(JSON.stringify(apres)).not.toMatch(/jean\.dupont/);
    expect(await j.setReviewStatus({ groupKey: 'pas-une-cle', status: 'RESOLVED', adminUserId: 1 })).toBe(false);
    // Rétention : la fenêtre ne dépasse jamais la durée de l'historique ; purge des décisions anciennes.
    expect((await j.listUnansweredJournal({ days: 9999 })).days).toBe(await j.journalRetentionDays());
    await sql`UPDATE t2_unanswered_reviews SET updated_at = now() - interval '400 days' WHERE group_key = ${panne!.groupKey}`;
    const { purgeAssistantData } = await import('@/services/ai/assistant/retention/purge-assistant-logs.job');
    const rapport = await purgeAssistantData();
    expect(rapport.unansweredReviewsDeleted).toBeGreaterThanOrEqual(1);
  });
});
