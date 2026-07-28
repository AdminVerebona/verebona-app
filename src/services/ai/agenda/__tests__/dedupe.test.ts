/**
 * Déduplication — CDC §4.4.4 et non-régression §11.4.
 *
 * « Aucun doublon d'agenda n'est créé. » C'est l'un des reproches les plus
 * visibles pour l'utilisateur : deux lignes identiques dans « Prochaines dates »
 * décrédibilisent immédiatement l'agenda.
 */
import { describe, it, expect } from 'vitest';
import { findDuplicate, titleSimilarity } from '../dedupe.service';
import type { ExistingAgendaItem } from '../types';

function item(over: Partial<ExistingAgendaItem> = {}): ExistingAgendaItem {
  return {
    id: 1, title: 'Contrôle technique Clio', date: '2027-03-01',
    category: 'action', status: 'pending', manual: false,
    originFieldKey: 'nextInspection', ...over,
  };
}

describe('doublons certains', () => {
  it('reconnaît le même champ d\'origine à la même date', () => {
    const m = findDuplicate(
      { title: 'Libellé différent', date: '2027-03-01', originFieldKey: 'nextInspection' },
      [item()],
    );
    expect(m.kind).toBe('exact');
  });

  it('reconnaît le même intitulé à la même date, sans champ d\'origine', () => {
    const m = findDuplicate({ title: 'contrôle technique clio', date: '2027-03-01' }, [item()]);
    expect(m.kind).toBe('exact');
  });

  it('ignore les accents et la ponctuation', () => {
    const m = findDuplicate({ title: 'CONTROLE TECHNIQUE — CLIO', date: '2027-03-01' }, [item()]);
    expect(m.kind).toBe('exact');
  });
});

describe('doublons probables', () => {
  it('reconnaît un intitulé inversé à date voisine', () => {
    const m = findDuplicate(
      { title: 'Clio : contrôle technique', date: '2027-03-02' },
      [item()],
    );
    expect(m.kind).toBe('probable');
  });

  it('ne rapproche pas deux événements distants de plus de trois jours', () => {
    const m = findDuplicate({ title: 'Contrôle technique Clio', date: '2027-03-20' }, [item()]);
    expect(m.kind).toBe('none');
  });

  it('ne rapproche pas deux événements de nature différente', () => {
    const m = findDuplicate({ title: 'Fin de garantie lave-linge', date: '2027-03-01' }, [item()]);
    expect(m.kind).toBe('none');
  });
});

describe('similarité de titres', () => {
  it('vaut 1 pour deux chaînes identiques', () => {
    expect(titleSimilarity('controle technique', 'controle technique')).toBe(1);
  });

  it('reste élevée malgré une inversion de mots', () => {
    expect(titleSimilarity('controle technique clio', 'clio controle technique'))
      .toBeGreaterThan(0.7);
  });

  it('reste faible pour deux sujets différents', () => {
    expect(titleSimilarity('controle technique', 'fin de garantie')).toBeLessThan(0.4);
  });
});
