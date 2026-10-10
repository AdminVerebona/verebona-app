/**
 * Lot 15 (Y) — ciblage et recherche, fonctions pures : cibles
 * (`ResolvedTarget`, T2-08, T2-19 à T2-21), contrat de sources (T2-07),
 * filtres structurés des documents (T2-13, T2-14).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const { targetsFromInput, assetsNamedIn, resolveAssistantTargets } = await import('../assistant-targets');
const { adaptersForIntent, analyserRequeteCanonique, entityFiltersFromTargets } = await import('../retrieval.service');
const { documentSearchFilters, documentTypeStems, tokenizeQuery } = await import('../query-terms');
const { ADAPTATEURS, documentTypeCodesFor } = await import('../../registries/retrieval-adapters');

const TODAY = '2026-09-30';

describe('cibles de la demande (ResolvedTarget)', () => {
  it('priorité : clarification > fil > page ; page document, bien et fournisseur', () => {
    const t = targetsFromInput({
      pageContext: { documentId: '12', assetId: '3', supplierId: '9' },
      reference: { type: 'agenda_item', id: 44, method: 'pronoun' },
    }, null, TODAY);
    expect(t.primary).toMatchObject({ type: 'agenda_item', id: 44, origin: 'thread' });
    expect(t.document).toMatchObject({ id: 12, origin: 'page' });
    expect(t.asset).toMatchObject({ id: 3, origin: 'page' });
    expect(t.supplier).toMatchObject({ id: 9, origin: 'page' });

    const r = targetsFromInput({
      pageContext: { documentId: '12' },
      resume: { clarificationId: 'c', intent: 'ACCOUNT_FACT_DOCUMENT', documentId: 77, chainDepth: 1, choiceLabel: 'Ticket' },
    }, null, TODAY);
    expect(r.primary).toMatchObject({ type: 'document', id: 77, origin: 'clarification' });
    expect(r.document?.id).toBe(77);
  });

  it('T2-08 : indices = noms seulement (jamais « page: », jamais une famille), période résolue', () => {
    const t = targetsFromInput({}, {
      entityHints: [
        { type: 'asset', value: 'page:5' }, { type: 'asset', value: 'maison' }, { type: 'asset', value: 'Clio' },
        { type: 'document', value: 'factures' }, { type: 'document', value: 'facture EDF' },
        { type: 'supplier', value: 'Garage Martin' }, { type: 'agenda', value: 'échéances' },
        { type: 'period', value: 'en 2024' },
      ] as never,
    }, TODAY);
    expect(t.hints.assetNames).toEqual(['Clio']);
    expect(t.hints.documentTitles).toEqual(['facture EDF']);
    expect(t.hints.supplierNames).toEqual(['Garage Martin']);
    expect(t.hints.period).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(t.primary).toBeNull();
  });

  it('biens nommés : mots entiers, le nom le plus précis gagne ; une famille ne nomme rien', () => {
    const biens = [{ id: 1, name: 'Clio' }, { id: 2, name: 'Clio 4' }, { id: 3, name: 'Maison de Lyon' }, { id: 4, name: 'Polo' }];
    expect(assetsNamedIn('Quand ai-je acheté la Clio 4 ?', biens).map((b) => b.id)).toEqual([2]);
    expect(assetsNamedIn('les documents de ma maison', biens)).toEqual([]);
    expect(assetsNamedIn('Compare la Clio et la Polo', biens).map((b) => b.id)).toEqual([1, 4]);
    expect(assetsNamedIn('la maison de lyon', biens).map((b) => b.id)).toEqual([3]);
  });

  it('bien nommé > page ; indice ramené à UN bien du compte ; plusieurs biens nommés : aucun filtre unique', async () => {
    const biens = async () => [{ id: 1, name: 'Clio' }, { id: 2, name: 'Polo' }];
    const a = await resolveAssistantTargets({ accountId: 1, message: 'échéances de la Polo', pageContext: { assetId: '1' } }, null, biens);
    expect(a.asset).toMatchObject({ id: 2, origin: 'message' });
    expect(entityFiltersFromTargets(a)).toEqual({ assetId: 2 });

    const h = await resolveAssistantTargets({ accountId: 1, message: 'et ses échéances ?' }, { entityHints: [{ type: 'asset', value: 'la Clio' }] }, biens);
    expect(h.asset).toMatchObject({ id: 1, origin: 'hint' });

    const c = await resolveAssistantTargets({ accountId: 1, message: 'Compare la Clio et la Polo', pageContext: { assetId: '1' } }, null, biens);
    expect(c.namedAssets).toHaveLength(2);
    expect(entityFiltersFromTargets(c).assetId).toBeUndefined();
  });
});

describe('T2-07 — contrat de sources de l’intention', () => {
  const noms = (intent: string) => adaptersForIntent(intent, ADAPTATEURS).adapters.map((a) => a.name);

  it('seuls les adaptateurs des types attendus', () => {
    expect(noms('ACCOUNT_SEARCH_DOCUMENT')).toEqual(['documents']);
    expect(noms('ACCOUNT_SEARCH_AGENDA')).toEqual(['agenda']);
    expect(noms('ACCOUNT_SEARCH_SUPPLIER')).toEqual(['suppliers']);
    // Lot 34 : demandes d'actions — À traiter et échéances (jamais de document).
    expect(noms('ACCOUNT_TO_PROCESS')).toEqual(['agenda', 'to_process']);
    expect(noms('PRODUCT_PLAN_LIMIT')).toEqual(['product_rules']);
    expect(noms('ACCOUNT_MISSING_INFORMATION')).toEqual(['assets', 'documents', 'equipments', 'rooms', 'to_process', 'product_rules']);
  });

  it('repli documenté : intention sans contrat → adaptateurs de données, jamais les règles d’offre', () => {
    const r = adaptersForIntent('UNKNOWN', ADAPTATEURS);
    expect(r.fallback).toBe(true);
    expect(r.adapters.map((a) => a.name)).not.toContain('product_rules');
    expect(r.adapters).toHaveLength(ADAPTATEURS.length - 1);
  });
});

describe('T2-13, T2-14 — filtres structurés des documents', () => {
  it('« facture », « devis » : types demandés (y compris le pluriel « devis »)', () => {
    expect(analyserRequeteCanonique('Retrouve une facture', TODAY).documentTypes).toEqual(['facture']);
    expect(analyserRequeteCanonique('Retrouve le devis de Norauto', TODAY).documentTypes).toEqual(['devis']);
    expect(documentTypeStems(tokenizeQuery('mes factures et devis'))).toEqual(['facture', 'devis']);
  });

  it('codes de type : facture ≠ devis', () => {
    const f = documentTypeCodesFor('facture');
    expect(f).toEqual(expect.arrayContaining(['FACTURE', 'MAINTENANCE_INVOICE', 'REPAIR_INVOICE', 'ACQUISITION_INVOICE']));
    expect(f).not.toContain('DEVIS');
    const d = documentTypeCodesFor('devis');
    expect(d).toEqual(expect.arrayContaining(['DEVIS', 'MAINTENANCE_QUOTE', 'WORKS_QUOTE']));
    expect(d).not.toContain('FACTURE');
    expect(documentTypeCodesFor('garantie')).toEqual(expect.arrayContaining(['CERTIFICAT_GARANTIE', 'WARRANTY_CERTIFICATE']));
  });

  it('suggestion docs_unlinked : filtre « non rattaché », mots du filtre retirés des termes', () => {
    const r = analyserRequeteCanonique('Quels documents ne sont rattachés à aucun bien ?', TODAY);
    expect(r.documentFilters).toEqual({ link: 'unlinked' });
    expect(r.terms).toEqual([]);
    expect(documentSearchFilters('mes factures non rattachées').filters.link).toBe('unlinked');
    expect(documentSearchFilters('documents sans bien').filters.link).toBe('unlinked');
    expect(documentSearchFilters('documents rattachés à un bien').filters.link).toBe('linked');
  });

  it('statut d’analyse et fournisseur', () => {
    expect(documentSearchFilters('Quels documents sont en cours d’analyse ?').filters.analysis).toEqual(['IN_ANALYSIS']);
    expect(documentSearchFilters('documents dont l’analyse a échoué').filters.analysis).toEqual(['ANALYSIS_FAILED']);
    expect(documentSearchFilters('documents en échec d’analyse').filters.analysis).toEqual(['ANALYSIS_FAILED']);
    expect(documentSearchFilters('les factures à vérifier').filters.analysis).toEqual(['TO_VALIDATE']);
    const f = documentSearchFilters('mes factures chez Norauto en 2024');
    expect(f.filters.supplierName).toBe('norauto');
    expect(documentSearchFilters('Retrouve une facture').filters).toEqual({});
  });
});
