/**
 * Formulaire « Informations complémentaires » — liste structurée : rendu
 * serveur (sans navigateur) du composant de lignes répétables.
 *   · une carte par ligne, numérotée, avec monter / descendre / supprimer ;
 *   · compteur « n / max », bouton d'ajout désactivé au plafond ;
 *   · erreurs affichées sous la cellule concernée, message de liste ;
 *   · colonne technique (origine d'un point fort) jamais affichée ;
 *   · lecture seule : ni bouton d'ajout, ni commandes de ligne.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findField, type ListItem } from '@/lib/assets/additional-infos';

// Harnais en environnement `node` : le JSX compilé par Vitest (runtime classique) lit `React` global.
(globalThis as { React?: typeof React }).React = React;
const { AdditionalInfosListField } = await import('../AdditionalInfosListField');

const damages = findField('claim', 'damages')!;
const highlights = findField('commercial', 'highlights')!;
const REFS = {
  documents: [{ id: 21, title: 'Devis peinture', typeLabel: 'Devis', date: '2026-08-19', format: 'PDF', sensitive: false, occupantData: false }],
  photos: [{ id: 5, fileId: 105, caption: 'Auréoles', date: '2026-08-03', isPrimary: false }],
  claimEvents: [],
  highlightSuggestions: [],
};

const html = (props: Partial<Parameters<typeof AdditionalInfosListField>[0]> & { def: typeof damages; items: ListItem[] }) =>
  renderToStaticMarkup(createElement(AdditionalInfosListField, {
    onChange: () => {}, rowErrors: {}, listError: null, references: REFS, idPrefix: 't', ...props,
  })).replace(/&#x27;/g, "'");

describe('AdditionalInfosListField', () => {
  it('lignes numérotées, commandes de ligne, compteur et bouton d’ajout', () => {
    const out = html({ def: damages, items: [{ id: 'a', zone: 'Salle de bain', photoIds: [5] }, { id: 'b', zone: 'Chambre 2' }] });
    expect(out).toContain('Dommage 1');
    expect(out).toContain('Dommage 2');
    expect(out).toContain('2 / 30');
    expect(out).toContain('value="Salle de bain"');
    expect(out).toContain('aria-label="Monter dommage 2"');
    expect(out).toContain('aria-label="Supprimer dommage 1"');
    expect(out).toContain('1 photo liée');
    expect(out).toContain('Ajouter un dommage');
  });

  it('erreurs sous la cellule et message de liste', () => {
    const out = html({ def: damages, items: [{ id: 'a', element: 'Plafond' }], rowErrors: { a: { zone: 'Champ requis.' } }, listError: '30 lignes au plus.' });
    expect(out).toContain('Champ requis.');
    expect(out).toContain('30 lignes au plus.');
    expect(out).toMatch(/aria-invalid="true"/);
  });

  it('plafond atteint (4 points forts) : ajout désactivé ; origine jamais affichée', () => {
    const items = [1, 2, 3, 4].map((i) => ({ id: `h${i}`, title: `Point ${i}`, origin: 'suggestion:maintenance' }));
    const out = html({ def: highlights, items });
    expect(out).toContain('4 / 4');
    expect(out).toContain('4 au plus');
    expect(out).not.toContain('suggestion:maintenance');
    expect(out).not.toContain('>Origine<');
  });

  it('liste vide : aide affichée ; lecture seule : aucune commande', () => {
    expect(html({ def: highlights, items: [] })).toContain('Sans point fort choisi, le kit reprend les faits documentés');
    const ro = html({ def: damages, items: [{ id: 'a', zone: 'SDB' }], readOnly: true });
    expect(ro).not.toContain('Ajouter un dommage');
    expect(ro).not.toContain('Supprimer dommage 1');
  });
});
