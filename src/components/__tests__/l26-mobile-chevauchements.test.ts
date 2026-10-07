/**
 * Lot 26 — point 10 : sur mobile, ni le bandeau « Analyse en cours… Voir »
 * ni le suivi « Envoi de documents » ne recouvrent le contenu ou la barre
 * basse.
 *
 * L26-10-AC1 : le bandeau mobile est DANS LE FLUX (pas `fixed`) — il réserve
 *              sa hauteur sous la barre haute, le titre de la page reste visible.
 * L26-10-AC2 : il est rendu entre la barre haute mobile et la zone de
 *              défilement de la colonne (DashboardLayout).
 * L26-10-AC3 : sur mobile, le suivi d'envoi se pose au-dessus de la barre
 *              basse et de son « + » (marge sûre comprise) ; desktop inchangé.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;

const etat = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/contexts/AnalysisBannerContext', () => ({
  useAnalysisBanner: () => ({ analyzingCount: 1, analyzingFileIds: [42], analysisStartTimes: {} }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => etat.mobile }));
vi.mock('@/hooks/useFileDepot', () => ({
  useFileDepot: () => ({
    elements: [{ operationId: 'op', nom: 'facture.pdf', etape: 'termine', progression: 1, reprise: null, fichierDisponible: true, erreur: null }],
    enCours: 0,
  }),
}));

const { MobileAnalysisBanner } = await import('../AnalysisBanner');
const { UploadQueueIndicator, POSITION_MOBILE } = await import('../documents/UploadQueueIndicator');

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

describe('suivi « Envoi de documents »', () => {
  it('L26-10-AC3 : mobile — au-dessus de la barre basse et du « + »', () => {
    etat.mobile = true;
    const html = renderToStaticMarkup(h(UploadQueueIndicator, { userId: 1 }));
    expect(html).toContain('Envoi de documents');
    expect(html).toContain(POSITION_MOBILE);
    expect(html).not.toMatch(/\bbottom-24\b/);
    // Même marge sûre que la barre basse, et une base qui dépasse sa hauteur
    // hors marge : 8 (marge haute) + 44 (« + » débordant) + 78 (barre) = 130 px.
    const nav = lire('src/components/mobile/bottom-navigation.tsx');
    expect(nav).toContain('pb-[max(20px,env(safe-area-inset-bottom))]');
    expect(POSITION_MOBILE).toContain('max(20px,env(safe-area-inset-bottom))');
    const base = Number(POSITION_MOBILE.match(/calc\(([\d.]+)rem/)?.[1]) * 16;
    expect(base).toBeGreaterThanOrEqual(130 + 8);
  });

  it('L26-10-AC3 : desktop inchangé (coin bas droit)', () => {
    etat.mobile = false;
    const html = renderToStaticMarkup(h(UploadQueueIndicator, { userId: 1 }));
    expect(html).toMatch(/right-4 bottom-4 w-\[360px\]/);
    expect(html).not.toContain(POSITION_MOBILE);
  });
});
