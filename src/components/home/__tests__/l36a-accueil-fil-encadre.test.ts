/**
 * Lot 36A — page d'accueil « Fil encadré » (maquette « Accueil -
 * Propositions », direction 2a sombre / 2b clair), desktop ET mobile.
 *
 *   AC36A-1 : ordre unique Mascotte → Mes biens → Prochaines échéances →
 *             Ce que j'ai fait → Documents récents, sans paire côte à côte ;
 *   AC36A-2 : chaque section dans une carte bordée, titre h2 en petites
 *             capitales, lien à droite (libellé long desktop / court mobile) ;
 *   AC36A-3 : carrousels (biens, documents) : liste focalisable, flèches
 *             gauche / droite, boutons précédent / suivant nommés ;
 *   AC36A-4 : en-tête mascotte : date du jour, « Bonjour, <nom> » (h1),
 *             bulle (texte, gras, actions), pastilles de suggestions SOUS la
 *             bulle ; compte vide et chargement conservés ;
 *   AC36A-5 : échéances : pastille de date (jour + mois), couleur
 *             d'urgence, délai coloré ; Ce que j'ai fait : libellé du jour ;
 *   AC36A-6 : thèmes : aucune couleur en dur dans les classes (variables des
 *             deux thèmes), squelettes et états d'erreur conservés.
 *
 * Rendu serveur (`renderToStaticMarkup`, sans DOM) + lecture des sources.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HomeAsset } from '@/services/home/HomeSummaryService';
import type { VerebonaWorkItem } from '@/services/home/home-blocks';

vi.mock('next/navigation', () => ({
  usePathname: () => '/accueil',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const mascot = vi.hoisted(() => ({ presentation: null as unknown, failed: false }));
vi.mock('@/components/home/useMascotPresentation', () => ({
  useMascotPresentation: () => ({ presentation: mascot.presentation, failed: mascot.failed, refresh: async () => {}, trackClick: () => {} }),
  prefetchMascotPresentation: () => {},
}));
vi.mock('@/components/verebona/space/VerebonaSpaceProvider', () => ({ useVerebonaSpace: () => null }));
vi.mock('@/contexts/WriteGuardContext', () => ({ useWriteGuard: () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} }) }));

(globalThis as { React?: typeof React }).React = React;

const { HomeAssets, UpcomingEvents, VerebonaWork, RecentDocuments, HomeCarousel, HomeSection } = await import('../HomeBlocks');
const { MascotSpeaks } = await import('../MascotSpeaks');
const { greetingDateLong } = await import('@/lib/mascot-greeting');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const noop = () => {};
const asset = (id: number, name: string): HomeAsset => ({
  id, name, category: 'VEHICULE', subtype: 'Voiture', status: 'EN_SERVICE', thumbnailUrl: null, signedThumbnailUrl: null,
  documentCount: 3, documentLabels: [], todoCount: 0,
});
const doc = (id: number) => ({ id, title: `Document ${id}`, assetId: 1, assetName: 'Polo', typeLabel: 'Facture', date: '2026-07-31', status: null, tone: 'slate' as const });
const up = (id: number, tone: 'red' | 'amber' | 'green', rel: string) =>
  ({ id, title: `Échéance ${id}`, assetName: 'Cupra', date: '2028-04-18', day: '18', month: 'avr.', rel, tone, forecast: false });
const hier = new Date(Date.now() - 86_400_000).toISOString();
const work = (id: string, at: string): VerebonaWorkItem => ({ id, kind: 'fields', text: `Action ${id}`, at, tone: 'blue', cta: 'Voir la fiche', target: { kind: 'asset', assetId: 1 } });

describe('AC36A-1 — ordre unique, desktop et mobile', () => {
  const page = read('src/app/(dashboard)/accueil/page.tsx');

  it('AC36A-1 — Mascotte, Mes biens, Prochaines échéances, Ce que j’ai fait, Documents récents', () => {
    const order = ['<MascotSpeaks', '<HomeAssets', '<UpcomingEvents', '<VerebonaWork', '<RecentDocuments'].map((s) => page.indexOf(s));
    expect(order.every((x) => x > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('AC36A-1 / L49A-T4 — plus de paire côte à côte ni d’ordre qui change selon la largeur ; colonne centrée, largeur des autres pages', () => {
    expect(page).not.toMatch(/@container|@min-\[1040px\]|order-1|order-2|grid-cols-2/);
    // Lot 49A : plus de limite à 960 px ; gouttières du <main> des autres pages (p-4 md:p-6 lg:p-8).
    expect(page).not.toContain('max-w-[960px]');
    expect(page).toMatch(/const HOME_COLUMN = '[^']*max-w-\[1440px\][^']*px-4[^']*md:px-6[^']*lg:px-8/);
    expect(page).toContain('mx-auto');
    // Place pour la barre de navigation du bas et le « + » (mobile).
    expect(page).toContain('pb-36');
  });
});

describe('AC36A-2 — sections en cartes bordées', () => {
  const cases: Array<[string, string, string, string | null]> = [
    ['home-biens', 'Mes biens', 'Tous les biens', 'Tous'],
    ['home-echeances', 'Prochaines échéances', 'Mon agenda', 'Agenda'],
    ['home-fait', 'Ce que j’ai fait', 'Toute l’activité', 'Tout'],
    ['home-docs', 'Documents récents', 'Tous les documents', 'Tous'],
  ];
  const html = {
    'home-biens': renderToStaticMarkup(h(HomeAssets, { assets: [asset(1, 'Polo')], onAddAsset: noop })),
    'home-echeances': renderToStaticMarkup(h(UpcomingEvents, { items: [up(1, 'green', 'Dans 2 ans')] })),
    'home-fait': renderToStaticMarkup(h(VerebonaWork, { items: [work('a', hier)], onNavigate: noop })),
    'home-docs': renderToStaticMarkup(h(RecentDocuments, { docs: [doc(1)], onUpload: noop })),
  } as Record<string, string>;

  it.each(cases)('AC36A-2 — %s : carte bordée, h2 en petites capitales, lien long / court', (id, title, long, short) => {
    const s = html[id];
    expect(s).toMatch(new RegExp(`^<section aria-labelledby="${id}" data-home-section="${id}" class="[^"]*rounded-\\[14px\\] border border-\\[color:var\\(--border\\)\\] bg-\\[color:var\\(--bg-card\\)\\]`));
    expect(s).toContain(`<h2 id="${id}" class="m-0 text-[11px] font-semibold uppercase tracking-[.05em] text-[color:var(--text-muted)]">${title}</h2>`);
    if (short) expect(s).toContain(`<span class="md:hidden">${short}</span><span class="hidden md:inline">${long}</span>`);
    else expect(s).toMatch(new RegExp(`>${long}</a>`));
  });

  it('AC36A-2 — liens : /assets, /agenda, /mon-compte/enrichissements, /documents', () => {
    expect(html['home-biens']).toContain('href="/assets"');
    expect(html['home-echeances']).toContain('href="/agenda"');
    expect(html['home-fait']).toContain('href="/mon-compte/enrichissements"');
    expect(html['home-docs']).toContain('href="/documents"');
  });

  it('AC36A-2 — états vides conservés dans la carte (raccourcis d’ajout, dépôt de document)', () => {
    const biens = renderToStaticMarkup(h(HomeAssets, { assets: [], onAddAsset: noop }));
    expect(biens).toContain('data-home-section="home-biens"');
    expect(biens).toContain('Un véhicule');
    expect(biens).not.toContain('href="/assets"'); // pas de lien sans bien
    const docs = renderToStaticMarkup(h(RecentDocuments, { docs: [], onUpload: noop }));
    expect(docs).toContain('data-home-section="home-docs"');
    expect(docs).toContain('Déposer un premier document');
    expect(docs).toContain('Déposez une facture, un contrat, une garantie ou une notice');
  });

  it('AC36A-2 — HomeSection sans lien : seulement le titre', () => {
    const s = renderToStaticMarkup(h(HomeSection, { id: 'x', title: 'Titre', children: 'contenu' }));
    expect(s).not.toContain('<a ');
    expect(s).toContain('contenu');
  });
});

describe('AC36A-3 — carrousels', () => {
  it('AC36A-3 — Mes biens : liste focalisable nommée, calée au défilement, flèches nommées, ordre reçu', () => {
    const s = renderToStaticMarkup(h(HomeAssets, { assets: [asset(1, 'Polo'), asset(2, 'Cupra'), asset(3, 'Maison')], onAddAsset: noop }));
    expect(s).toMatch(/<ul aria-label="Mes biens" tabindex="0" class="[^"]*snap-x snap-mandatory[^"]*overflow-x-auto/);
    expect(s).toContain('aria-label="Mes biens : précédents"');
    expect(s).toContain('aria-label="Mes biens : suivants"');
    expect(s.indexOf('Polo')).toBeLessThan(s.indexOf('Cupra'));
    expect(s.indexOf('Cupra')).toBeLessThan(s.indexOf('Maison'));
    // Dimensions de la maquette : 150 × 104 mobile, 204 × 140 desktop.
    expect(s).toContain('h-[104px] w-[150px] md:h-[140px] md:w-[204px]');
  });

  it('AC36A-3 — au plus 12 biens dans le carrousel', () => {
    const s = renderToStaticMarkup(h(HomeAssets, { assets: Array.from({ length: 15 }, (_, i) => asset(i + 1, `Bien n°${i + 1}`)), onAddAsset: noop }));
    expect(s).toContain('Bien n°12');
    expect(s).not.toContain('Bien n°13');
  });

  it('AC36A-3 — flèches : desktop seulement et seulement en cas de débordement (masquées au rendu serveur)', () => {
    const s = renderToStaticMarkup(h(HomeCarousel, { label: 'Essai', children: h('li', null, 'a') }));
    const prev = /<button type="button" aria-label="Essai : précédents" disabled="" class="([^"]*)"/.exec(s);
    expect(prev).not.toBeNull();
    expect(prev![1]).toContain('hidden');
    expect(prev![1]).not.toContain('md:flex');
  });

  it('AC36A-3 — clavier : flèches gauche / droite font défiler ; mouvement réduit respecté', () => {
    const src = read('src/components/home/HomeBlocks.tsx');
    expect(src).toMatch(/e\.key === 'ArrowRight'\) \{ e\.preventDefault\(\); scroll\(1\); \}/);
    expect(src).toMatch(/e\.key === 'ArrowLeft'\) \{ e\.preventDefault\(\); scroll\(-1\); \}/);
    expect(src).toContain("prefers-reduced-motion: reduce");
  });

  it('AC36A-3 / L49A-T4 — Documents récents : 3 visibles sur mobile, 4 sur desktop, 6 sur très grand écran, nom puis bien · date', () => {
    const s = renderToStaticMarkup(h(RecentDocuments, { docs: [doc(1), doc(2), doc(3), doc(4), doc(5), doc(6), doc(7)], onUpload: noop }));
    expect(s).toMatch(/<ul aria-label="Documents récents" tabindex="0"/);
    expect(s.match(/w-\[calc\(\(100%-20px\)\/3\)\] flex-shrink-0 snap-start md:w-\[calc\(\(100%-36px\)\/4\)\] 2xl:w-\[calc\(\(100%-60px\)\/6\)\]/g)).toHaveLength(6);
    expect(s.indexOf('Document 1')).toBeLessThan(s.indexOf('Polo · 31/07/2026'));
  });
});

describe('AC36A-4 — en-tête mascotte', () => {
  const props = { greetingName: 'Geo', empty: false, onCreateAsset: noop, onUploadDocument: noop, pageSuggestions: ['Quelles échéances arrivent bientôt ?'] };

  it('AC36A-4 — date du jour, « Bonjour/Bonsoir, Geo » en h1, bulle puis pastilles SOUS la bulle', () => {
    mascot.presentation = { contextHash: 'h', subjects: [], secondaries: [], todo: null };
    mascot.failed = false;
    const s = renderToStaticMarkup(h(MascotSpeaks, props));
    expect(s).toContain(greetingDateLong(new Date()));
    expect(s).toMatch(/<h1 [^>]*>(Bonjour|Bonsoir), Geo<\/h1>/);
    const bulle = s.indexOf('data-mascot-bubble');
    const pastilles = s.indexOf('aria-label="Ou demandez-moi"');
    expect(bulle).toBeGreaterThan(s.indexOf('<h1'));
    expect(pastilles).toBeGreaterThan(bulle);
    expect(s).toContain('>Quelles échéances arrivent bientôt ?</button>');
    // Mobile : mascotte 72 px et salutation à côté ; desktop : mascotte 112 px.
    expect(s).toContain('grid-cols-[72px_minmax(0,1fr)]');
    expect(s).toContain('md:grid-cols-[112px_minmax(0,1fr)]');
    expect(s).toContain('width="112"');
    expect(s).toContain('width="72"');
  });

  it('AC36A-4 — chargement : squelette DANS la bulle, jamais de texte remplacé', () => {
    mascot.presentation = null;
    mascot.failed = false;
    const s = renderToStaticMarkup(h(MascotSpeaks, props));
    expect(s).toContain('aria-label="Chargement du message"');
    expect(s.indexOf('data-mascot-bubble')).toBeLessThan(s.indexOf('Chargement du message'));
  });

  it('AC36A-4 — compte vide : texte d’accueil et tuiles d’ajout dans la bulle', () => {
    mascot.presentation = null;
    const s = renderToStaticMarkup(h(MascotSpeaks, { ...props, empty: true }));
    const bulle = s.indexOf('data-mascot-bubble');
    expect(s.indexOf('Ajouter un premier bien')).toBeGreaterThan(bulle);
    expect(s.indexOf('Déposer un document')).toBeGreaterThan(bulle);
    expect(s.indexOf('Ajouter un premier bien')).toBeLessThan(s.indexOf('aria-label="Ou demandez-moi"'));
  });

  it('AC36A-4 — comportement conservé : actions MASC2, choix, télémétrie, retrait immédiat', () => {
    const src = read('src/components/home/MascotSpeaks.tsx');
    expect(src).toContain('aria-label="Sujets à traiter"');
    expect(src).toContain('onClick={() => openItem(it)}');
    expect(src).toContain('<TodoChoicesDialog');
    expect(src).toMatch(/run\(s\.secondary\.action, s\.secondary, 'secondary'\)/);
    expect(src).toContain('{greetingWord(now)}, {greetingName}');
  });
});

describe('AC36A-5 — échéances et activité', () => {
  it('AC36A-5 — pastille jour + mois, couleur d’urgence (vert lointain, amber proche, rouge en retard), délai coloré', () => {
    const s = renderToStaticMarkup(h(UpcomingEvents, { items: [up(1, 'green', 'Dans 2 ans'), up(2, 'amber', 'Dans 3 semaines'), up(3, 'red', 'En retard (2 j)')] }));
    expect(s).toContain('>18</span>');
    expect(s).toContain('>avr.</span>');
    expect(s).toMatch(/background:var\(--wash-green\);color:var\(--on-green\)/);
    expect(s).toMatch(/background:var\(--wash-amber\);color:var\(--on-amber\);border-color:var\(--edge-amber\)/);
    expect(s).toMatch(/background:var\(--wash-red\);color:var\(--on-red\)/);
    expect(s).toMatch(/style="color:var\(--on-green\)">Dans 2 ans</);
    // 3 lignes desktop, 2 mobile.
    expect(s.match(/class="hidden md:block"/g)).toHaveLength(1);
  });

  it('AC36A-5 — Ce que j’ai fait : un libellé par jour, puis les puces cliquables', () => {
    const s = renderToStaticMarkup(h(VerebonaWork, { items: [work('a', new Date().toISOString()), work('b', hier), work('c', hier)], onNavigate: noop }));
    expect(s.match(/>Aujourd’hui</g)).toHaveLength(1);
    expect(s.match(/>Hier</g)).toHaveLength(1);
    expect(s.indexOf('Aujourd’hui')).toBeLessThan(s.indexOf('Action a'));
    expect(s.indexOf('>Hier<')).toBeLessThan(s.indexOf('Action b'));
    expect(s.match(/<button type="button"/g)).toHaveLength(3);
  });
});

describe('AC36A-6 — thèmes, squelettes, erreurs', () => {
  it('AC36A-6 — aucune couleur en dur dans les classes de l’accueil (variables des thèmes sombre et beige)', () => {
    for (const f of ['src/components/home/HomeBlocks.tsx', 'src/components/home/MascotSpeaks.tsx', 'src/app/(dashboard)/accueil/page.tsx']) {
      const src = read(f);
      expect(src, f).not.toMatch(/(?:bg|text|border|from|to|ring)-\[#[0-9a-fA-F]{3,8}\]/);
      expect(src, f).not.toContain('.theme-beige_&');
    }
    const ms = read('src/components/home/MascotSpeaks.tsx');
    expect(ms).toContain("color-mix(in srgb, var(--accent) 9%, var(--bg-page))");
  });

  it('AC36A-6 — squelettes adaptés (en-tête et quatre cartes), erreur / réessayer et « Actualisation impossible » conservés', () => {
    const page = read('src/app/(dashboard)/accueil/page.tsx');
    expect(page).toContain('<HomeHeaderSkeleton />');
    expect(page).toContain('<HomeSectionsSkeleton />');
    expect(page).toContain('Impossible de charger vos biens et documents');
    expect(page).toContain('Actualisation impossible, affichage des dernières données reçues.');
    for (const d of ['<UnifiedDocumentDialog', '<AssetFormDialog', '<PendingCheckoutModal', 'joinDuo(duoToken)', 'pending_transfer_token', 'session_id']) {
      expect(page).toContain(d);
    }
  });
});
