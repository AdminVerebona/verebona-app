/**
 * Lot 75N — rendu statique du tiroir « Données du compte » (vues pures) :
 * états absent / NULL / masqué / non chargé visibles, copie par champ et par
 * ligne (boutons accessibles), relations navigables au clavier, longues
 * tables repliées à l'écran mais intégrales dans la structure copiée.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { columnField, masked, notLoaded, type DossierSection } from '@/services/admin/account-data/model';

(globalThis as { React?: typeof React }).React = React;
const { SectionCard, SCREEN_ROWS } = await import('../DossierView');

const noop = () => undefined;
const csvName = (id: string) => `${id}.csv`;

describe('L75N-UI01 champs : états explicites et copie', () => {
  const s: DossierSection = {
    id: 'identite', tab: 'synthese', title: 'Identité', fields: [
      columnField('equipments', 'purchase_price_cents', 116583, undefined, 'Prix miroir'),
      columnField('equipments', 'estimated_value_cents', null, undefined, 'Valeur estimée'),
      columnField('equipments', 'inexistante', undefined, undefined, 'Absente'),
      columnField('asset_files', 's3_key', masked('clé de stockage'), undefined, 'Clé'),
      columnField('asset_files', 'x', notLoaded('borne'), undefined, 'Non chargée'),
      columnField('equipments', 'key_characteristics', { acquisitionPrice: 1165.83 }, undefined, 'Fiche'),
    ],
  };
  const html = renderToStaticMarkup(h(SectionCard, { s, onNavigate: noop, csvName }));
  it('valeur affichée + brute, et les quatre états non-valeur distincts', () => {
    expect(html).toContain('1 165,83 €');
    expect(html).toContain('brut : 116583');
    expect(html).toContain('data-cell-state="null"');
    expect(html).toContain('data-cell-state="absent"');
    expect(html).toContain('data-cell-state="masked"');
    expect(html).toContain('data-cell-state="not_loaded"');
    expect(html).toContain('NULL en base');
    expect(html).toContain('masqué — clé de stockage');
    expect(html).toContain('equipments.purchase_price_cents');
  });
  it('JSON dépliable ; un bouton « Copier » nommé par champ, plus copie / CSV de section', () => {
    expect(html).toContain('<details');
    expect(html).toContain('aria-label="Copier Prix miroir"');
    expect(html.match(/aria-label="Copier /g)?.length).toBe(6 + 1);
    expect(html).toContain('aria-label="Télécharger la section « Identité » en CSV"');
  });
});

describe('L75N-UI02 relations et tables', () => {
  it('relations : boutons (clavier), identifiant copiable', () => {
    const html = renderToStaticMarkup(h(SectionCard, { s: { id: 'rel', tab: 'relations', title: 'Relations', relations: [
      { type: 'document', id: 789, label: 'Facture d’acquisition', nature: 'source', status: null, origin: 'DOCUMENT_EXTRACTION', via: 'field_evidence.source_id' },
    ] }, onNavigate: noop, csvName }));
    expect(html).toMatch(/<button type="button"[^>]*>.*Document #789 — Facture d’acquisition/);
    expect(html).toContain('aria-label="Copier l’identifiant 789"');
  });
  it(`table longue : ${SCREEN_ROWS} lignes à l’écran, « Afficher les N lignes », copie par ligne`, () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, value_json: { n: i }, s3_key: masked('clé de stockage') }));
    const html = renderToStaticMarkup(h(SectionCard, { s: { id: 'ev', tab: 'preuves', title: 'Preuves', table: { table: 'field_evidence', columns: ['id', 'value_json', 's3_key'], rows, total: 120, complete: true, limit: 2000 } }, onNavigate: noop, csvName }));
    expect(html.match(/<tr class="border-b/g)).toHaveLength(SCREEN_ROWS);
    expect(html).toContain('Afficher les 120 lignes');
    expect(html).toContain('120 ligne(s) extraite(s) sur 120 en base');
    expect(html).toContain('aria-label="Copier la ligne 1 (JSON)"');
  });
  it('section en erreur : « non chargé » explicite', () => {
    const html = renderToStaticMarkup(h(SectionCard, { s: { id: 'x', tab: 'preuves', title: 'X', error: 'lecture impossible (57014)' }, onNavigate: noop, csvName }));
    expect(html).toContain('non chargé — lecture impossible (57014)');
  });
});
