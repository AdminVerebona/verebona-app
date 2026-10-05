/**
 * Lot 15 (Y), seconde passe — branche master de la compréhension (§24,
 * A3–A5), chronologie structurée transmise au client (T2-35), budget
 * d'événements dans `assistant-config` (T2-34), valeur canonique présentée à
 * la confirmation d'une commande (T2-40), sources synthétiques acceptées par
 * la vérification des affirmations de Z (T2-31).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const comprendre = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/services/ai/assistant/master/t2-understand', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  understandWithT2Master: (...a: unknown[]) => comprendre.fn(...a),
}));
const etatCommande = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/services/verebona-assistant/canonical/commands', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  commandAssetState: (...a: unknown[]) => etatCommande.fn(...a),
}));

const { classifyAssistantIntent } = await import('../classification.adapter');
const { mergeUnderstandingFilters, analyserRequeteCanonique } = await import('../retrieval.service');
const T = await import('../target-answer');
const S = await import('../synthesis-planner');
const { targetsFromInput } = await import('../assistant-targets');
const { runAssistant } = await import('../assistant-orchestrator.service');
const { toApiPayload } = await import('../api-payload');
const { resetAssistantConfigForTests, loadAssistantConfig } = await import('../../config/assistant-config');
const { sqlLookup } = await import('../../commands/plan.service');
const { verifyClaimSupport } = await import('@/services/ai/assistant/claim-support');
const { T2_ENTITY_TYPES } = await import('@/services/ai/assistant/master/t2-contract');
const { toT2Understanding } = await vi.importActual<typeof import('@/services/ai/assistant/master/t2-understand')>('@/services/ai/assistant/master/t2-understand');
const { timelineRows } = await import('@/lib/verebona/space');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;
type Src = import('../../types/sources').RetrievedSource;

const ENV = { ...process.env };
beforeEach(() => { comprendre.fn.mockReset(); etatCommande.fn.mockReset(); });
afterEach(() => { process.env = { ...ENV }; resetAssistantConfigForTests(); });
const input = (message: string, extra: Record<string, unknown> = {}) =>
  ({ accountId: 1, userId: 2, planType: 'PREMIUM', message, clientRequestId: 'c', ...extra }) as never;

describe('1. branche master de la compréhension (classification.adapter)', () => {
  it('master : t2_understand puis toIntentRoute ; faits demandés et filtres portés par la route', async () => {
    comprendre.fn.mockResolvedValue({
      plan: { intent: 'ACCOUNT_SEARCH_DOCUMENT', confidence: 'probable', entityHints: [{ type: 'period', value: 'en 2024' }, { type: 'asset', value: 'la Clio' }], reason: 'r' },
      requestedFacts: [], requestedTopics: [], events: [],
      filters: { documentType: 'facture', unlinked: true, periodStart: '2024-01-01', periodEnd: '2024-12-31' },
    });
    const r = await classifyAssistantIntent('mes factures pas rangées de l’an dernier', input('x'));
    expect(comprendre.fn).toHaveBeenCalledOnce();
    expect(r).toMatchObject({
      intent: 'ACCOUNT_SEARCH_DOCUMENT', clarificationRequired: false,
      understanding: { requestedFacts: [], filters: { unlinked: true, documentType: 'facture' } },
    });
    expect(r!.entityHints).toEqual([{ type: 'period', value: 'en 2024' }, { type: 'asset', value: 'la Clio' }]);
    // Droits du registre, jamais du modèle.
    expect(r!.allowedActionTypes.length).toBeGreaterThan(0);
  });

  it('indices du modèle : filtrés (« page: », 10 au plus) — lecture canonique seule (lot 16b-2)', async () => {
    const { toIntentRoute } = await import('../classification.adapter');
    const hints = [{ type: 'asset' as const, value: 'page:5' }, ...Array.from({ length: 11 }, (_, i) => ({ type: 'asset' as const, value: `Bien ${i}` }))];
    const plan = { intent: 'ACCOUNT_SEARCH_ASSET', confidence: 'probable' as const, entityHints: hints, reason: '' };
    const r = toIntentRoute(plan, 'PREMIUM').entityHints;
    expect(r).toHaveLength(10);
    expect(r.some((h) => h.value.startsWith('page:'))).toBe(false);
  });

  it('master indisponible → null (intention inconnue) ; version ancienne en « steps » : master quand même', async () => {
    comprendre.fn.mockResolvedValue(null);
    expect(await classifyAssistantIntent('x', input('x'))).toBeNull();
    comprendre.fn.mockClear();
    await classifyAssistantIntent('x', input('x'));
    expect(comprendre.fn).toHaveBeenCalledOnce();
  });

  it('prompt de Z : indices `period` admis, noms littéraux (A3), jamais « page: »', () => {
    expect(T2_ENTITY_TYPES).toContain('period');
    const prompt = readFileSync(join(process.cwd(), 'src/services/ai/prompts/assistant/t2_master_v1.txt'), 'utf8');
    expect(prompt).toMatch(/A3 — `entityHints` recopie les désignations littérales/);
    expect(prompt).toMatch(/ne crée jamais d’identifiant/);
    const u = toT2Understanding({
      mode: 'UNDERSTAND', intent: 'ACCOUNT_TIMELINE', confidence: 'exact', reason: '',
      entityHints: [{ type: 'period', value: 'en 2024' }, { type: 'asset', value: 'page:5' }, { type: 'equipment', value: 'la chaudière' }],
      requestedFacts: ['mileage', 'inconnu'], requestedTopics: [], filters: {},
    });
    expect(u.plan.entityHints).toEqual([{ type: 'period', value: 'en 2024' }, { type: 'asset', value: 'la chaudière' }]);
    expect(u.requestedFacts).toEqual(['mileage']);
  });

  it('filtres du master ajoutés à ceux de la question (la question prime)', () => {
    const base = analyserRequeteCanonique('Retrouve mes documents', '2026-09-30');
    const m = mergeUnderstandingFilters(base, {
      requestedFacts: [],
      filters: { documentType: 'WORKS_QUOTE', unlinked: true, status: 'en cours d’analyse', supplier: 'Norauto', periodStart: '2024-01-01', periodEnd: '2024-12-31' },
    });
    expect(m.documentFilters).toEqual({ link: 'unlinked', analysis: ['IN_ANALYSIS'], supplierName: 'norauto' });
    expect(m.documentTypeCodes).toEqual(expect.arrayContaining(['WORKS_QUOTE', 'DEVIS']));
    expect(m.period).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    const mot = mergeUnderstandingFilters(base, { requestedFacts: [], filters: { documentType: 'facture' } });
    expect(mot.documentTypes).toEqual(['facture']);
    // La question prime : « devis » dans la question, « facture » du modèle ignoré.
    const q = mergeUnderstandingFilters(analyserRequeteCanonique('Retrouve un devis', '2026-09-30'), { requestedFacts: [], filters: { documentType: 'facture' } });
    expect(q.documentTypes).toEqual(['devis']);
    expect(mergeUnderstandingFilters(base, undefined).documentTypeCodes).toEqual([]);
  });

  it('fait demandé (A4) sur UN bien ciblé → lu sur la fiche canonique', async () => {
    const field = vi.fn(async () => ({
      assetId: 3, assetName: 'Clio', key: 'mileage', label: 'Kilométrage', value: 45000, display: '45 000 km', origin: 'USER',
      originLabel: 'saisie par vous', updatedAt: null, from: 'key', evidence: null, openConflict: null, sensitive: false,
    }) as never);
    const readers = { document: vi.fn(), agenda: vi.fn(), field, today: () => '2026-09-30' };
    const t = targetsFromInput({ pageContext: { assetId: '3' } });
    const a = await T.answerFromTarget(1, 'combien de km a fait la voiture', t, readers, { requestedFacts: ['mileage'], filters: {} });
    expect(field).toHaveBeenCalledWith(1, 3, 'mileage');
    expect(a).toMatchObject({ strategy: 'target.asset_field', intent: 'ACCOUNT_FACT_ASSET' });
    expect(a!.text).toContain('45 000 km');
    expect(a!.sources[0].id).toBe('asset_field:3:mileage');
    // Deux faits, ou aucun bien : pas de lecture ciblée.
    expect(await T.answerFromTarget(1, 'x', targetsFromInput({}), readers, { requestedFacts: ['mileage'], filters: {} })).toBeNull();
  });
});

const CHUNK: Src = {
  id: 'timeline:asset_1:1', type: 'agenda_item', title: 'Chronologie', relevanceScore: 1,
  content: ['2021-05-25 · Achat (Clio) [asset_field:1:acquisitionDate]', '2024-03-02 · Vidange (Clio) — réalisé [agenda_12]', '2024-03-02 · Document « Facture garage » (Clio) [doc_7]'].join('\n'),
};

describe('2. chronologie structurée (events[]) jusqu’au client', () => {
  it('liens résolus côté serveur à partir des lignes compactes ; jamais un identifiant non fourni', () => {
    const ev = S.clientTimelineEvents([
      { date: '2024-03-02', text: 'Vidange réalisée', sourceIds: ['timeline:asset_1:1'] },
      { date: '2024-03-02', text: 'Facture du garage', sourceIds: ['timeline:asset_1:1'] },
      { date: '2021-05-25', text: 'Achat de la Clio', sourceIds: ['timeline:asset_1:1'] },
      { date: '2020-01-01', text: 'Inconnu', sourceIds: ['agenda_99'] },
    ], [CHUNK]);
    expect(ev.map((e) => e.ref)).toEqual(['agenda_12', 'doc_7', 'asset_field:1:acquisitionDate', null]);
    expect(ev[0].href).toMatch(/agenda/);
    expect(ev[1].href).toMatch(/document/);
    expect(ev[3].href).toBeNull();
  });

  it('orchestrateur : gen.events → résultat → API (sans identifiant interne) ; repli planifié aussi', async () => {
    const plan = {
      kind: 'timeline' as const, assets: [{ id: 1, name: 'Clio' }], budget: { sources: 8, events: 60 }, sources: [CHUNK],
      timeline: { events: [{ date: '2024-03-02', label: 'Vidange', kind: 'agenda' as const, ref: 'agenda_12', assetName: 'Clio', detail: 'réalisé' }], totalEvents: 1, truncated: false },
    };
    const ports: Ports = {
      retrieve: vi.fn(async () => []),
      resolveSources: async (s) => s.map((x) => ({ id: x.id, type: x.type, typeLabel: '', title: x.title, excerpt: x.content, isAvailable: true })) as never,
      resolveActions: async () => [], persist: async () => null, hasPendingClarification: async () => false,
      buildSynthesisContext: async () => plan,
      generateWithAI: async () => ({
        answer: '2 mars 2024 : vidange.', claims: [], actions: [], supportLevel: 'supported',
        events: [{ date: '2024-03-02', text: 'Vidange réalisée', sourceIds: ['timeline:asset_1:1'] }],
      }),
    };
    const r = await runAssistant(input('Fais la chronologie de ma Clio'), ports);
    expect(r.events).toEqual([{ date: '2024-03-02', text: 'Vidange réalisée', ref: 'agenda_12', href: expect.stringMatching(/agenda/) }]);
    const api = toApiPayload(r);
    expect(api.events).toEqual([{ date: '2024-03-02', text: 'Vidange réalisée', href: expect.any(String) }]);

    const sansIa = await runAssistant(input('Fais la chronologie de ma Clio', { planType: 'STANDARD' }), { ...ports, generateWithAI: undefined });
    expect(sansIa.events?.[0]).toMatchObject({ date: '2024-03-02', text: 'Vidange — réalisé', ref: 'agenda_12' });
  });

  it('interface : lignes « date · libellé », liens internes seulement ; sans événements, rien ne change', () => {
    expect(timelineRows({ events: [
      { date: '2024-03-02', text: 'Vidange', href: '/agenda?tiroir=echeance:12' },
      { date: null, text: 'Achat', href: 'https://ailleurs.example' },
    ] })).toEqual([
      { key: '0-2024-03-02', date: '02/03/2024', text: 'Vidange', href: '/agenda?tiroir=echeance:12' },
      { key: '1-x', date: 'Date inconnue', text: 'Achat', href: null },
    ]);
    expect(timelineRows({ events: null })).toEqual([]);
  });
});

describe('3. budget d’événements dans assistant-config', () => {
  it('défaut 60, variable lue par la configuration, bornée 1…200 ; le planificateur la lit', () => {
    expect(loadAssistantConfig().timelineMaxEvents).toBe(60);
    process.env.VEREBONA_ASSISTANT_TIMELINE_MAX_EVENTS = '25';
    expect(loadAssistantConfig().timelineMaxEvents).toBe(25);
    resetAssistantConfigForTests();
    expect(S.timelineMaxEvents()).toBe(25);
    process.env.VEREBONA_ASSISTANT_TIMELINE_MAX_EVENTS = '999';
    expect(loadAssistantConfig().timelineMaxEvents).toBe(200);
    process.env.VEREBONA_ASSISTANT_TIMELINE_MAX_EVENTS = '0';
    expect(loadAssistantConfig().timelineMaxEvents).toBe(60);
  });
});

describe('4. confirmation d’une commande : valeur canonique (T2-40)', () => {
  it('état du bien lu par commandAssetState (X), variable retirée sans effet', async () => {
    const etat = { id: 3, name: 'Polo', city: null, category: 'VEHICULE', status: null, lockState: null, characteristics: { acquisitionDate: '2021-05-25' } };
    etatCommande.fn.mockResolvedValue(etat);
    expect(await sqlLookup.getAssetState!(1, 3)).toBe(etat);
    expect(etatCommande.fn).toHaveBeenCalledWith(1, 3);
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    expect(await sqlLookup.getAssetState!(1, 3)).toBe(etat);
  });
});

describe('5. sources synthétiques et lignes compactes : acceptées par claim-support (Z)', () => {
  const upcoming: Src = { id: 'upcoming_agenda:asset_1', type: 'agenda_item', title: 'Échéances à venir', relevanceScore: 0.9, content: '2027-01-01 · CT (Clio) [agenda_7]' };
  const todo: Src = { id: 'to_process:asset_1', type: 'to_process_item', title: '« À traiter »', relevanceScore: 0.9, content: 'Confirmer le kilométrage de 45 000 km [todo_8]' };
  it('dates et valeurs des lignes compactes soutiennent une affirmation citant la source synthétique', () => {
    expect(verifyClaimSupport({ text: 'La Clio a été achetée le 25 mai 2021.', sourceIds: [CHUNK.id] }, [CHUNK]).supported).toBe(true);
    expect(verifyClaimSupport({ text: 'Le contrôle technique est prévu le 1er janvier 2027.', sourceIds: [upcoming.id] }, [upcoming]).supported).toBe(true);
    expect(verifyClaimSupport({ text: 'Un kilométrage de 45 000 km reste à confirmer.', sourceIds: [todo.id] }, [todo]).supported).toBe(true);
    // Une date absente de la chronologie reste rejetée.
    expect(verifyClaimSupport({ text: 'Vidange le 3 avril 2024.', sourceIds: [CHUNK.id] }, [CHUNK]).supported).toBe(false);
  });
});
