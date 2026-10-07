/**
 * Lot 29 — ticket 8b : T2 SQL-first. Compréhension déterministe d'abord
 * (registre canonique, référentiel des catégories), recherche SQL large et
 * exacte (nom, catégorie, VIN, immatriculation normalisée), lecture
 * canonique, réponse rédigée par le serveur ; le modèle n'intervient que
 * pour COMPRENDRE une demande non comprise, et ne produit qu'une intention
 * structurée (jamais de SQL).
 *
 * « 0 appel LLM » : compteur du client modèle simulé (classification
 * UNDERSTAND + génération ANSWER) ET `cascade.aiCalls` de l'orchestrateur.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
vi.mock('@/db', () => ({
  pgClient: { unsafe: (sql: string, params?: unknown[]) => unsafe(sql, params) },
  db: { $client: { unsafe: vi.fn(async () => []) } }, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));
// Branche UNDERSTAND : appel modèle capturé (variables de prompt), sortie structurée simulée.
const appelsModele: Array<Record<string, unknown>> = [];
vi.mock('@/services/verebona-assistant/core/model-call-policy', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  callWithRepairOrEscalation: async (o: { build: (v: object) => { promptVariables: Record<string, unknown> } }) => {
    appelsModele.push(o.build({}).promptVariables);
    return {
      res: { data: { mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact', entityHints: [{ type: 'asset', value: 'Clio' }],
        requestedFacts: ['acquisitionPrice'], requestedTopics: [], filters: {}, reason: 'r', sql: 'DELETE FROM assets' } },
      events: [],
    };
  },
}));
vi.mock('@/lib/session-service', () => ({
  SessionService: { getSession: async () => ({ userId: 7, currentAccountId: 1 }), handleSessionError: () => new Response(null, { status: 401 }) },
}));
const vehicules = vi.fn(async (_a: number, _i: { plates: string[]; vins: string[] }, _o?: unknown) => [] as unknown[]);
vi.mock('@/services/verebona-assistant/core/target-lookup.repository', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findVehiclesByIdentifier: (a: number, i: { plates: string[]; vins: string[] }, o?: unknown) => vehicules(a, i, o),
}));

const H = await import('./harness');
const { deterministicRequestedFacts } = await import('../../../canonical/field-vocabulary');
const { readTargetForRequest } = await import('../../target-answer');
const { T2UnderstandOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { understandWithT2Master } = await import('@/services/ai/assistant/master/t2-understand');
const { findEntitiesByTerms } = await import('../../target-lookup.repository');
const { answerFromData } = await import('../../data-answer.service');
const { DEFAULT_THRESHOLDS } = await import('../../sufficiency');
const { ADAPTATEURS } = await import('../../../registries/retrieval-adapters');
const { createAiCallBudget } = await import('../../ai-call-budget');
const { diagnosticMessage } = await import('../../t2-diagnostics');

beforeEach(() => { unsafe.mockClear(); appelsModele.length = 0; vehicules.mockReset(); vehicules.mockResolvedValue([]); });

const MAISON = { id: 10, name: 'Maison de Bourg', category: 'IMMOBILIER', subtype: 'Maison', city: 'Bourg-en-Bresse',
  fields: { address1: '12 rue des Lilas', postalCode: '01000', city: 'Bourg-en-Bresse' } };
const POLO = { id: 20, name: 'Polo', category: 'VEHICULE', subtype: 'Voiture', registrationNumber: 'AB-123-CD', fields: { mileage: 82000, acquisitionPrice: 18500, registrationNumber: 'AB-123-CD' } };
const VTT = { id: 30, name: 'VTT', category: 'OBJECT' };
const P3008 = { id: 40, name: 'Peugeot 3008', category: 'VEHICULE', fields: { vin: 'VF3MCYHZRML012345', mileage: 40000 } };

/** Sans appel modèle : compteur du client ET trace de l'orchestrateur. */
const zeroLlm = (h: { llmCalls(): number }, r: { cascade?: { aiCalls: number } }) => {
  expect(h.llmCalls()).toBe(0);
  expect(r.cascade?.aiCalls).toBe(0);
};

describe('Ticket 8b — T2 SQL-first', () => {
  it('T2SQL-AC01 — Maison unique : résolution du bien + lecture address1 + 0 appel LLM', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO, VTT] }));
    const r = await h.ask('Quelle est l’adresse de la maison ?');
    expect(r.answer).toContain('12 rue des Lilas, 01000 Bourg-en-Bresse');
    expect(h.readers.calls[0]).toEqual({ kind: 'asset', id: 10, key: 'address1' });
    expect(r.clarification).toBeNull();
    zeroLlm(h, r);
  });

  it('T2SQL-AC02 — deux maisons : autres critères de la demande, sinon clarification', async () => {
    const lyon = { ...MAISON, id: 11, name: 'Maison Lyon', city: 'Lyon', fields: { address1: '1 quai Lyon' } };
    const annecy = { ...MAISON, id: 12, name: 'Maison Annecy', city: 'Annecy', fields: { address1: '2 rue Annecy' } };
    const h = H.harness(H.account({ assets: [lyon, annecy] }));
    const precise = await h.ask('Quelle est l’adresse de la maison de Lyon ?');
    expect(precise.answer).toContain('1 quai Lyon');
    const ambigu = await h.ask('Quelle est l’adresse de la maison ?');
    expect(ambigu.clarification?.candidates.map((c) => c.entityId)).toEqual([11, 12]);
    expect(ambigu.answer).not.toMatch(/quai|rue/);
    expect(h.llmCalls()).toBe(0);
  });

  it('T2SQL-AC03 — VIN exact → véhicule résolu directement + 0 appel LLM', async () => {
    const h = H.harness(H.account({ assets: [POLO, P3008] }));
    const r = await h.ask('Quel est le kilométrage du VF3MCYHZRML012345 ?');
    expect(r.answer).toContain('40');
    expect(h.lookup.calls.vehicles).toBe(1);
    zeroLlm(h, r);
  });

  it('T2SQL-AC04 — immatriculation exacte, formats normalisés (AB-123-CD, AB 123 CD, ab123cd) ; aucun rapprochement approximatif', async () => {
    for (const plaque of ['AB-123-CD', 'AB 123 CD', 'ab123cd']) {
      const h = H.harness(H.account({ assets: [POLO, P3008] }));
      const r = await h.ask(`Quel est le kilométrage du véhicule ${plaque} ?`);
      expect(r.answer).toContain('82');
      zeroLlm(h, r);
    }
    // Normalisation pure : plaques SIV / FNI, VIN ISO 3779 (sans I, O, Q).
    const { vehicleIdentifiersIn } = await import('../../vehicle-identifiers');
    expect(vehicleIdentifiersIn('ab123cd, AB 123 CD et AB-123-CD')).toEqual({ plates: ['AB123CD'], vins: [] });
    expect(vehicleIdentifiersIn('VIN VF3MCYHZRML012345').vins).toEqual(['VF3MCYHZRML012345']);
    expect(vehicleIdentifiersIn('1234 AB 56').plates).toEqual(['1234AB56']);
    // Une lettre de différence : un AUTRE véhicule, jamais « le plus proche ».
    const h = H.harness(H.account({ assets: [POLO, { ...P3008, subtype: 'Voiture' }] }));
    const faux = await h.ask('Quel est le kilométrage du véhicule AB-123-CE ?');
    expect(faux.answer).not.toContain('82');
  });

  it('T2SQL-AC05 — nom exact unique → bien direct', async () => {
    const h = H.harness(H.account({ assets: [POLO, P3008, MAISON] }));
    const r = await h.ask('Quel est le prix d’achat de la Polo ?');
    expect(r.answer).toMatch(/18\s?500\s?€/);
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 20, key: 'acquisitionPrice' }]);
    zeroLlm(h, r);
  });

  it('T2SQL-AC06 — catégorie ou famille unique → bien direct sans IA', async () => {
    const h = H.harness(H.account({ assets: [{ ...POLO, subtype: null }, MAISON, VTT] }));
    const famille = await h.ask('Quel est le kilométrage de mon véhicule ?');
    expect(famille.answer).toContain('82');
    const categorie = await h.ask('Quelle est l’immatriculation de ma voiture ?');
    expect(categorie.answer).toContain('AB-123-CD');
    expect(h.llmCalls()).toBe(0);
    // Vocabulaire DÉRIVÉ du référentiel `asset-taxonomy` (pas de dictionnaire T2).
    const { assetDesignationsIn } = await import('@/lib/asset-taxonomy');
    expect(assetDesignationsIn('la maison et mes voitures').map((d) => [d.kind, d.family, d.category ?? null])).toEqual([
      ['category', 'IMMOBILIER', 'Maison'], ['category', 'VEHICULE', 'Voiture'],
    ]);
    expect(assetDesignationsIn('mon véhicule')).toEqual([{ kind: 'family', family: 'VEHICULE', matched: 'vehicule' }]);
    expect(assetDesignationsIn('le camping-car et le garage').map((d) => d.category)).toEqual(['Camping-car', 'Garage/box']);
    // Une catégorie précise n'est pas élargie à sa famille : « la maison » ≠ un appartement.
    const { assetsOfDesignation } = await import('../../assistant-targets');
    const maison = assetDesignationsIn('la maison')[0];
    expect(assetsOfDesignation(maison, [
      { id: 1, name: 'Studio', category: 'IMMOBILIER', subtype: 'Appartement' }, { id: 2, name: 'Chalet', category: 'IMMOBILIER', subtype: null },
    ]).map((a) => a.id)).toEqual([2]);
  });

  it('T2SQL-AC07 — champs compris depuis le vocabulaire canonique (registre)', () => {
    expect(deterministicRequestedFacts('Quelle est l’adresse ?')).toEqual(['address1']);
    expect(deterministicRequestedFacts('Quel est le kilométrage ?')).toEqual(['mileage']);
    expect(deterministicRequestedFacts('Quel est le prix d’achat ?')).toEqual(['acquisitionPrice']);
    expect(deterministicRequestedFacts('Donne-moi la date d’achat, le prix d’achat et le kilométrage')).toEqual(['acquisitionDate', 'acquisitionPrice', 'mileage']);
    expect(deterministicRequestedFacts('Quel est le numéro de série ?')).toEqual(['serialNumber']);
    expect(deterministicRequestedFacts('Bonjour')).toEqual([]);
  });

  it('T2SQL-AC08 — cible + champ connus → lecture directe, aucune IA', async () => {
    const acc = H.account({ assets: [POLO] });
    const lookup = H.fakeLookup(acc);
    const readers = H.fakeReaders(acc);
    const t = H.harness(acc);
    const lu = await readTargetForRequest({ accountId: 1, message: 'et alors ?', pageContext: { assetId: '20' } },
      (await import('../../assistant-targets')).targetsFromInput({ pageContext: { assetId: '20' } }),
      { entityHints: [], understanding: { requestedFacts: ['mileage'], filters: {} } }, { lookup, readers });
    expect(lu?.text).toContain('82');
    expect(readers.calls).toEqual([{ kind: 'asset', id: 20, key: 'mileage' }]);
    const r = await t.ask('Quel est son kilométrage ?', { pageContext: { assetId: '20', route: '/assets/20' } });
    expect(r.answer).toContain('82');
    zeroLlm(t, r);
  });

  it('T2SQL-AC09 — donnée sensible restituée au propriétaire sans être envoyée au LLM', async () => {
    const h = H.harness(H.account({ assets: [MAISON] }));
    const r = await h.ask('À quelle adresse se situe la maison ?');
    expect(r.answer).toContain('12 rue des Lilas');
    zeroLlm(h, r);
    const adresse = r.sources.find((s) => s.id === 'asset_field:10:address1');
    expect(adresse?.excerpt).toContain('(donnée protégée)');
    expect(JSON.stringify(r.sources)).not.toContain('12 rue des Lilas');
  });

  it('T2SQL-AC10 — repli IA : intention STRUCTURÉE du modèle, puis le serveur reprend la résolution', async () => {
    const clio = { id: 50, name: 'Clio', category: 'VEHICULE', subtype: 'Voiture', fields: { acquisitionPrice: 9000 } };
    const h = H.harness(H.account({ assets: [POLO, clio] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionPrice'], [{ type: 'asset', value: 'Clio' }]),
    });
    // Relation (« celle d'avant ») non comprise par les règles : le modèle est sollicité.
    const r = await h.ask('Et la bagnole d’avant, elle m’a coûté combien ?');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.generate).not.toHaveBeenCalled();
    expect(r.answer).toMatch(/9\s?000\s?€/);
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 50, key: 'acquisitionPrice' }]);
  });

  it('T2SQL-AC11 — aucun SQL généré par le modèle n’est exécuté (sortie typée, indices paramétrés)', async () => {
    // Un champ « sql » de la sortie est ignoré par le contrat.
    const p = T2UnderstandOutput.parse({ mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact', sql: 'DROP TABLE assets' });
    expect(p).not.toHaveProperty('sql');
    // Un indice est une DONNÉE passée en paramètre, jamais du texte SQL.
    const piege = "x'; DROP TABLE equipments; --";
    await findEntitiesByTerms(1, 'equipment', [piege]);
    const [sql, params] = unsafe.mock.calls[0];
    expect(String(sql)).not.toContain('DROP TABLE');
    expect(JSON.stringify(params).toUpperCase()).toContain('DROP TABLE');
    const h = H.harness(H.account({ assets: [POLO] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['serialNumber'], [{ type: 'equipment', value: piege }]) });
    const r = await h.ask('Quel est le n° de série du truc ?');
    expect(r.cascade?.diagnostic).toBe('TARGET_NOT_FOUND');
  });

  it('T2SQL-AC12 — corpus IA borné : la compréhension ne reçoit que la question, les catalogues et le contexte borné', async () => {
    const r = await understandWithT2Master('Combien m’a coûté la voiture que j’avais avant la Polo ?', {
      accountId: 1, userId: 7, planType: 'PREMIUM', message: 'x', clientRequestId: 'c', locale: 'fr-FR',
      aiBudget: createAiCallBudget(2), aiReport: { securityEvents: [], events: [] },
    });
    expect(appelsModele).toHaveLength(1);
    const vars = appelsModele[0];
    const renseignees = Object.entries(vars).filter(([, v]) => v !== null).map(([k]) => k).sort();
    expect(renseignees).toEqual(['CONVERSATION_CONTEXT', 'FIELD_CATALOG', 'INTENTS', 'PAGE_CONTEXT', 'QUESTION']);
    // Aucune ligne du compte (biens, valeurs) n'est transmise à la compréhension.
    expect(JSON.stringify(vars)).not.toMatch(/AB-123-CD|12 rue des Lilas/);
    expect(r?.requestedFacts).toEqual(['acquisitionPrice']);
  });

  it('T2SQL-AC13 — calculs : agrégations réalisées côté serveur (dépenses qualifiées), sans modèle', async () => {
    const port = {
      today: () => '2026-10-06', findAssets: async () => [{ id: 20, name: 'Polo', category: 'VEHICULE', subtype: null, purchaseDate: null, isRented: false, matched: 2 }],
      listAssets: async () => [], countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
      sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }), searchFacts: async () => [], searchDocuments: async () => [],
      sumQualifiedExpenses: vi.fn(async () => ({
        qualifiedSumCents: 45000, qualifiedCount: 2, byTheme: [{ theme: 'maintenance', label: 'entretien', sumCents: 45000, count: 2 }],
        unqualified: { count: 0, undatedCount: 0 }, excluded: { count: 0 }, duplicates: { count: 0 }, complete: true, documentIds: [],
      })),
    };
    const r = await answerFromData({ port: port as never, accountId: 1, message: 'Combien ai-je dépensé en entretien pour la Polo ?', thresholds: DEFAULT_THRESHOLDS });
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toContain('450,00');
    expect(port.sumQualifiedExpenses).toHaveBeenCalledWith(1, expect.objectContaining({ assetIds: [20], theme: 'maintenance' }));
  });

  it('T2SQL-AC14 — l’IA de synthèse n’est appelée que pour une demande de synthèse', async () => {
    const src = [{ id: 'asset_20', type: 'asset_field' as const, title: 'Polo', content: 'Polo · VEHICULE', relevanceScore: 0.9, meta: { assetId: 20 } }];
    const h = H.harness(H.account({ assets: [POLO] }), { retrieved: src, generated: 'Point complet sur la Polo.' });
    const champ = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(h.generate).not.toHaveBeenCalled();
    expect(champ.cascade?.aiCalls).toBe(0);
    const synthese = await h.ask('Fais-moi une synthèse de tout ce qui concerne la Polo');
    expect(synthese.route.intent).toBe('ACCOUNT_SUMMARY');
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('T2SQL-AC15 — recherche SQL-first globale : biens, documents, équipements, pièces, fournisseurs, échéances, À traiter ; barre de recherche par VIN exact', async () => {
    const noms = ADAPTATEURS.map((a) => a.name);
    for (const n of ['assets', 'documents', 'equipments', 'rooms', 'suppliers', 'agenda', 'to_process']) expect(noms).toContain(n);
    vehicules.mockResolvedValue([{ id: 40, name: 'Peugeot 3008', category: 'VEHICULE', subtype: 'Voiture', registrationNumber: 'EF-456-GH' }]);
    const { GET } = await import('@/app/api/search/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://x/api/search?q=VF3MCYHZRML012345'));
    const body = await res.json() as { results: Array<{ label: string; href: string }>; aiPowered: boolean };
    expect(body.results[0]).toMatchObject({ label: 'Peugeot 3008', href: '/assets/40' });
    expect(body.aiPowered).toBe(false);
    expect(vehicules).toHaveBeenCalledWith(1, { plates: [], vins: ['VF3MCYHZRML012345'] }, { includeArchived: true });
  });

  it('T2SQL-AC16 — observabilité : parcours déterministes avec assertion explicite « 0 appel LLM »', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO] }));
    for (const q of ['Quelle est l’adresse de la maison ?', 'Quel est le kilométrage de la Polo ?', 'Quand ai-je acheté la Polo ?', 'Quelle est l’immatriculation de la Polo ?']) {
      const r = await h.ask(q);
      expect(r.cascade?.aiCalls).toBe(0);
      expect(r.cascade?.answeredBy).toBe('structured');
      expect(r.cascade?.strategy).toMatch(/^target\./);
    }
    expect(h.llmCalls()).toBe(0);
  });

  it('T2SQL-AC17 — diagnostics : les motifs d’échec ne convergent plus vers un unique « rien trouvé »', async () => {
    const vus = new Map<string, string>();
    const garde = async (code: string, h: ReturnType<typeof H.harness>, q: string, extra = {}) => {
      const r = await h.ask(q, extra);
      expect(r.cascade?.diagnostic, q).toBe(code);
      vus.set(code, r.error?.message ?? r.answer);
    };
    await garde('TARGET_NOT_FOUND', H.harness(H.account({ assets: [POLO] })), 'Quelle est l’adresse de ma maison ?');
    await garde('TARGET_AMBIGUOUS', H.harness(H.account({ assets: [MAISON, { ...MAISON, id: 11, name: 'Maison Lyon' }] })), 'Quelle est l’adresse de la maison ?');
    await garde('TARGET_UNAVAILABLE', H.harness(H.account({ assets: [{ ...POLO, status: 'ARCHIVED' }] })), 'Quel est son kilométrage ?', { pageContext: { assetId: '20' } });
    await garde('FIELD_NOT_SET', H.harness(H.account({ assets: [{ ...MAISON, fields: {} }] })), 'Quelle est l’adresse de la maison ?');
    await garde('SEARCH_NO_RESULT', H.harness(H.account({ assets: [POLO] })), 'Retrouve la facture Zorglub');
    await garde('UNDERSTANDING_FAILED', H.harness(H.account({ assets: [POLO] })), 'blorg fizz ?');
    await garde('TECHNICAL_READ_FAILURE', H.harness(H.account({ assets: [POLO] }), {
      readersOver: { field: async () => { throw new Error('connexion perdue'); } },
    }), 'Quel est le kilométrage de la Polo ?');
    expect(vus.size).toBe(7);
    const rienTrouve = [...vus.entries()].filter(([, t]) => /rien trouvé/.test(t)).map(([c]) => c);
    expect(rienTrouve).toEqual(['SEARCH_NO_RESULT']);
    expect(vus.get('TECHNICAL_READ_FAILURE')).toBe(diagnosticMessage('TECHNICAL_READ_FAILURE'));
  });
});
