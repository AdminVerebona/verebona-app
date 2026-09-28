/**
 * Rendu (serveur, sans DOM) des blocs de l'accueil, du menu latéral et du
 * champ Verebona — Direction D v2. Le harnais n'a pas de bibliothèque de
 * test DOM : `renderToStaticMarkup` suffit à vérifier structure et libellés.
 */
import { describe, it, expect, vi } from 'vitest';

// Hors routeur Next (rendu serveur isolé) : navigation simulée.
vi.mock('next/navigation', () => ({
  usePathname: () => '/accueil',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeAssets, RecentDocuments, UpcomingEvents, VerebonaWork } from '../HomeBlocks';
import { AppSidebar } from '@/components/shell/AppSidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VerebonaSpaceProvider } from '@/components/verebona/space/VerebonaSpaceProvider';
import { VerebonaHeaderField, VerebonaMobileField } from '@/components/verebona/space/VerebonaField';
import type { HomeAsset } from '@/services/home/HomeSummaryService';

// Le harnais (environnement node) compile le JSX en `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const asset = (id: number, name: string, extra: Partial<HomeAsset> = {}): HomeAsset => ({
  id, name, category: 'VEHICULE', subtype: 'Voiture', status: 'EN_SERVICE', thumbnailUrl: null, signedThumbnailUrl: null,
  documentCount: 4, documentLabels: [], todoCount: 0, ...extra,
});
const noop = () => {};

describe('Mes biens', () => {
  it('bento (lot 8) : 1 grande carte, 3 tuiles, « Tous les biens » ; pastille d’action', () => {
    const html = renderToStaticMarkup(h(HomeAssets, {
      onAddAsset: noop,
      assets: [
        asset(1, 'Ferrari Testarossa', { todoCount: 1 }),
        asset(2, 'Appartement Lyon', { category: 'IMMOBILIER', subtype: 'T3', signedThumbnailUrl: 'https://s3/lyon.jpg' }),
        asset(3, 'Vélo Cargo'), asset(4, 'Planche de surf'), asset(5, 'Cinquième'),
      ],
    }));
    expect(html).toContain('Récemment consultés');
    expect(html).toContain('row-span-2');
    expect(html).toContain('grid-cols-3');
    expect(html.indexOf('Appartement Lyon')).toBeLessThan(html.indexOf('Ferrari Testarossa'));
    expect(html).toContain('Tous les biens');
    expect(html).toContain('1 action à faire');
    expect(html).not.toContain('Cinquième');
    expect(html).toContain('https://s3/lyon.jpg');
  });

  it('compte vide : amorce et trois tuiles en pointillés', () => {
    const html = renderToStaticMarkup(h(HomeAssets, { assets: [], onAddAsset: noop }));
    expect(html).toContain('Une maison ou un appartement');
    expect(html).toContain('Un véhicule');
    expect(html).toContain('Un objet de valeur');
    expect(html).toContain('border-dashed');
  });
});

describe('Ce que j’ai fait', () => {
  it('frise, moment, lien d’action ; « Toute l’activité »', () => {
    const html = renderToStaticMarkup(h(VerebonaWork, {
      onNavigate: noop,
      items: [{ id: 'a', kind: 'deadline', text: 'J’ai identifié une nouvelle échéance.', at: new Date().toISOString(), tone: 'green', cta: 'Voir dans l’agenda', target: { kind: 'agenda', id: 1 } }],
    }));
    expect(html).toContain('Ce que j’ai fait');
    expect(html).toContain('Toute l’activité');
    expect(html).toContain('J’ai identifié une nouvelle échéance.');
    expect(html).toContain('Voir dans l’agenda');
    expect(html).toContain('Aujourd’hui');
  });

  it('rien encore : encadré en pointillés', () => {
    const html = renderToStaticMarkup(h(VerebonaWork, { items: [], onNavigate: noop }));
    expect(html).toContain('Rien pour l’instant. Dès votre premier document');
  });
});

describe('Prochaines échéances', () => {
  it('lignes : pastille de date, titre, bien, délai ; lien « Mon agenda » ; 3 au plus', () => {
    const e = (id: number, title: string, tone: 'red' | 'amber' | 'green', rel: string) =>
      ({ id, title, assetName: 'Ferrari Testarossa', date: '2026-10-12', day: '12', month: 'oct.', rel, tone, forecast: false });
    const html = renderToStaticMarkup(h(UpcomingEvents, { items: [e(1, 'Révision annuelle', 'red', 'En retard (2 j)'), e(2, 'Contrôle technique', 'amber', 'Dans 2 semaines'), e(3, 'Bail', 'green', 'Dans 3 mois'), e(4, 'Quatrième', 'green', 'Dans 1 an')] }));
    expect(html).toContain('Prochaines échéances');
    expect(html).toContain('href="/agenda"');
    expect(html).toContain('En retard (2 j)');
    expect(html).toContain('oct.');
    expect(html).not.toContain('Quatrième');
  });

  it('vide : message d’amorce', () => {
    expect(renderToStaticMarkup(h(UpcomingEvents, { items: [] }))).toContain('Aucune échéance pour l’instant. Elles apparaîtront ici dès que je les aurai lues dans vos documents.');
  });
});

describe('Documents récents', () => {
  it('tuiles : statut, titre, bien, type · date', () => {
    const html = renderToStaticMarkup(h(RecentDocuments, {
      onUpload: noop,
      docs: [{ id: 1, title: 'Carte grise', assetId: 3, assetName: 'Ferrari Testarossa', typeLabel: 'Administratif', date: '2026-09-02', status: 'En analyse', tone: 'slate' }],
    }));
    expect(html).toContain('Tous les documents');
    expect(html).toContain('En analyse');
    expect(html).toContain('Administratif · 02/09/2026');
  });

  it('compte vide : zone de dépôt', () => {
    const html = renderToStaticMarkup(h(RecentDocuments, { docs: [], onUpload: noop }));
    expect(html).toContain('Déposez une facture, un contrat, une garantie ou une notice');
    expect(html).toContain('Déposer un premier document');
  });
});

describe('menu latéral', () => {
  const props = { pathname: '/accueil', onToggle: noop, userName: 'Léa Martin', initials: 'LM', planLabel: 'Premium Duo' };

  it('déplié : logo, entrées, pastille, pied avatar + nom + offre', () => {
    const html = renderToStaticMarkup(h(TooltipProvider, null, h(AppSidebar, { ...props, collapsed: false, toProcessCount: 2 })));
    expect(html).toContain('aria-label="Réduire le menu"');
    expect(html).toContain('Mon agenda');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Léa Martin');
    expect(html).toContain('Premium Duo');
    expect(html).toMatch(/>2</);
    expect(html).toContain('width:240px');
  });

  it('replié : 64 px, libellés en infobulle, pastille sur l’icône ; aucune pastille à zéro', () => {
    const html = renderToStaticMarkup(h(TooltipProvider, null, h(AppSidebar, { ...props, collapsed: true, toProcessCount: 0 })));
    expect(html).toContain('aria-label="Déployer le menu"');
    expect(html).toContain('width:64px');
    expect(html).not.toContain('>Mon agenda<');
    expect(html).toContain('aria-label="Mon agenda"');
    expect(html).not.toMatch(/bg-\[color:var\(--vb-red-500\)\]/);
  });
});

describe('champ Verebona', () => {
  it('desktop : mascotte, champ, ⌘K au repos, envoi', () => {
    const html = renderToStaticMarkup(h(VerebonaSpaceProvider, null, h(VerebonaHeaderField)));
    expect(html).toContain('placeholder="Demander à Verebona"');
    expect(html).toContain('⌘K');
    expect(html).toContain('aria-label="Envoyer"');
    expect(html).toContain('/mascot/welcome-wave.webp');
    expect(html).toContain('width:min(420px');
  });

  it('mobile : pilule « Demander à Verebona »', () => {
    const html = renderToStaticMarkup(h(VerebonaSpaceProvider, null, h(VerebonaMobileField)));
    expect(html).toContain('Demander à Verebona');
    expect(html).toContain('/mascot/welcome-wave.webp');
  });
});
