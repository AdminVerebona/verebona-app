/**
 * Trace §18 T2 (lot 17) : source de vérité, sources par type, cible — sans
 * aucun contenu utilisateur.
 */
import { describe, it, expect } from 'vitest';
import { buildT2ObservabilityTrace, countSourceTypes, truthSourceOf } from '../t2-observability';

describe('source de vérité T2', () => {
  it.each([
    ['structured.asset_field', 'canonique'],
    ['retrieval.canonical_field', 'canonique'],
    ['retrieval.t1_fact', 'fait'],
    ['retrieval.t1_table', 'tableau'],
    ['retrieval.document', 'document'],
    ['structured.next_deadline', 'agenda'],
    ['structured.upcoming_agenda', 'agenda'],
    ['structured.exports', 'export'],
    ['template.greeting', 'regle_offre'],
    ['help.contradiction', 'regle_offre'],
    ['clarification.asset', 'clarification'],
    ['reference.clarification', 'clarification'],
    ['fallback.sources', 'aucune'],
    ['none', 'aucune'],
    ['timeout.partial', 'aucune'],
    ['quelque.chose', 'autre'],
  ])('%s → %s', (strategy, attendu) => {
    expect(truthSourceOf(strategy)).toBe(attendu);
  });

  it('réponse générée : type de source majoritaire, sinon « modele »', () => {
    expect(truthSourceOf('llm.generate_answer', { document: 3, asset_field: 1 })).toBe('document');
    expect(truthSourceOf('llm.generate_answer', { product_rule: 2 })).toBe('regle_offre');
    expect(truthSourceOf('llm.generate_answer', {})).toBe('modele');
  });

  it('absence de stratégie : sans résultat', () => {
    expect(truthSourceOf(undefined)).toBe('aucune');
  });
});

describe('trace sans contenu', () => {
  it('compte les sources par type, et rien d’autre', () => {
    expect(countSourceTypes([{ type: 'document' }, { type: 'document' }, { type: 'asset_field' }, { type: 'Titre libre !' }]))
      .toEqual({ document: 2, asset_field: 1, autre: 1 });
  });

  it('cible : type et origine seulement — ni libellé ni identifiant', () => {
    const t = buildT2ObservabilityTrace({
      strategy: 'retrieval.document',
      sources: [{ type: 'document', title: 'Bail de M. Dupont', excerpt: 'loyer 800 €' } as never],
      target: { type: 'document', id: 42, origin: 'thread', label: 'Bail de M. Dupont' } as never,
    });
    expect(t).toEqual({ truthSource: 'document', sourceTypes: { document: 1 }, target: { type: 'document', origin: 'thread' } });
    expect(JSON.stringify(t)).not.toMatch(/Dupont|800|42/);
  });

  it('cible absente ou illisible : null', () => {
    expect(buildT2ObservabilityTrace({ strategy: 'none', sources: [], target: null }).target).toBeNull();
    expect(buildT2ObservabilityTrace({ strategy: 'none', sources: [], target: { type: 'Nom Libre' } }).target).toBeNull();
  });
});
