/**
 * Recherche découpée, cartes groupées et états d'un document — CDC §11.2,
 * §11.3, §11.4, §12.4, §13.5, §22.2, §22.3, §23.1–23.4, 37.1, 37.7.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { tokenizeQuery, termMatchRatio, likePatterns, editDistance } = await import('../query-terms');
const { buildResultGroups, summarizeGroups, GROUP_QUOTAS } = await import('../result-groups');
const { answerFromData, answerFromRetrievedSources, noResultAnswer } = await import('../data-answer.service');
const { IN_ANALYSIS_MESSAGE } = await import('../document-status');
const { DEFAULT_THRESHOLDS } = await import('../sufficiency');
const { runAssistant } = await import('../assistant-orchestrator.service');
type Source = import('../../types/sources').RetrievedSource;
type Port = import('../data-answer.service').AccountDataPort;
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;

describe('découpage de la requête (§11.2, §13.5)', () => {
  it('mots outils et verbes retirés, pluriels ramenés, accents normalisés', () => {
    const t = tokenizeQuery('Retrouve-moi mes factures de plombier à Lyon');
    expect(t.map((x) => x.stem)).toEqual(['facture', 'plombier', 'lyon']);
  });

  it('synonymes métier', () => {
    const [v] = tokenizeQuery('ma voiture');
    expect(v.variants).toEqual(expect.arrayContaining(['voiture', 'vehicule']));
    const [ct] = tokenizeQuery('le CT');
    expect(ct.variants).toContain('controle');
  });

  it('immatriculations et dates conservées telles quelles', () => {
    const t = tokenizeQuery('facture pour AB-123-CD du 12/03/2024');
    expect(t.filter((x) => x.exact).map((x) => x.raw)).toEqual(expect.arrayContaining(['ab-123-cd', '12/03/2024']));
  });

  it('classement : correspondance, synonyme, faute simple', () => {
    const t = tokenizeQuery('facture plombier');
    expect(termMatchRatio(t, 'Facture Plomberie Martin')).toBeGreaterThan(0.8);
    expect(termMatchRatio(tokenizeQuery('factrue'), 'Facture EDF')).toBeCloseTo(0.8);
    expect(termMatchRatio(t, 'Contrat assurance')).toBe(0);
    expect(editDistance('chaudiere', 'chaudeire')).toBeLessThanOrEqual(2);
  });

  it('motifs LIKE : racine, synonymes et préfixe pour les mots longs', () => {
    const [t] = tokenizeQuery('chaudières');
    const p = likePatterns(t);
    expect(p).toEqual(expect.arrayContaining(['%chaudiere%', '%chauffage%']));
    expect(p.some((x) => x.length < '%chaudiere%'.length)).toBe(true);
  });
});

const src = (id: string, type: Source['type'], score: number, meta: Source['meta'] = {}): Source =>
  ({ id, type, title: id, content: '', relevanceScore: score, meta });

describe('cartes de résultats groupées (§11.3, §22.3)', () => {
  it('regroupe par type, applique les quotas, propose la page complète au-delà', () => {
    const docs = Array.from({ length: 11 }, (_, i) => src(`doc_${i + 1}`, 'document', 0.9 - i / 100, { date: '2025-01-02', assetName: 'Maison' }));
    const g = buildResultGroups([src('asset_1', 'asset_field', 0.95), ...docs, src('supplier_4', 'supplier', 0.7)]);
    expect(g.map((x) => x.type)).toEqual(['asset', 'document', 'supplier']);
    const d = g.find((x) => x.type === 'document')!;
    expect(d.items).toHaveLength(GROUP_QUOTAS.document);
    expect(d.total).toBe(11);
    expect(d.hasMore).toBe(true);
    expect(d.moreHref).toBe('/documents');
    expect(d.items[0]).toMatchObject({ typeLabel: 'Document', subtitle: 'Maison', date: '2025-01-02' });
    expect(d.items[0].href).toMatch(/document/);
    // Carte fournisseur : fiche `/fournisseurs/[id]`.
    expect(g.find((x) => x.type === 'supplier')!.items[0].href).toBe('/fournisseurs/4');
    expect(summarizeGroups(g)).toBe('J’ai trouvé 13 résultats : 1 bien, 11 documents, 1 fournisseur.');
  });

  it('37.1 : une recherche de documents rend des cartes, sans modèle', () => {
    const sources = [src('doc_1', 'document', 0.9), src('doc_2', 'document', 0.8)];
    const r = answerFromRetrievedSources('ACCOUNT_SEARCH_DOCUMENT', 'retrouve mes factures', sources, DEFAULT_THRESHOLDS, { candidates: sources });
    expect(r.handled).toBe(true);
    expect(r.groups?.[0].items).toHaveLength(2);
    expect(r.answer).toBe('J’ai trouvé 2 résultats.');
  });

  it('aucun résultat (§11.4) : reformuler, filtrer, aide — Premium seulement si interprétation', () => {
    expect(noResultAnswer('retrouve ma facture', false)).toMatch(/reformuler.*filtrer.*aide/);
    expect(noResultAnswer('retrouve ma facture', false)).not.toMatch(/Premium/);
    expect(noResultAnswer('résume mes garanties', false)).toMatch(/Premium/);
  });
});

function port(docs: Array<{ analysisState: string | null }>): Port {
  return {
    today: () => '2026-09-26',
    findAssets: async () => [],
    listAssets: async () => [],
    countDocuments: async () => 0,
    countAgenda: async () => 0,
    upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
    searchFacts: async () => [],
    searchDocuments: async () => docs.map((d, i) => ({
      fileId: 10 + i, title: `Facture chaudière ${i}`, date: '2026-09-01', assetName: 'Maison', matchedTerms: 2 - i, analysisState: d.analysisState,
    })),
  };
}

describe('états d’un document (§12.4, §23, 37.7)', () => {
  const ask = (states: Array<string | null>, message = 'quel est le montant de la facture chaudière ?') =>
    answerFromData({ port: port(states.map((s) => ({ analysisState: s }))), accountId: 1, message, thresholds: DEFAULT_THRESHOLDS });

  it('en cours d’analyse : texte du §23.2, sans modèle', async () => {
    const r = await ask(['ANALYZING']);
    expect(r.handled).toBe(true);
    expect(r.answer).toContain(IN_ANALYSIS_MESSAGE);
    expect(r.documentState?.kind).toBe('IN_ANALYSIS');
    expect(r.sources[0].meta?.statusLabel).toBe('En cours d’analyse');
  });

  it('échec d’analyse : explication et orientation (§23.4)', async () => {
    const r = await ask(['ANALYSIS_FAILED']);
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/relancer.*remplacer.*compléter.*À traiter/);
    expect(r.documentState?.kind).toBe('ANALYSIS_FAILED');
  });

  it('trouvé mais information absente : état distinct, escalade possible', async () => {
    const r = await ask(['ANALYZED']);
    expect(r.handled).toBe(false);
    expect(r.documentState?.kind).toBe('FOUND_WITHOUT_INFO');
  });

  it('recherche de document en analyse : trouvé, avec son statut (§23.1)', async () => {
    const r = await ask(['UPLOADED'], 'retrouve la facture chaudière');
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/J’ai trouvé ce document.*encore en cours d’analyse/);
  });

  it('orchestrateur, offre Standard : « trouvé sans l’information » n’est pas « aucun résultat »', async () => {
    const ports: Ports = {
      retrieve: async () => [],
      resolveSources: async () => [],
      resolveActions: async () => [],
      persist: async () => null,
      hasPendingClarification: async () => false,
      answerFromData: async (_route, input, thresholds) => answerFromData({
        port: port([{ analysisState: 'ANALYZED' }]), accountId: input.accountId, message: input.message, thresholds,
      }),
    };
    const r = await runAssistant({
      accountId: 1, userId: 2, planType: 'STANDARD', message: 'quel est le montant de la facture chaudière ?',
      clientRequestId: 'x', locale: 'fr-FR',
    }, ports);
    expect(r.answer).toMatch(/J’ai trouvé « Facture chaudière 0 », mais l’information demandée n’y figure pas/);
    expect(r.cascade?.escalationReasons).toContain('DOCUMENT:FOUND_WITHOUT_INFO');
  });
});
