/**
 * Suite du lot 15 (volet X) : source vérifiable du total de dépenses
 * (claim-support de Z), revalidation des faits visuels en T2 master,
 * sources de niveau champ décodées, contrôlées et ouvrables.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ arch: 'steps' as 'steps' | 'master' }));
vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));
vi.mock('@/services/ai/config/config-resolver', () => ({ getPromptArchitecture: async () => h.arch }));

const { answerFromData } = await import('../../core/data-answer.service');
const { DEFAULT_THRESHOLDS } = await import('../../core/sufficiency');
const { parseEntityRef, hrefEntite, hrefSource } = await import('../../core/entity-ref');
const { identifiantsIndisponibles } = await import('../../core/source-availability.service');
const { verifyClaimSupport } = await import('@/services/ai/assistant/claim-support');
const { expenseSumSource, aggregateExpenses } = await import('../expenses');
type Port = import('../../core/data-answer.service').AccountDataPort;
type Fact = import('../../core/data-answer.service').FactHit;

afterEach(() => { h.arch = 'steps'; delete process.env.ASSISTANT_CANONICAL_READ; });

describe('T2-24 × T2-31 — source du total qualifié, vérifiable par claim-support', () => {
  const q = aggregateExpenses([
    { fileId: 11, amountCents: 20000, cls: { kind: 'theme', theme: 'maintenance' } },
    { fileId: 12, amountCents: 25000, cls: { kind: 'theme', theme: 'maintenance' } },
    { fileId: 13, amountCents: 7000, cls: { kind: 'unqualified' } },
  ], 'maintenance');
  const src = expenseSumSource(q, { assetIds: [42], scopeLabel: 'Clio', year: 2025 });

  it('porte total, thème, complétude, année et documents inclus', () => {
    expect(src.id).toBe('expenses:maintenance:42:2025');
    expect(src.meta).toMatchObject({ theme: 'maintenance', totalCents: 45000, documentCount: 2, complete: false, unqualifiedCount: 1, year: 2025, includedDocuments: 'doc-11 doc-12' });
    expect(src.content).toContain('total incomplet');
  });
  it('une reformulation fidèle est soutenue ; un total inventé est rejeté', () => {
    const ok = verifyClaimSupport({ text: 'Vous avez dépensé 450 € en entretien pour la Clio en 2025, sur 2 factures.', sourceIds: [src.id] }, [src]);
    expect(ok.supported).toBe(true);
    const faux = verifyClaimSupport({ text: 'Vous avez dépensé 520 € en entretien.', sourceIds: [src.id] }, [src]);
    expect(faux).toMatchObject({ supported: false, reason: 'DATA_NOT_IN_SOURCES' });
    const decl = verifyClaimSupport({ text: 'Total entretien : 450,00 €', sourceIds: [src.id], support: { kind: 'value', sourceId: src.id, value: '450,00 €' } as never }, [src]);
    expect(decl.supported).toBe(true);
  });
  it('la réponse structured.sum_qualified cite cette source', async () => {
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const port: Port = {
      today: () => '2026-09-30', findAssets: async () => [{ id: 42, name: 'Clio', category: 'VEHICULE', subtype: null, purchaseDate: null, isRented: false, matched: 2 }],
      listAssets: async () => [], countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
      sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }), searchFacts: async () => [], searchDocuments: async () => [],
      sumQualifiedExpenses: async () => q,
    };
    const r = await answerFromData({ port, accountId: 1, message: 'Combien ai-je dépensé en entretien pour la Clio en 2025 ?', thresholds: DEFAULT_THRESHOLDS });
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.sources[0].id).toBe('expenses:maintenance:42:2025');
    expect(r.claims[0].sourceIds).toContain('expenses:maintenance:42:2025');
    expect(verifyClaimSupport({ text: r.answer!.split(' 1 autre')[0], sourceIds: r.claims[0].sourceIds }, r.sources).supported).toBe(true);
  });
});

describe('T2-30 — revalidation des faits visuels en T2 master (VISUAL_RECHECK)', () => {
  const visuel = (id: number, conf = 'probable'): Fact => ({
    id, fileId: 9, factKey: 'etat_toiture', subject: 'toiture', attribute: 'état', label: null, valueText: 'tuiles cassées', valueNumber: null,
    valueUnit: null, confidence: conf, excerpt: '', documentTitle: 'Photo toiture', matchedTerms: 2, evidenceOrigin: 'VISUAL_ANALYSIS',
    visualDescription: 'tuiles cassées',
  });
  const port = (facts: Fact[]): Port => ({
    today: () => '2026-09-30', findAssets: async () => [], listAssets: async () => [], countDocuments: async () => 0,
    countAgenda: async () => 0, upcomingAgenda: async () => [], sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
    searchFacts: async () => facts, searchDocuments: async () => [],
  });
  const ask = (facts: Fact[]) => answerFromData({ port: port(facts), accountId: 1, message: 'état de la toiture', thresholds: DEFAULT_THRESHOLDS });

  it('l’observation visuelle peu sûre est proposée (VISUAL_RECHECK, master T2 seul depuis le lot 16b-2)', async () => {
    h.arch = 'steps';
    const r = await ask([visuel(1, 'ambiguous')]);
    expect(r.revalidation).toEqual({ trigger: 'LOW_CONFIDENCE', factIds: [1] });
  });
});

describe('T2-32 — sources `asset_field:<id>:<clé>` décodées, contrôlées, ouvrables', () => {
  it('décodées comme le BIEN, clé conservée ; clé hors registre ou type attendu différent refusés', () => {
    expect(parseEntityRef('asset_field:42:acquisitionDate')).toEqual({ kind: 'asset', id: 42, sourceId: 'asset_field:42:acquisitionDate', fieldKey: 'acquisitionDate' });
    expect(parseEntityRef('asset_field:42:acquisitionDate', 'asset')?.id).toBe(42);
    expect(parseEntityRef('asset_field:42:acquisitionDate', 'document')).toBeNull();
    expect(parseEntityRef('asset_field:42:passwordHash')).toBeNull();
    expect(parseEntityRef('asset_field:0:mileage')).toBeNull();
    expect(parseEntityRef('asset_42')).toMatchObject({ kind: 'asset', id: 42 });
  });
  it('ouverture : fiche du bien, onglet Détails, champ en surbrillance', () => {
    expect(hrefSource('asset_field:42:mileage')).toBe('/assets/42?tab=details&highlight=mileage');
    expect(hrefEntite({ kind: 'asset', id: 42, sourceId: 'asset_42' })).toBe('/assets/42');
  });
  it('disponibilité : contrôlée par la famille « bien », bornée au compte', async () => {
    const requeteur = vi.fn(async (_sql: string, params: unknown[]) => ((params[0] as number[]).includes(42) ? [{ id: 42 }] : []));
    const ko = await identifiantsIndisponibles(['asset_field:42:mileage', 'asset_field:7:mileage'], 1, requeteur);
    expect([...ko]).toEqual(['asset_field:7:mileage']);
    expect(requeteur.mock.calls[0][0]).toContain('FROM assets');
    expect(requeteur.mock.calls[0][1]).toEqual([[42, 7], 1]);
  });
});
