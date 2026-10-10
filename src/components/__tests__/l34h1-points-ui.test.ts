/**
 * Lot 34 H1 — quatre points UI.
 *
 *   AC1-x  : accueil mobile, « Documents récents » en carrousel de vignettes ;
 *   AC2-x  : espace Verebona mobile, champ EN HAUT et panneau dessous (comme desktop) ;
 *   AC9-x  : page 404 avec la mascotte, sans bloc de diagnostic visible ;
 *   AC10-x : « Mon compte » — Gestion des notifications avant la Zone dangereuse (dernière).
 *
 * Rendu serveur (`renderToStaticMarkup`, sans DOM) + lecture des sources.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/navigation', () => ({
  usePathname: () => '/r/INCONNU',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

// Espace Verebona ouvert sur mobile : contexte simulé (le vrai fournisseur démarre fermé).
const fakeApi = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/verebona/space/VerebonaSpaceProvider', () => ({
  useVerebonaSpace: () => fakeApi.current,
}));

(globalThis as { React?: typeof React }).React = React;

const { RecentDocuments } = await import('@/components/home/HomeBlocks');
const { VerebonaMobileSpace } = await import('@/components/verebona/space/VerebonaField');
const NotFound = (await import('@/app/not-found')).default;

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const noop = () => {};
const doc = (id: number, extra: Record<string, unknown> = {}) => ({
  id, title: `Document ${id}`, assetId: null, assetName: 'Polo', typeLabel: 'Facture', date: '2026-07-31', status: null, tone: 'slate' as const, ...extra,
});

/** Partie mobile du bloc (après le marqueur du carrousel). */
const mobilePart = (html: string) => html.slice(html.lastIndexOf('<ul', html.indexOf('aria-label="Documents récents"')));

describe('point 1 — Documents récents mobile en vignettes', () => {
  it('AC1-1 — carrousel horizontal de grandes vignettes arrondies, calé au défilement, mobile seulement', () => {
    const html = renderToStaticMarkup(h(RecentDocuments, { onUpload: noop, docs: [doc(1), doc(2), doc(3), doc(4)] }));
    const mobile = mobilePart(html);
    expect(mobile).toMatch(/<ul class="[^"]*overflow-x-auto[^"]*snap-x|<ul class="[^"]*snap-x[^"]*overflow-x-auto/);
    expect(mobile).toContain('md:hidden');
    expect(mobile).toContain('vb-no-scrollbar');
    // Cartes à largeur fixe (la suivante dépasse à droite), vignette carrée arrondie.
    expect(mobile.match(/w-\[148px\] flex-shrink-0 snap-start/g)?.length).toBe(5); // 4 documents + « Tous les documents »
    expect(mobile).toContain('aspect-square');
    expect(mobile).toContain('rounded-[18px]');
    expect(mobile).toContain('Tous les documents');
    expect(mobile).toContain('Polo · 31/07/2026');
    // Plus de lignes-cartes.
    expect(html).not.toContain('min-h-[60px] items-center gap-3 rounded-2xl');
  });

  it('AC1-2 — performance : même URL signée que le bureau, chargement paresseux, aucun original ni rendu PDF', () => {
    const url = 'https://s3/derivatives/thumbnails/a_1/f_1/list-x.webp?X-Amz-Signature=s';
    const html = renderToStaticMarkup(h(RecentDocuments, { onUpload: noop, docs: [doc(1, { previewUrl: url }), doc(2)] }));
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2); // tuile bureau + vignette mobile, la même miniature serveur
    for (const img of imgs) {
      expect(img).toContain('src="https://s3/derivatives/thumbnails/a_1/f_1/list-x.webp');
      expect(img).toContain('loading="lazy"');
      expect(img).toContain('decoding="async"');
    }
    const src = read('src/components/home/HomeBlocks.tsx');
    expect(src).not.toMatch(/pdfjs|react-pdf|\/view\b|useThumbnailUrl\(d\.id/);
  });

  it('AC1-3 — sans miniature : icône de repli, statut sur la vignette', () => {
    const html = renderToStaticMarkup(h(RecentDocuments, { onUpload: noop, docs: [doc(5, { status: 'En analyse' })] }));
    const mobile = mobilePart(html);
    expect(mobile).not.toContain('<img');
    expect(mobile).toContain('lucide-file-text');
    expect(mobile).toContain('En analyse');
  });

  it('AC1-4 — bureau inchangé : 4 tuiles en grille', () => {
    const html = renderToStaticMarkup(h(RecentDocuments, { onUpload: noop, docs: [doc(1), doc(2), doc(3), doc(4), doc(5)] }));
    expect(html).toContain('hidden grid-cols-4 gap-3 md:grid');
    expect(html).not.toContain('Document 5');
  });
});

describe('point 2 — champ Verebona mobile en haut, comme desktop', () => {
  const api = (extra: Record<string, unknown> = {}) => ({
    isOpen: true, isDesktop: false, showThread: false, turns: [], pose: 'neutral', recent: [{ id: 1, title: 'Polo' }],
    suggestions: [{ id: 's1', label: 'Quelles échéances arrivent bientôt ?' }], draft: '', live: [], liveLoading: false, activeLive: -1,
    v: { online: true, isLoading: false, hasOlder: false, loadingOlder: false },
    registerInput: noop, setDraft: noop, close: noop, newRequest: noop, ask: () => false, resume: noop, removeRecent: noop,
    ...extra,
  });

  it('AC2-1 — le champ précède le panneau (suggestions, recherches récentes)', () => {
    fakeApi.current = api();
    const html = renderToStaticMarkup(h(VerebonaMobileSpace));
    const champ = html.indexOf('<input');
    expect(champ).toBeGreaterThan(-1);
    expect(champ).toBeLessThan(html.indexOf('Quelles échéances arrivent bientôt ?'));
    expect(champ).toBeLessThan(html.indexOf('Recherches récentes'));
    expect(html).toContain('data-field-position="top"');
    // Le champ est dans l'en-tête, plus de barre de saisie en pied.
    expect(html.indexOf('<header')).toBeLessThan(champ);
    expect(champ).toBeLessThan(html.indexOf('</header>'));
  });

  it('AC2-2 — correspondances pendant la frappe en tête du panneau (même ordre que desktop)', () => {
    fakeApi.current = api({
      draft: 'pol', live: [{ id: 'a1', kind: 'asset', title: 'Polo', href: '/assets/1' }],
    });
    const html = renderToStaticMarkup(h(VerebonaMobileSpace));
    expect(html.indexOf('<input')).toBeLessThan(html.indexOf('Correspondances'));
    const content = read('src/components/verebona/space/SpaceContent.tsx');
    expect(content).not.toContain("variant === 'mobile' && suggestions");
    expect(content).not.toContain("variant === 'desktop' && suggestions");
    expect(content).toMatch(/el\.scrollTop = saisie \|\| turns\.length === 0 \? 0 : el\.scrollHeight/);
  });

  it('AC2-3 — clavier iOS : police 16 px (pas de zoom), encart de la barre d’état, « Nouvelle demande » sous le champ', () => {
    fakeApi.current = api({ showThread: true, turns: [{ id: 't1', question: 'Polo', answers: [], pending: false }] });
    const html = renderToStaticMarkup(h(VerebonaMobileSpace));
    expect(html).toMatch(/<input[^>]*text-\[16px\]/);
    expect(html).toMatch(/enterkeyhint="send"/i);
    expect(html).toContain('env(safe-area-inset-top)');
    expect(html.indexOf('<input')).toBeLessThan(html.indexOf('Nouvelle demande'));
  });

  it('AC2-4 — desktop inchangé : champ du header, panneau accroché dessous', () => {
    const field = read('src/components/verebona/space/VerebonaField.tsx');
    expect(field).toContain('export function VerebonaHeaderField()');
    expect(field).toContain('top-[66px]');
  });
});

describe('point 9 — page 404 avec la mascotte', () => {
  it('AC9-1 — mascotte, titre, boutons Tableau de bord / Accueil', () => {
    const html = renderToStaticMarkup(h(NotFound));
    expect(html).toContain('/mascot/questioning.webp');
    expect(html).toContain('404');
    expect(html).toContain('Page introuvable');
    expect(html).toMatch(/href="\/accueil"[^>]*>Tableau de bord/);
    expect(html).toMatch(/href="\/"[^>]*>Accueil/);
  });

  it('AC9-2 — plus de bloc de diagnostic visible (journalisé en console)', () => {
    const html = renderToStaticMarkup(h(NotFound));
    for (const t of ['DIAGNOSTIC', 'HTTP_404', '/r/INCONNU', 'production', 'NODE_ENV']) expect(html).not.toContain(t);
    expect(read('src/app/not-found.tsx')).toMatch(/console\.warn\('\[404\]'/);
  });

  it('AC9-3 — thème clair et sombre : jetons du design, aucune couleur de fond codée en dur', () => {
    const src = read('src/app/not-found.tsx');
    expect(src).toContain('bg-[color:var(--bg-page)]');
    expect(src).toContain('text-[color:var(--text-primary)]');
    expect(src).not.toMatch(/#020617|#0f172a|#1e293b/);
  });
});

describe('point 10 — Mon compte', () => {
  it('AC10-1 — « Gestion des notifications » (renommé)', () => {
    const card = read('src/components/account/NotificationsCard.tsx');
    expect(card).toContain('title="Gestion des notifications"');
    expect(card).not.toContain('title="Notifications"');
  });

  it('AC10-2 — notifications AVANT la Zone dangereuse, qui est le dernier bloc', () => {
    const page = read('src/app/(dashboard)/mon-compte/page.tsx');
    const infos = read('src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx');
    // Les blocs de fin de page passent par l'emplacement rendu avant la Zone dangereuse.
    const slot = page.slice(page.indexOf('beforeDangerZone={'), page.indexOf('</>', page.indexOf('<LegalInformationCard')));
    for (const c of ['<NotificationsCard />', '<WithdrawalCard />', '<MyDataCard />', '<LegalInformationCard />']) expect(slot).toContain(c);
    expect(page.indexOf('<LegalInformationCard')).toBeLessThan(page.lastIndexOf('</div>'));
    const rendu = infos.slice(infos.indexOf('const profileChanged'));
    const avant = rendu.indexOf('{beforeDangerZone && ');
    const zone = rendu.indexOf('<DeleteAccountCard');
    expect(avant).toBeGreaterThan(-1);
    expect(avant).toBeLessThan(zone);
    // Rien après la Zone dangereuse dans le rendu.
    const fin = rendu.slice(zone, rendu.indexOf('/* ──', zone));
    expect(fin.replace(/<DeleteAccountCard[\s\S]*?\/>/, '').replace(/[\s)};]|<\/div>|return|\(/g, '')).toBe('');
  });
});
