/**
 * Bloc « Annonces de vente » de l'écran de préparation (VENTE-RULE-002, lot 19).
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Harnais en environnement `node` : le JSX compilé (runtime classique) lit `React` global.
(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { SaleAdsPanel, SALE_AD_REVIEW_MESSAGE } = await import('../SaleAdsPanel');

const html = (priceMissing: boolean) => renderToStaticMarkup(createElement(SaleAdsPanel, {
  ads: { short: 'Vélo cargo : Urban Arrow.', detailed: 'Présentation\n\nCaractéristiques :\n- Année : 2022', priceMissing, generatedBy: 'deterministic' },
})).replace(/&#x27;/g, "'");

describe('SaleAdsPanel', () => {
  it('deux annonces, un bouton « Copier » chacune, rappel de relecture', () => {
    const out = html(false);
    expect(out).toContain('Annonce courte');
    expect(out).toContain('Annonce détaillée');
    expect(out).toContain('Vélo cargo : Urban Arrow.');
    expect(out.match(/>Copier</g)).toHaveLength(2);
    expect(out).toContain(SALE_AD_REVIEW_MESSAGE.slice(0, 30));
    expect(out).toContain('Relisez avant publication');
    expect(out).not.toContain('Aucun prix');
  });

  it('prix absent : invitation à le saisir, jamais de prix inventé', () => {
    expect(html(true)).toContain('Aucun prix n’est indiqué');
  });
});
