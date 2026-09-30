/**
 * CDC 15 T2-31 — support vérifiable de chaque affirmation (serveur).
 */
import { describe, it, expect } from 'vitest';
import { extractDataTokens, verifyClaimSupport } from '../claim-support';
import type { RetrievedSource } from '@/services/verebona-assistant/types/sources';

const champ: RetrievedSource = {
  id: 'asset_field:42:mileage', type: 'asset_field', title: 'Clio — Kilométrage', content: 'Kilométrage : 48 250 km',
  meta: { assetId: 42, fieldKey: 'mileage', value: 48250, display: '48 250 km', origin: 'USER' },
};
const facture: RetrievedSource = {
  id: 'doc_88', type: 'document', title: 'Facture draisienne', content: 'Achat le 24/04/2026 pour 129,90 € — immatriculation AB-123-CD.',
};

describe('extractDataTokens', () => {
  it('normalise dates, nombres et codes', () => {
    const t = extractDataTokens('Le 24 avril 2026, 48 250 km, 1 234,56 €, plaque AB-123-CD, le 2026-04-24.');
    expect([...t.dates]).toEqual(expect.arrayContaining(['2026-04-24', '04-24']));
    expect([...t.numbers]).toEqual(expect.arrayContaining(['48250', '1234.56', '2026']));
    expect([...t.codes]).toContain('AB123CD');
  });
});

describe('verifyClaimSupport', () => {
  it('donnée présente dans la source citée : soutenue', () => {
    expect(verifyClaimSupport({ text: 'Votre Clio affiche 48 250 km.', sourceIds: [champ.id] }, [champ]))
      .toMatchObject({ supported: true, reason: 'SUPPORTED_BY_DATA' });
    expect(verifyClaimSupport({ text: 'Achat le 24 avril 2026.', sourceIds: ['doc_88'] }, [facture]).supported).toBe(true);
  });

  it('sourceId valide mais valeur absente de la source : REJETÉE (T2-31)', () => {
    const r = verifyClaimSupport({ text: 'Votre Clio affiche 52 000 km.', sourceIds: [champ.id] }, [champ]);
    expect(r).toMatchObject({ supported: false, reason: 'DATA_NOT_IN_SOURCES' });
    expect(r.missing).toEqual(['52000']);
  });

  it('valeur présente seulement dans une source NON citée : rejetée', () => {
    expect(verifyClaimSupport({ text: 'Achat pour 129,90 €.', sourceIds: [champ.id] }, [champ, facture]).supported).toBe(false);
  });

  it('phrase qualitative : soutenue par ses sources', () => {
    expect(verifyClaimSupport({ text: 'La facture concerne la draisienne.', sourceIds: ['doc_88'] }, [facture]))
      .toMatchObject({ supported: true, reason: 'SUPPORTED_QUALITATIVE' });
  });

  it('aucune source connue : NO_SOURCE', () => {
    expect(verifyClaimSupport({ text: 'x', sourceIds: ['doc_999'] }, [facture]).reason).toBe('NO_SOURCE');
  });

  it('support déclaré « field » : valeur égale à celle de asset_field (X)', () => {
    expect(verifyClaimSupport({
      text: 'Kilométrage : 48 250 km.', sourceIds: [champ.id], support: { kind: 'field', sourceId: champ.id, value: '48 250 km' },
    }, [champ]).reason).toBe('SUPPORTED_BY_DECLARED_SUPPORT');
    expect(verifyClaimSupport({
      text: 'Kilométrage : 48 250 km.', sourceIds: [champ.id], support: { kind: 'field', sourceId: champ.id, value: '51 000 km' },
    }, [champ]).reason).toBe('SUPPORT_NOT_IN_SOURCE');
  });

  it('support « field » : identifiant de champ mal formé refusé, même typé asset_field', () => {
    const faux: RetrievedSource = { ...champ, id: 'asset_42' };
    expect(verifyClaimSupport({
      text: 'Kilométrage : 48 250 km.', sourceIds: ['asset_42'], support: { kind: 'field', sourceId: 'asset_42', value: '48 250 km' },
    }, [faux]).reason).toBe('SUPPORT_NOT_IN_SOURCE');
  });

  it('support « excerpt » : extrait littéral présent ; source du support non citée : rejet', () => {
    expect(verifyClaimSupport({
      text: 'Achat le 24/04/2026.', sourceIds: ['doc_88'], support: { kind: 'excerpt', sourceId: 'doc_88', text: 'Achat le 24/04/2026' },
    }, [facture]).supported).toBe(true);
    expect(verifyClaimSupport({
      text: 'Achat le 24/04/2026.', sourceIds: ['doc_88'], support: { kind: 'excerpt', sourceId: 'doc_88', text: 'Livraison le 30/04/2026' },
    }, [facture]).reason).toBe('SUPPORT_NOT_IN_SOURCE');
    expect(verifyClaimSupport({
      text: 'Achat le 24/04/2026.', sourceIds: ['doc_88'], support: { kind: 'excerpt', sourceId: champ.id, text: '48 250' },
    }, [facture, champ]).reason).toBe('SUPPORT_SOURCE_NOT_CITED');
  });

  it('support « table_cell » : valeur de la cellule présente dans la source', () => {
    const tableau: RetrievedSource = { id: 'doc_9', type: 'document', title: 'Devis', content: '| Poste | Montant |\n| Pose | 480 € |' };
    expect(verifyClaimSupport({
      text: 'La pose coûte 480 €.', sourceIds: ['doc_9'],
      support: { kind: 'table_cell', sourceId: 'doc_9', table: { index: 0, row: 1, column: 1 }, value: '480 €' },
    }, [tableau]).supported).toBe(true);
  });

  it('un identifiant n’est jamais une preuve : « 55 € » face à fileId: 55 est rejeté', () => {
    const doc: RetrievedSource = { id: 'doc_55', type: 'document', title: 'Facture garage', content: 'Vidange effectuée.', meta: { fileId: 55, assetId: 55, documentId: 55 } };
    expect(verifyClaimSupport({ text: 'La vidange a coûté 55 €.', sourceIds: ['doc_55'] }, [doc]))
      .toMatchObject({ supported: false, reason: 'DATA_NOT_IN_SOURCES' });
  });

  it('montant en centimes converti en euros : accepté ; la valeur brute en centimes, non', () => {
    const doc: RetrievedSource = { id: 'doc_7', type: 'document_extraction', title: 'Facture garage', content: 'Vidange.', meta: { fileId: 7, amountCents: 12990 } };
    expect(verifyClaimSupport({ text: 'La facture s’élève à 129,90 €.', sourceIds: ['doc_7'] }, [doc]).supported).toBe(true);
    expect(verifyClaimSupport({ text: 'La facture s’élève à 12 990 €.', sourceIds: ['doc_7'] }, [doc]).supported).toBe(false);
  });

  it('comptes et totaux portés par les sources serveur (dépenses, chronologie, échéances) : lus', () => {
    const dep: RetrievedSource = {
      id: 'expenses:maintenance:3', type: 'document_extraction', title: 'Dépenses d’entretien', content: 'total incomplet',
      meta: { theme: 'maintenance', totalCents: 45000, totalEur: 450, documentCount: 2, unqualifiedCount: 1, includedDocuments: 'doc-55 doc-56' },
    };
    expect(verifyClaimSupport({ text: 'Vous avez dépensé 450 € en entretien sur 2 documents.', sourceIds: [dep.id] }, [dep]).supported).toBe(true);
    // Un total calculé par le modèle sans source serveur : rejeté.
    expect(verifyClaimSupport({ text: 'Au total, 520 € de dépenses.', sourceIds: [dep.id] }, [dep]).supported).toBe(false);
    const tl: RetrievedSource = { id: 'timeline:asset_1:1', type: 'agenda_item', title: 'Chronologie', content: '2026-04-24 Achat', meta: { timeline: true, events: 3, from: '2026-04-24', to: '2026-09-12' } };
    expect(verifyClaimSupport({ text: 'La chronologie compte 3 événements, jusqu’au 12/09/2026.', sourceIds: [tl.id] }, [tl]).supported).toBe(true);
    const up: RetrievedSource = { id: 'upcoming_agenda:account', type: 'agenda_item', title: 'Échéances à venir', content: '2026-11-02 · Contrôle technique', meta: { count: 4 } };
    expect(verifyClaimSupport({ text: 'Vous avez 4 échéances à venir.', sourceIds: [up.id] }, [up]).supported).toBe(true);
  });
});
