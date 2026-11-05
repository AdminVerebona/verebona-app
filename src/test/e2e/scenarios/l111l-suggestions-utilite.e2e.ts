/**
 * Lot 111L — critère d'utilité réelle des suggestions, de bout en bout sur
 * PostgreSQL réel (vraie route GET /api/suggestions, revalidation du clic
 * comme POST /api/verebona/messages, assistant réel).
 *
 *   E01  CA01 — immobilier + une facture : plus de « Quels sont les documents
 *        de Maison ? » ; diagnostic BO : écartée (simple inventaire) ;
 *   E02  CA02 — véhicule (N documents), équipement (1 document), documents
 *        sans bien, export prêt : aucune liste proposée ;
 *   E03  CA03 / CA04 — échéance réelle : question proposée → clic → agenda →
 *        réponse utile ; source modifiée (bien renommé) puis retirée
 *        (échéance supprimée) : la suggestion suit ou disparaît ;
 *   E04  CA04 — questions d'inventaire posées LIBREMENT : pleinement
 *        fonctionnelles ; ancienne suggestion périmée : question libre ;
 *   E05  CA05 — moins de trois questions de qualité : moins de trois servies
 *        (quota tracé), jamais de remplissage ;
 *   E06  CA06 / CA08 — accueil = T2 (une seule route), changement de compte,
 *        Duo ; aucun appel IA à l'ouverture ni au rafraîchissement.
 *
 * Modèle SIMULÉ (aucun réseau), comme L108J.
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

type Item = { id: string; label: string; objective: string; source: string; assetId?: number };
type Compte = { id: number; ownerUserId: number };

function modeleSimule() {
  const calls: Array<{ task?: string }> = [];
  const provider = {
    name: 'simule',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      calls.push({ task: input.task });
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\bhelp_[A-Z0-9-]+__[a-z0-9-]+\b/g) ?? [])];
        return {
          rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered',
            claims: [{ text: 'Voici ce que dit l’article.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }] }),
          inputTokens: 1200, outputTokens: 80,
        };
      }
      if (input.task === 'UNDERSTAND') {
        return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 300, outputTokens: 20 };
      }
      throw new Error(`[simulé] tâche inattendue ${input.task}`);
    },
  };
  return { calls, provider };
}

const NON_REPONSE = /semblent liés|Résultats proches|Je n’ai rien trouvé|ne peux pas répondre de façon fiable|pas trouvé dans le Centre d’aide|Je ne sais pas|une erreur/i;
/** Une suggestion qui ne fait que lister (quel que soit le libellé exact). */
const INVENTAIRE_IDS = ['acc_home_asset_docs', 'acc_docs_unlinked', 'acc_state_exports'];

scenario('L111L-UTIL', 'Lot 111L — suggestions : utilité réelle avant publication', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let sim: ReturnType<typeof modeleSimule>;
  let J = '';
  const FIX = join(__dirname, '../fixtures');
  let resourcesSnapshot: unknown;
  let helpSnapshot: unknown;

  beforeAll(async () => {
    helpSnapshot = JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8'));
    resourcesSnapshot = JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8'));
    sim = modeleSimule();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(sim.provider as never);
    J = (await import('@/services/verebona-assistant/core/query-period')).aujourdhuiParis();
  });
  beforeEach(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.setHelpCorpusForTests(hc.parseHelpCorpus(helpSnapshot));
    const rc = await import('@/services/verebona-assistant/core/resources-corpus.service');
    rc.setResourcesCorpusForTests(rc.parseResourcesCorpus(resourcesSnapshot));
    (await import('@/services/suggestions/shared/service')).resetSharedSuggestionsCache();
    sim.calls.length = 0;
  });

  const dans = (n: number) => { const [a, m, d] = J.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };
  const compte = async (plan: 'premium' | 'premium_duo' = 'premium'): Promise<Compte> => { const a = await make.account({ plan }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string, category = 'VEHICULE') => {
    const a = await make.asset(c as never, { name, category });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${a.id}`;
    return a.id;
  };
  const fichier = async (c: Compte, assetId: number | null, titre: string, etat = 'ANALYZED') => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, analysis_state = ${etat}, user_id = ${c.ownerUserId} WHERE id = ${f.id}`;
    return f.id;
  };
  const echeance = async (c: Compte, assetId: number, title: string, date: string) => {
    const i = await make.agendaItem(c as never, { title, startDate: date, assetIds: [assetId] });
    await sql`UPDATE agenda_items SET event_nature = 'DEADLINE', manual_status = NULL WHERE id = ${i.id}`;
    return i.id;
  };
  const affichees = async (c: Compte, userId = c.ownerUserId): Promise<{ version: string; items: Item[]; reserve: Item[] }> => {
    session.currentAccountId = c.id; session.userId = userId;
    const { GET } = await import('@/app/api/suggestions/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://x/api/suggestions'));
    expect(res.status).toBe(200);
    return res.json();
  };
  const diagnostic = async (c: Compte, userId = c.ownerUserId) => (await (await import('@/services/suggestions/shared/service')).getSharedSuggestions(c.id, userId)).diagnostic;
  const tout = (s: { items: Item[]; reserve: Item[] }) => [...s.items, ...s.reserve];
  const sansInventaire = (s: { items: Item[]; reserve: Item[] }) => {
    for (const x of tout(s)) {
      expect(INVENTAIRE_IDS, x.label).not.toContain(x.id);
      expect(x.label).not.toMatch(/^Quels (sont les )?documents (de |d’|concernent|ne sont)|exports sont disponibles/);
    }
  };
  const verifierReponse = (r: Awaited<ReturnType<typeof demander>>, intent: string, types: string[]) => {
    expect(r.route?.intent).toBe(intent);
    expect(r.clarification ?? null).toBeNull();
    expect(String(r.answer ?? '')).not.toMatch(NON_REPONSE);
    const t = [...new Set((r.sources ?? []).map((x: { type: string }) => x.type))];
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) expect(types).toContain(x);
  };

  it('L111L-E2E-01 — CA01 : immobilier + une facture → plus de « Quels sont les documents de Maison ? » ; écartée et tracée au BO', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await fichier(c, maison, 'Facture plombier');
    const s = await affichees(c);
    sansInventaire(s);
    expect(s.items.length).toBeGreaterThan(0);
    const d = await diagnostic(c);
    expect(d.notUseful).toContainEqual({ id: 'acc_home_asset_docs', decision: 'INVENTORY_DECLARED' });
    expect(d.quota).toMatchObject({ max: 3, served: s.items.length });
    // Aucune génération IA à l'ouverture.
    expect(sim.calls).toEqual([]);
  });

  it('L111L-E2E-02 — CA02 : véhicule (N documents), équipement (1 document), documents sans bien, export prêt → aucune liste proposée', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    for (let i = 0; i < 7; i += 1) await fichier(c, cupra, `Facture entretien ${i + 1}`);
    const lave = await bien(c, 'Lave-linge', 'OBJET');
    await fichier(c, lave, 'Notice lave-linge');
    await fichier(c, null, 'Contrat assurance habitation');
    await sql`INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status) VALUES (${cupra}, ${c.id}, ${c.ownerUserId}, 'DOSSIER_COMPLET', 'ready')`;
    const s = await affichees(c);
    sansInventaire(s);
    expect(s.items).toHaveLength(3);
    expect(s.items.every((x) => x.objective === 'GUIDE')).toBe(true);
    const d = await diagnostic(c);
    const ecartees = (d.notUseful ?? []).map((x) => x.id).sort();
    expect(ecartees).toEqual(expect.arrayContaining(['acc_docs_unlinked', 'acc_home_asset_docs', 'acc_state_exports']));
  });

  it('L111L-E2E-03 — CA03/CA04 : échéance réelle → question concrète → clic → agenda → réponse ; source modifiée puis retirée', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    await fichier(c, cupra, 'Facture achat');
    const ct = await echeance(c, cupra, 'Contrôle technique', dans(25));
    const a = await affichees(c);
    sansInventaire(a);
    const anticipe = a.items.find((x) => x.objective === 'ANTICIPATE');
    expect(anticipe, a.items.map((x) => x.label).join(' | ')).toBeDefined();
    const { resolveSuggestionForMessage } = await import('@/services/suggestions/shared/service');
    const v = await resolveSuggestionForMessage(c.id, c.ownerUserId, anticipe!.id, anticipe!.label, a.version);
    expect(v).not.toBeNull();
    const r = await demander(c, anticipe!.label, { suggestion: v!.suggestion, pageContext: { route: '/accueil', platform: 'web', ...(v!.assetId ? { assetId: String(v!.assetId) } : {}) } });
    verifierReponse(r, 'ACCOUNT_SEARCH_AGENDA', ['agenda_item']);
    expect(String(r.answer)).toMatch(/Contrôle technique/);

    // Source MODIFIÉE : bien renommé — la question suit le nouveau nom ; l'ancien libellé n'est plus revalidé.
    await sql`UPDATE assets SET name = 'Cupra Born' WHERE id = ${cupra}`;
    const b = await affichees(c);
    expect(b.version).not.toBe(a.version);
    if (anticipe!.label.includes('Cupra')) {
      expect(await resolveSuggestionForMessage(c.id, c.ownerUserId, anticipe!.id, anticipe!.label, a.version)).toBeNull();
    }
    // Source RETIRÉE : plus aucune échéance — plus aucune question d'échéance, et toujours aucune liste.
    await sql`DELETE FROM agenda_items WHERE id = ${ct}`;
    const z = await affichees(c);
    expect(tout(z).some((x) => x.objective === 'ANTICIPATE')).toBe(false);
    sansInventaire(z);
  });

  it('L111L-E2E-04 — CA04 : les questions d’inventaire posées LIBREMENT restent pleinement fonctionnelles ; une suggestion périmée part en question libre', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    await fichier(c, cupra, 'Facture entretien garage');
    await fichier(c, cupra, 'Carte grise Cupra');
    for (const q of ['Quels sont les documents de Cupra ?', 'Quels documents concernent ma Cupra ?']) {
      const r = await demander(c, q, { pageContext: { route: '/accueil', platform: 'web' } });
      verifierReponse(r, 'ACCOUNT_SEARCH_DOCUMENT', ['document']);
      expect((r.sources ?? []).length).toBeGreaterThanOrEqual(2);
    }
    // Sélection affichée AVANT le déploiement (onglet resté ouvert) : la référence
    // n'est plus revalidée — aucun privilège, la question reste posée et répondue.
    const { resolveSuggestionForMessage } = await import('@/services/suggestions/shared/service');
    expect(await resolveSuggestionForMessage(c.id, c.ownerUserId, 'acc_home_asset_docs', 'Quels sont les documents de Cupra ?', 'version-lot110')).toBeNull();
    expect((await sql`SELECT count(*)::int AS n FROM shared_suggestion_consultations WHERE account_id = ${c.id}`)[0].n).toBe(0);
  });

  it('L111L-E2E-05 — CA05 : moins de trois questions de qualité → moins de trois servies (quota tracé), jamais de remplissage', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    for (let i = 0; i < 6; i += 1) await fichier(c, cupra, `Facture ${i + 1}`);
    await sql`INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status) VALUES (${cupra}, ${c.id}, ${c.ownerUserId}, 'DOSSIER_COMPLET', 'ready')`;
    // Ressources indisponibles ; Centre d'aide publié SANS deux des articles de l'étape « établie ».
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    const rc = await import('@/services/verebona-assistant/core/resources-corpus.service');
    const help = hc.parseHelpCorpus(helpSnapshot)!;
    hc.setHelpCorpusForTests({ ...help, version: 'v-111l-partiel', articles: help.articles.filter((x) => !['AID-AGENDA-006', 'AID-TRANSFER-002'].includes(x.id)) });
    rc.setResourcesCorpusForTests(null);
    (await import('@/services/suggestions/shared/service')).resetSharedSuggestionsCache();
    const s = await affichees(c);
    sansInventaire(s);
    expect(s.items.length, s.items.map((x) => x.id).join(', ')).toBeLessThan(3);
    expect(s.items.length).toBeGreaterThan(0);
    expect(s.items.every((x) => x.objective === 'GUIDE' && x.source === 'HELP_CENTER')).toBe(true);
    const d = await diagnostic(c);
    expect(d.quota).toEqual({ max: 3, served: s.items.length, shortfall: 'QUALITY_LIMIT' });
    expect(d.helpCorpus.available).toBe(true);
    expect(d.unverified).toEqual([]);
  });

  it('L111L-E2E-06 — CA06/CA08 : une seule source accueil/T2, changement de compte, Duo ; aucun appel IA à l’ouverture ni au rafraîchissement', async () => {
    const c = await compte('premium_duo');
    const cupra = await bien(c, 'Cupra');
    await fichier(c, cupra, 'Facture achat');
    await echeance(c, cupra, 'Révision annuelle', dans(15));
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;
    const a1 = await affichees(c);
    const a2 = await affichees(c);
    expect(a2.version).toBe(a1.version);
    expect(a2.items.map((x) => x.id)).toEqual(a1.items.map((x) => x.id));
    const m = await affichees(c, membre.id);
    const perso = (l: Item[]) => l.filter((x) => x.objective !== 'GUIDE').map((x) => `${x.id}:${x.label}`);
    expect(perso(m.items)).toEqual(perso(a1.items));
    sansInventaire(a1); sansInventaire(m);
    const autre = await compte();
    const z = await affichees(autre);
    expect(tout(z).some((x) => x.label.includes('Cupra'))).toBe(false);
    expect(z.version).not.toBe(a1.version);
    expect(sim.calls).toEqual([]);
  });
});
