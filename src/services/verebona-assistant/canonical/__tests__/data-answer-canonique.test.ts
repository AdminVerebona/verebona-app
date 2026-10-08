/**
 * Réponses exactes de l'assistant en lecture canonique (CDC 15 T2-02, T2-04,
 * T2-15, T2-22, T2-23, T2-24, T2-32 ; lot 15). Lot 16b-2 : lecture
 * canonique seule (ASSISTANT_CANONICAL_READ et lecture historique retirés).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { answerFromData } = await import('../../core/data-answer.service');
const { DEFAULT_THRESHOLDS } = await import('../../core/sufficiency');
type Port = import('../../core/data-answer.service').AccountDataPort;
type Reading = import('../field-reader').CanonicalFieldReading;

const clio = { id: 42, name: 'Clio', category: 'VEHICULE', subtype: null, purchaseDate: '2021-05-25', isRented: false, matched: 2 };
const lecture = (over: Partial<Reading> = {}): Reading => ({
  assetId: 42, assetName: 'Clio', key: 'acquisitionDate', label: 'Date d’achat', value: '2021-05-25', display: '25 mai 2021',
  origin: 'USER', originLabel: 'saisie par vous', updatedAt: null, from: 'key', evidence: null, openConflict: null, sensitive: false, ...over,
});

function port(over: Partial<Port> = {}): Port {
  return {
    today: () => '2026-09-30',
    findAssets: async (_a, w) => (w.includes('clio') ? [clio] : []),
    listAssets: async () => [clio],
    countDocuments: async () => 0,
    countAgenda: async () => 0,
    upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => ({ sumCents: 123400, count: 5 }),
    searchFacts: async () => [],
    searchDocuments: async () => [],
    readAssetField: async (_a, _id, key) => (key === 'mileage'
      ? lecture({ key: 'mileage', label: 'Kilométrage', value: 45000, display: '45 000 km', origin: 'RECONCILIATION', originLabel: 'retenue après rapprochement de vos documents' })
      : key === 'acquisitionDate' ? lecture() : null),
    sumQualifiedExpenses: async (_a, o) => ({
      theme: o.theme ?? null,
      byTheme: o.theme === 'maintenance' || !o.theme ? [{ theme: 'maintenance', label: 'entretien', sumCents: 45000, count: 2, fileIds: [1, 2] }] : [],
      qualifiedSumCents: 45000, qualifiedCount: 2, unqualified: { count: 1, sumCents: 7000, fileIds: [3], undatedCount: 0 },
      excluded: { count: 1, byType: { DEVIS: 1 } }, duplicates: { count: 0, fileIds: [] }, complete: false,
    }),
    listMissingInformation: async () => [{ assetId: 42, assetName: 'Clio', family: 'VEHICULE', missing: [{ key: 'registrationNumber', label: 'Immatriculation', toProcessPublicId: null }], toProcess: [] }],
    listUpcomingAgenda: async (_a, o) => [
      { id: 7, title: 'Contrôle technique', date: '2026-10-20', forecast: false, assetNames: ['Clio'], businessType: 'inspection' },
      ...(o.windowDays && o.windowDays > 60 ? [{ id: 8, title: 'Assurance', date: '2026-12-01', forecast: true, assetNames: ['Clio'], businessType: 'insurance' }] : []),
    ],
    ...over,
  };
}

const ask = (message: string, p: Port = port()) =>
  answerFromData({ port: p, accountId: 1, message, thresholds: DEFAULT_THRESHOLDS });

afterEach(() => { delete process.env.ASSISTANT_CANONICAL_READ; });

describe('lecture canonique', () => {

  it('T2-22 / T2-32 : un champ du registre, source de niveau champ', async () => {
    const r = await ask('Quel est le kilométrage de la Clio ?');
    expect(r.strategy).toBe('structured.asset_field');
    expect(r.answer).toBe('Kilométrage de Clio : 45 000 km.');
    expect(r.sources[0].id).toBe('asset_field:42:mileage');
    expect(r.claims[0].sourceIds).toEqual(['asset_field:42:mileage']);
  });

  it('T2-23 : date d’achat lue dans acquisitionDate canonique', async () => {
    const r = await ask('Quand ai-je acheté la Clio ?');
    expect(r.strategy).toBe('structured.asset_field');
    expect(r.answer).toContain('Vous avez acheté Clio le 25 mai 2021');
    expect(r.sources[0].id).toBe('asset_field:42:acquisitionDate');
  });

  it('T2-24 : dépenses d’entretien qualifiées, couverture incomplète et exclus signalés', async () => {
    const r = await ask('Combien ai-je dépensé en entretien pour la Clio ?');
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toMatch(/^Dépenses de entretien documentées pour Clio : 450,00\s€ \(2 documents\)\./);
    expect(r.answer).toContain('le total peut être incomplet');
    expect(r.answer).toContain('devis');
  });

  it('T2-24 : aucun document qualifié mais des non qualifiés → pas de total affirmé', async () => {
    const r = await ask('Combien ai-je dépensé en assurance pour la Clio ?');
    expect(r.answer).toContain('Je ne peux pas isoler vos dépenses de assurance');
  });

  it('T2-15 : échéances à venir sur une fenêtre ; « bientôt » = 30 jours', async () => {
    const r = await ask('Quelles échéances arrivent bientôt pour la Clio ?');
    expect(r.strategy).toBe('structured.upcoming_agenda');
    expect(r.answer).toContain('dans les 30 prochains jours');
    expect(r.answer).not.toContain('Assurance');
    const r3 = await ask('Mes échéances des 3 prochains mois pour la Clio');
    expect(r3.answer).toContain('prévue le 1 décembre 2026');
  });

  it('T2-04 : informations manquantes depuis le registre', async () => {
    const r = await ask('Qu’est-ce qui manque sur la fiche de la Clio ?');
    expect(r.strategy).toBe('structured.missing_information');
    expect(r.answer).toContain('à renseigner : immatriculation');
    expect(r.sources[0].id).toBe('asset_field:42:registrationNumber');
  });

  it('T2-02 : la valeur canonique prime sur un fait T1 divergent', async () => {
    const fait = {
      id: 1, fileId: 9, factKey: 'mileage', subject: 'Clio', attribute: 'compteur', label: null, valueText: '44 000', valueNumber: 44000,
      valueUnit: 'km', confidence: 'certain', excerpt: 'Kilométrage : 44 000', documentTitle: 'PV CT', matchedTerms: 1,
      canonical: { assetId: 42, key: 'mileage', label: 'Kilométrage', value: '45 000 km', origin: 'RECONCILIATION', originLabel: 'x', openConflict: null },
    };
    const r = await ask('le compteur de la Clio', port({ searchFacts: async () => [fait] }));
    expect(r.strategy).toBe('retrieval.canonical_field');
    expect(r.answer).toContain('45 000 km');
    expect(r.answer).toMatch(/Un document indique une autre valeur \(44\s000\skm\) : la valeur de votre fiche fait foi\./);
  });
});

describe('variable retirée encore posée : sans effet', () => {
  it('ASSISTANT_CANONICAL_READ=legacy : lecture canonique quand même', async () => {
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    expect((await ask('Quand ai-je acheté la Clio ?')).strategy).not.toBe('structured.purchase_date');
  });
});

describe('contrat de sources de l’intention au niveau 2 (T2-07, corpus §15 E2E-T2-18)', () => {
  const doc = { fileId: 9, title: 'Contrôle technique — procès-verbal', date: '2026-03-01', assetName: 'Clio', snippet: '', matchedTerms: 2, analysisState: 'ANALYZED' };
  const avecDoc = port({ searchDocuments: async () => [doc] as never });
  const demande = (intent: string) => answerFromData({ port: avecDoc, accountId: 1, message: 'Retrouve le contrôle technique', thresholds: DEFAULT_THRESHOLDS, intent });

  it('une intention sans document au contrat n’obtient jamais un document ; la recherche documentaire, si', async () => {
    const agenda = await demande('ACCOUNT_SEARCH_AGENDA');
    expect(agenda.handled).toBe(false);
    expect(agenda.sources).toEqual([]);
    expect((await demande('ACCOUNT_SEARCH_DOCUMENT')).strategy).toBe('retrieval.document');
  });

  it('intentionSansDocuments : contrat vide ou absent → non', async () => {
    const { intentionSansDocuments } = await import('../../core/data-answer.service');
    expect(['ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_SUPPLIER', 'ACCOUNT_TO_PROCESS', 'ACCOUNT_FACT_AGENDA'].every(intentionSansDocuments)).toBe(true);
    expect(['ACCOUNT_FACT_ASSET', 'ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_SUMMARY', 'UNKNOWN', undefined].some(intentionSansDocuments)).toBe(false);
  });
});
