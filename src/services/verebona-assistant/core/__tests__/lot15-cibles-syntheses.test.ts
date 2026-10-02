/**
 * Lot 15 (Y) — lectures ciblées (T2-19 à T2-21), planificateurs de synthèse
 * (T2-10, T2-33, T2-34), classification ambiguë (T2-09) et correction de
 * route (T2-14) dans l'orchestrateur, parseur de commandes (T2-37),
 * disponibilité « À traiter » (T2-45). Sans base : lecteurs injectés.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const T = await import('../target-answer');
const S = await import('../synthesis-planner');
const { targetsFromInput } = await import('../assistant-targets');
const { runAssistant, affinerRoute, buildIntentClarification } = await import('../assistant-orchestrator.service');
const { toIntentRoute } = await import('../classification.adapter');
const { routeForIntent } = await import('../intent-router.service');
const { parseCommand, isReadingRequest } = await import('../../commands/parser');
const { identifiantsIndisponibles, REQUETES_DISPONIBILITE, REQUETE_TO_PROCESS } = await import('../source-availability.service');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;
type Doc = import('../../canonical/document-state').CanonicalDocumentState;
type Item = import('../../canonical/agenda').CanonicalAgendaItem;
type Snap = import('../synthesis-planner').AssetSnapshot;
type Deps = import('../synthesis-planner').SynthesisDeps;

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });
// Lot 16b-2 : lecture canonique seule (ASSISTANT_CANONICAL_READ retiré).

const DOC: Doc = {
  fileId: 12, title: 'Ticket Leroy Merlin', documentDate: '2026-03-02', documentTypeCode: 'SUBSCRIPTION_INVOICE', documentTypeLabel: 'Facture',
  catalogCode: 'FACTURE', rubricCode: null, rubricLabel: null, amountCents: 4590, supplier: 'Leroy Merlin', analysisStatus: 'ANALYZED',
  assets: [{ assetId: 3, name: 'Maison', role: 'PRIMARY', origin: 'USER' }], facts: [],
};
const ITEM: Item = {
  id: 44, title: 'Contrôle technique', date: '2026-01-10', nature: 'DEADLINE', businessType: 'inspection', status: 'not_proven',
  manualStatus: null, forecast: false, category: 'action', isAutomatic: true, userModified: false, overdue: true,
  assets: [{ assetId: 3, name: 'Clio' }], sources: [],
};
const readers = (over: Partial<import('../target-answer').TargetReaders> = {}) => ({
  document: vi.fn(async (_a: number, id: number) => (id === 12 ? DOC : null)),
  agenda: vi.fn(async (_a: number, id: number) => (id === 44 ? ITEM : null)),
  today: () => '2026-09-30',
  ...over,
});

describe('T2-19 à T2-21 — lectures ciblées', () => {
  it('attributs reconnus ; la question ne nomme rien d’autre', () => {
    expect(T.documentAttributeOf('Quel est le montant ?')).toBe('amount');
    expect(T.documentAttributeOf('Et son montant ?')).toBe('amount');
    expect(T.documentAttributeOf('Qui est le fournisseur ?')).toBe('supplier');
    expect(T.agendaAttributeOf('Et sa date ?')).toBe('date');
    expect(T.agendaAttributeOf('Est-ce qu’il a été fait ?')).toBe('status');
    expect(T.asksOnlyAboutTarget('Quel est le montant de ce document ?')).toBe(true);
    expect(T.asksOnlyAboutTarget('Et son montant ?')).toBe(true);
    expect(T.asksOnlyAboutTarget('Quel est le montant de la facture Norauto ?')).toBe(false);
    expect(T.asksOnlyAboutTarget('Indique-moi la date d’achat de la Polo')).toBe(false);
  });

  it('page document + « quel est le montant ? » → le document de la page, lu par la couche canonique', async () => {
    const r = readers();
    const t = targetsFromInput({ pageContext: { documentId: '12' } });
    const a = await T.answerFromTarget(1, 'Quel est le montant ?', t, r);
    expect(a?.text).toMatch(/^Le montant de « Ticket Leroy Merlin » est de 45,90\s€\.$/);
    expect(a?.sources[0].id).toBe('doc_12');
    expect(a?.claims[0].sourceIds).toEqual(['doc_12']);
    expect(r.document).toHaveBeenCalledWith(1, 12);
  });

  it('cas limite : la question nomme un autre document → pas de lecture ciblée', async () => {
    const r = readers();
    const t = targetsFromInput({ pageContext: { documentId: '12' } });
    expect(await T.answerFromTarget(1, 'Quel est le montant de la facture Norauto ?', t, r)).toBeNull();
    expect(await T.answerFromTarget(1, 'Quelles échéances arrivent bientôt ?', t, r)).toBeNull();
    expect(r.document).not.toHaveBeenCalled();
  });

  it('échéance citée dans le fil : date et statut à 4 états (une date passée ne prouve rien)', async () => {
    const t = targetsFromInput({ reference: { type: 'agenda_item', id: 44, method: 'pronoun' } });
    const d = await T.answerFromTarget(1, 'Et sa date ?', t, readers());
    expect(d?.text).toContain('10 janvier 2026');
    expect(d?.intent).toBe('ACCOUNT_FACT_AGENDA');
    const st = await T.answerFromTarget(1, 'Il a été fait ?', t, readers());
    expect(st?.text).toContain('une date passée ne prouve pas');
    const fait = T.agendaTargetAnswer({ ...ITEM, status: 'completed', manualStatus: 'realise' }, 'status', '2026-09-30');
    expect(fait.text).toContain('marqué comme réalisé');
  });

  it('document hors compte → null (jamais une réponse inventée)', async () => {
    const t = targetsFromInput({ pageContext: { documentId: '99' } });
    expect(await T.answerFromTarget(1, 'Quel est le montant ?', t, readers())).toBeNull();
  });
});

const snap = (id: number, name: string, fields: Record<string, string>): Snap => ({
  id, name, family: 'VEHICULE',
  fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { label: k, display: v }])),
  applicable: { mileage: 'Kilométrage', acquisitionDate: 'Date d’achat', registrationNumber: 'Immatriculation' },
});
const deps = (over: Partial<Deps> = {}): Deps => ({
  targets: async (input, route) => ({ ...targetsFromInput(input, route), namedAssets: [{ id: 1, name: 'Clio' }, { id: 2, name: 'Polo' }] }),
  documentContent: vi.fn(async (_a, o) => (o.assetIds ?? o.fileIds ?? []).map((x: number) => ({
    id: `doc_${x * 10}`, type: 'document_extraction' as const, title: `Doc ${x}`, content: 'contenu', relevanceScore: 0.8, meta: {},
  }))),
  findDocuments: vi.fn(async () => [5, 6]),
  assetSnapshot: async (_a, id) => (id === 1 ? snap(1, 'Clio', { mileage: '45 000 km' }) : snap(2, 'Polo', { acquisitionDate: '25 mai 2021' })),
  upcoming: async () => [{ id: 7, title: 'CT', date: '2027-01-01', forecast: false, assetNames: ['Clio'] }],
  toProcess: async () => [{ id: 8, question: 'Confirmer le kilométrage', priority: 'DO_FIRST' }],
  timelineRows: async () => [],
  accountAssets: async () => [],
  ...over,
});
const input = (message: string) => ({ accountId: 1, userId: 2, planType: 'PREMIUM', message, clientRequestId: 'c' });

describe('T2-10, T2-33, T2-34 — planificateurs de synthèse', () => {
  it('comparaison : MÊMES dimensions pour chaque bien, documents attribués à leur bien, budget ≤ 8', async () => {
    const p = await S.buildSynthesisContext(routeForIntent('ACCOUNT_COMPARISON', 'PREMIUM', 't'), input('Compare la Clio et la Polo') as never, deps());
    expect(p?.kind).toBe('comparison');
    const [a, b] = p!.sources;
    expect(a.content).toContain('mileage : 45 000 km');
    expect(a.content).toContain('Date d’achat : non renseigné');
    expect(b.content).toContain('Kilométrage : non renseigné');
    expect(b.content).toContain('acquisitionDate : 25 mai 2021');
    expect(p!.sources.filter((s) => s.meta?.assetName === 'Clio').map((s) => s.id)).toEqual(['doc_10']);
    expect(p!.sources.length).toBeLessThanOrEqual(8);
  });

  it('comparaison : moins de deux biens nommés → pas de plan (recherche générique)', async () => {
    const d = deps({ targets: async (i, r) => ({ ...targetsFromInput(i, r), namedAssets: [{ id: 1, name: 'Clio' }] }) });
    expect(await S.buildSynthesisContext(routeForIntent('ACCOUNT_COMPARISON', 'PREMIUM', 't'), input('Compare la Clio') as never, d)).toBeNull();
  });

  it('synthèse : état canonique, documents du type demandé, échéances et « À traiter »', async () => {
    const d = deps({ targets: async (i, r) => ({ ...targetsFromInput(i, r), namedAssets: [{ id: 1, name: 'Clio' }] }) });
    const p = await S.buildSynthesisContext(routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't'), input('Résume les garanties de la Clio') as never, d);
    expect(p!.sources.map((s) => s.type)).toEqual(['asset_field', 'document_extraction', 'document_extraction', 'agenda_item', 'to_process_item']);
    expect(d.findDocuments).toHaveBeenCalledWith(1, expect.objectContaining({ assetIds: [1], typeWords: ['garantie'], codes: expect.arrayContaining(['CERTIFICAT_GARANTIE']) }));
  });

  it('chronologie : nombre d’événements SÉPARÉ du budget de sources (70 événements → 60 gardés, ≤ 8 sources)', async () => {
    process.env.VEREBONA_ASSISTANT_TIMELINE_MAX_EVENTS = '60';
    const rows = Array.from({ length: 70 }, (_, i) => ({
      date: `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      label: `Événement ${i}`, kind: 'agenda' as const, ref: `agenda_${i}`, assetName: 'Clio', detail: null,
    }));
    const d = deps({ targets: async (i, r) => ({ ...targetsFromInput(i, r), namedAssets: [{ id: 1, name: 'Clio' }] }), timelineRows: async () => rows });
    const p = await S.buildSynthesisContext(routeForIntent('ACCOUNT_TIMELINE', 'PREMIUM', 't'), input('Chronologie de la Clio') as never, d);
    expect(p!.timeline).toMatchObject({ totalEvents: 70, truncated: true });
    expect(p!.timeline!.events).toHaveLength(60);
    expect(p!.sources.length).toBeLessThanOrEqual(8);
    expect(p!.sources.every((s) => s.content.length <= 1500)).toBe(true);
    const lignes = p!.sources.flatMap((s) => s.content.split('\n'));
    expect(lignes.length).toBeGreaterThan(8);
    expect(lignes[0]).toMatch(/\[agenda_\d+\]$/);
    expect(S.timelineAnswer(p!)).toContain('Chronologie de Clio');
  });
});

/** Ports minimaux ; `retrieve` compté. */
const ports = (over: Partial<Ports> = {}): Ports & { retrieve: ReturnType<typeof vi.fn> } => ({
  retrieve: vi.fn(async () => []),
  resolveSources: async (s: Array<import('../../types/sources').RetrievedSource>) => s.map((x) => ({ id: x.id, type: x.type, typeLabel: '', title: x.title, excerpt: x.content, isAvailable: true })) as never,
  resolveActions: async () => [],
  persist: async () => null,
  hasPendingClarification: async () => false,
  ...over,
}) as never;

describe('orchestrateur — lecture canonique', () => {
  it('T2-21 : page document + « Quel est le montant ? » → lecture ciblée, aucune recherche', async () => {
    const p = ports({ readTarget: async (i, t) => T.answerFromTarget(i.accountId, i.message, t, readers()) });
    const r = await runAssistant({ ...input('Quel est le montant ?'), pageContext: { documentId: '12' } } as never, p);
    expect(r.answer).toMatch(/^Le montant de « Ticket Leroy Merlin » est de 45,90\s€\.$/);
    expect(r.cascade?.strategy).toBe('target.document_amount');
    expect(p.retrieve).not.toHaveBeenCalled();
  });

  it('T2-09 : classification ambiguë sans cible → clarification, aucune recherche', async () => {
    const saveClarification = vi.fn(async () => true);
    const p = ports({
      saveClarification,
      classifyWithAI: async () => toIntentRoute({ intent: 'ACCOUNT_SEARCH_DOCUMENT', confidence: 'ambiguous', entityHints: [], reason: '' }, 'PREMIUM'),
    });
    const r = await runAssistant({ ...input('le truc de l’autre fois là'), conversationId: 5 } as never, p);
    expect(r.clarification?.candidateType).toBe('action');
    expect(r.clarification?.candidates[0]).toMatchObject({ resumeIntent: 'ACCOUNT_SEARCH_DOCUMENT' });
    expect(r.cascade?.escalationReasons).toContain('CLARIFICATION:CLASSIFICATION_AMBIGUOUS');
    expect(p.retrieve).not.toHaveBeenCalled();
  });

  it('T2-09 : cas limite — cible de page connue → résolution déterministe, la recherche a lieu', async () => {
    const p = ports({
      saveClarification: async () => true,
      classifyWithAI: async () => toIntentRoute({ intent: 'ACCOUNT_SEARCH_DOCUMENT', confidence: 'ambiguous', entityHints: [], reason: '' }, 'PREMIUM'),
    });
    const r = await runAssistant({ ...input('le truc de l’autre fois là'), conversationId: 5, pageContext: { assetId: '3' } } as never, p);
    expect(r.clarification).toBeNull();
    expect(r.cascade?.escalationReasons).toContain('CLASSIFICATION:AMBIGUOUS_RESOLVED_BY_PAGE');
    expect(p.retrieve).toHaveBeenCalled();
  });

  it('T2-33 : chronologie → plan dédié (pas la recherche générique) ; repli sans modèle = liste datée', async () => {
    const plan: import('../synthesis-planner').SynthesisPlan = {
      kind: 'timeline', assets: [{ id: 1, name: 'Clio' }], budget: { sources: 8, events: 60 },
      timeline: { events: [{ date: '2021-05-25', label: 'Achat', kind: 'acquisition', ref: 'asset_field:1:acquisitionDate', assetName: 'Clio', detail: null }], totalEvents: 1, truncated: false },
      sources: S.timelineSources([{ date: '2021-05-25', label: 'Achat', kind: 'acquisition', ref: 'asset_field:1:acquisitionDate', assetName: 'Clio', detail: null }], 'asset_1', 8),
    };
    const p = ports({ buildSynthesisContext: async () => plan });
    const r = await runAssistant({ ...input('Fais la chronologie de ma Clio'), planType: 'STANDARD' } as never, p);
    expect(p.retrieve).not.toHaveBeenCalled();
    expect(r.answer).toContain('25 mai 2021 : Achat');
    expect(r.cascade?.escalationReasons.some((x) => x.startsWith('SYNTHESIS:timeline'))).toBe(true);
  });

  it('T2-14 : « quels documents sont en cours d’analyse ? » est une recherche de documents, pas une synthèse', () => {
    const r = affinerRoute(routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't'), { message: 'Quels documents sont en cours d’analyse ?', planType: 'PREMIUM' });
    expect(r.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
  });

  it('clarification d’intention : choix du registre, intention proposée d’abord', () => {
    const c = buildIntentClarification({ accountId: 1, userId: 2, originalMessage: 'x', originalMessageId: 'm', proposed: 'ACCOUNT_SEARCH_AGENDA' });
    expect(c.candidates.map((x) => x.resumeIntent)).toEqual(['ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_FACT_ASSET', 'PRODUCT_HELP_HOW_TO']);
    expect(c.candidates.every((x) => x.resumeMessage === 'x')).toBe(true);
  });
});

describe('T2-37 — le parseur de commandes n’intercepte plus les questions (hors commutateur)', () => {
  const today = '2026-09-30';
  it('lecture : « Indique-moi… », « renseigne » sans valeur, « note » en question', () => {
    expect(parseCommand('Indique-moi la date d’achat de la Polo', today)).toBeNull();
    expect(parseCommand('Renseigne la date d’achat de la Polo', today)).toBeNull();
    expect(parseCommand('Tu peux noter le kilométrage de la Clio ?', today)).toBeNull();
    expect(parseCommand('Indique-moi si le ramonage est fait', today)).toBeNull();
    expect(isReadingRequest('Indique-moi la date d’achat')).toBe(true);
  });
  it('demandes polies d’action (« peux-tu », « tu peux »… + verbe + valeur) : commandes', () => {
    expect(parseCommand('Peux-tu noter le kilométrage à 45 000 km pour la polo ?', today))
      .toMatchObject({ command: 'UPDATE_ASSET_FIELD', value: 45000, assetWords: ['polo'] });
    expect(parseCommand('Tu peux renseigner l’assureur MAIF pour la polo ?', today))
      .toMatchObject({ command: 'UPDATE_ASSET_FIELD', assetWords: ['polo'] });
    expect(parseCommand('Pourriez-vous indiquer la date d’achat de la Polo : 25/05/2021 ?', today))
      .toMatchObject({ command: 'UPDATE_ASSET_FIELD', value: '2021-05-25' });
    // Question ouverte par un mot interrogatif, même avec une valeur : lecture.
    expect(parseCommand('Quand ai-je noté le kilométrage à 45 000 km ?', today)).toBeNull();
    expect(isReadingRequest('Peux-tu noter que le ramonage est fait ?')).toBe(false);
    expect(isReadingRequest('Le ramonage est noté comme fait ?')).toBe(true);
  });

  it('écriture : verbe fort, ou verbe ambigu AVEC une nouvelle valeur', () => {
    expect(parseCommand('Mets la date d’achat de la Polo au 25/05/2021', today)).toMatchObject({ command: 'UPDATE_ASSET_FIELD', value: '2021-05-25' });
    expect(parseCommand('Modifie la date d’achat de la Polo', today)).toMatchObject({ command: 'UPDATE_ASSET_FIELD', value: null });
    expect(parseCommand('Renseigne la date d’achat de la Polo : 25/05/2021', today)).toMatchObject({ command: 'UPDATE_ASSET_FIELD', value: '2021-05-25' });
    expect(parseCommand('Marque le ramonage comme fait', today)).toMatchObject({ command: 'MARK_AGENDA_DONE' });
  });
});

describe('T2-45 — disponibilité des sources « À traiter »', () => {
  it('revérifiée sur sa clé, élément résolu = indisponible', async () => {
    expect(REQUETES_DISPONIBILITE.to_process).toBe(REQUETE_TO_PROCESS);
    const requeteur = vi.fn(async (sql: string) => (sql.includes('to_process_actions') ? [{ id: 1 }] : []));
    const morts = await identifiantsIndisponibles(['todo_1', 'todo_2'], 9, requeteur);
    expect([...morts]).toEqual(['todo_2']);
    expect(requeteur).toHaveBeenCalledWith(REQUETE_TO_PROCESS, [[1, 2], 9]);
  });
});
