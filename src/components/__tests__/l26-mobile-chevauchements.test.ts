/**
 * Lot 26 — point 10 : sur mobile, ni le bandeau « Analyse en cours… Voir »
 * ni le suivi « Envoi de documents » ne recouvrent le contenu ou la barre
 * basse.
 *
 * L26-10-AC1 : le bandeau mobile est DANS LE FLUX (pas `fixed`) — il réserve
 *              sa hauteur sous la barre haute, le titre de la page reste visible.
 * L26-10-AC2 : il est rendu entre la barre haute mobile et la zone de
 *              défilement de la colonne (DashboardLayout).
 * L26-10-AC3 : (caduc) le suivi flottant « Envoi de documents » a été
 *              supprimé au lot 31 (L31-5, `l31-5-envoi-sans-toast.test.ts`) :
 *              il ne peut plus recouvrir la barre basse.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;

vi.mock('@/contexts/AnalysisBannerContext', () => ({
  useAnalysisBanner: () => ({ analyzingCount: 1, analyzingFileIds: [42], analysisStartTimes: {} }),
}));

const { MobileAnalysisBanner } = await import('../AnalysisBanner');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8');

describe('bandeau « Analyse en cours » mobile', () => {
  it('L26-10-AC1 : dans le flux, jamais superposé', () => {
    const html = renderToStaticMarkup(h(MobileAnalysisBanner));
    expect(html).toContain('data-mobile-analysis-banner');
    expect(html).toContain('Analyse en cours');
    expect(html).toContain('Voir');
    const classes = html.match(/data-mobile-analysis-banner[^>]*class="([^"]+)"/)?.[1] ?? '';
    expect(classes.split(/\s+/)).not.toContain('fixed');
    expect(classes.split(/\s+/).filter((c) => /^(top-|absolute$|sticky$)/.test(c))).toEqual([]);
    expect(classes.split(/\s+/)).toEqual(expect.arrayContaining(['md:hidden', 'flex', 'flex-shrink-0']));
  });

  it('L26-10-AC2 : placé entre la barre haute mobile et la zone de défilement', () => {
    const src = lire('src/components/DashboardLayout.tsx');
    const barreHaute = src.indexOf('<VerebonaMobileField />');
    const bandeau = src.indexOf('<MobileAnalysisBanner />');
    const defilement = src.indexOf('id="main-scroll-container"');
    expect(barreHaute).toBeGreaterThan(0);
    expect(bandeau).toBeGreaterThan(barreHaute);
    expect(defilement).toBeGreaterThan(bandeau);
  });
});
