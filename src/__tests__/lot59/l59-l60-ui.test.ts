/**
 * Lot 59 (points 1 à 5) et lot 60A (points 6 et 7) — retours UI du 15/10.
 *
 *  L59-1  compte vide : « Ajouter un premier bien » / « Déposer un document »
 *         ouvrent DIRECTEMENT les formulaires du menu « + Ajouter » (garde
 *         d'écriture standard, quota), plus de détour par T2 ;
 *  L59-2  vignette d'un bien : la vignette choisie, sinon la première photo
 *         rattachée (accueil, liste des biens, fiche) ;
 *  L59-3  Centre d'aide : nouvel onglet du navigateur (site public), jamais
 *         dans l'application, desktop ET mobile ;
 *  L59-4  « À traiter » : « Ouvrir » remplace « Compléter » ;
 *  L59-5  agenda d'un bien : vues Liste / Mensuel / Annuel, comme « Mon
 *         agenda » (même sélecteur, mêmes grilles) ;
 *  L60-6  « À traiter » : vue Liste supprimée, préférence héritée ignorée ;
 *  L60-7  propositions longues : retour à la ligne, aucun débordement.
 *
 * Environnement `node` : rendu serveur (`renderToStaticMarkup`), logique
 * pure et lecture des sources pour le contrat responsive (desktop et mobile
 * sont le MÊME composant, classes adaptatives).
 */
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/accueil',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
const mascot = vi.hoisted(() => ({ presentation: null as unknown }));
vi.mock('@/components/home/useMascotPresentation', () => ({
  useMascotPresentation: () => ({ presentation: mascot.presentation, failed: false, refresh: async () => {}, trackClick: () => {} }),
  prefetchMascotPresentation: () => {},
}));
const space = vi.hoisted(() => ({ askLocal: vi.fn(), close: vi.fn(), ask: vi.fn() }));
vi.mock('@/components/verebona/space/VerebonaSpaceProvider', () => ({ useVerebonaSpace: () => space }));
vi.mock('@/contexts/WriteGuardContext', () => ({ useWriteGuard: () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} }) }));
(globalThis as { React?: typeof React }).React = React;

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const noop = () => {};

// ── L59-1 ──────────────────────────────────────────────────────────────────
describe('L59-1 — compte vide : les tuiles ouvrent directement les formulaires d’ajout', () => {
  it('L59-1a — « Ajouter un premier bien » : garde (quota biens) puis formulaire d’ajout de bien, sans T2', async () => {
    const { emptyStartTiles } = await import('@/components/home/MascotSpeaks');
    const calls: string[] = [];
    const tiles = emptyStartTiles({
      garder: (f, quota) => { calls.push(`garde:${quota}`); f(); },
      closeSpace: () => calls.push('fermer'),
      onCreateAsset: () => calls.push('bien'),
      onUploadDocument: (id) => calls.push(`document:${id}`),
    });
    expect(tiles.map((t) => t.label)).toEqual(['Ajouter un premier bien', 'Déposer un document']);
    tiles[0].go();
    expect(calls).toEqual(['fermer', 'garde:assets', 'bien']);
  });

  it('L59-1b — « Déposer un document » : garde (quota documents) puis tiroir d’ajout de document, aucun bien imposé', async () => {
    const { emptyStartTiles } = await import('@/components/home/MascotSpeaks');
    const calls: string[] = [];
    emptyStartTiles({
      garder: (f, quota) => { calls.push(`garde:${quota}`); f(); },
      closeSpace: () => calls.push('fermer'),
      onCreateAsset: () => calls.push('bien'),
      onUploadDocument: (id) => calls.push(`document:${id}`),
    })[1].go();
    expect(calls).toEqual(['fermer', 'garde:documents', 'document:null']);
  });

  it('L59-1c — écriture refusée (fin d’essai, quota) : aucun formulaire ouvert', async () => {
    const { emptyStartTiles } = await import('@/components/home/MascotSpeaks');
    const open = vi.fn();
    const tiles = emptyStartTiles({ garder: () => { /* refus : fenêtre habituelle */ }, closeSpace: noop, onCreateAsset: open, onUploadDocument: open });
    tiles.forEach((t) => t.go());
    expect(open).not.toHaveBeenCalled();
  });

  it('L59-1d — plus de panneau T2 « Je crée la fiche… / Créer la fiche du bien » ; accueil = mêmes formulaires que « + Ajouter »', async () => {
    const src = lire('src/components/home/MascotSpeaks.tsx');
    expect(src).not.toContain('Créer la fiche du bien');
    expect(src).not.toContain('Choisir un fichier');
    const page = lire('src/app/(dashboard)/accueil/page.tsx');
    expect(page).toContain("LazyAssetFormDialog as AssetFormDialog, LazyUnifiedDocumentDialog as UnifiedDocumentDialog } from '@/components/mobile/add-forms'");
    const menu = lire('src/components/mobile/mobile-actions-sheet.tsx');
    expect(menu).toContain('<LazyUnifiedDocumentDialog');
    expect(menu).toContain('<LazyAssetFormDialog');
    // Rendu (desktop et mobile : même grille) : les deux tuiles dans la bulle, rien ouvert au rendu.
    const { MascotSpeaks } = await import('@/components/home/MascotSpeaks');
    mascot.presentation = null;
    const html = renderToStaticMarkup(h(MascotSpeaks, { greetingName: 'Test', empty: true, onCreateAsset: noop, onUploadDocument: noop, pageSuggestions: [] }));
    expect(html).toContain('Ajouter un premier bien');
    expect(html).toContain('Déposer un document');
    expect(space.askLocal).not.toHaveBeenCalled();
  });

  it('L59-1e — contrôles de rappel T6 de l’accueil conservés', () => {
    const src = lire('src/components/home/MascotSpeaks.tsx');
    expect(src).toContain('<T6ReminderActions');
    expect(src).toContain("import { T6ReminderActions } from './T6ReminderControls';");
  });
});

// ── L59-2 ──────────────────────────────────────────────────────────────────
describe('L59-2 — vignette par défaut : la première photo rattachée au bien', async () => {
  const { pickDefaultAssetPhotos, effectiveThumbnailUrl, defaultPhotoRank } = await import('@/services/assets/default-asset-photo');
  const { displayThumbnailKey } = await import('@/lib/assets/display-thumbnail');
  const f = (id: number, over: Partial<Parameters<typeof pickDefaultAssetPhotos>[1][number]> = {}) => ({
    id, assetId: 1, linkedAssetId: null, mimeType: 'image/jpeg', documentTypeCode: 'PHOTO', s3Key: `k/${id}.jpg`,
    uploadedAt: new Date(2026, 0, id), ...over,
  });

  it('L59-2a — photo rattachée : vignette par défaut ; la plus ancienne d’abord (stable), puis l’identifiant', () => {
    const m = pickDefaultAssetPhotos([1], [f(3), f(2), f(4)]);
    expect(m.get(1)).toEqual({ fileId: 2, s3Key: 'k/2.jpg' });
    const egal = pickDefaultAssetPhotos([1], [f(9, { uploadedAt: null }), f(8, { uploadedAt: null })]);
    expect(egal.get(1)?.fileId).toBe(8);
  });

  it('L59-2b — jamais une facture scannée ni un format non affichable ; photo classée avant image non classée', () => {
    expect(defaultPhotoRank({ mimeType: 'image/jpeg', documentTypeCode: 'INVOICE', s3Key: 'k' })).toBeNull();
    expect(defaultPhotoRank({ mimeType: 'image/heic', documentTypeCode: 'PHOTO', s3Key: 'k' })).toBeNull();
    expect(defaultPhotoRank({ mimeType: 'image/tiff', documentTypeCode: 'PHOTO', s3Key: 'k' })).toBeNull();
    expect(defaultPhotoRank({ mimeType: 'image/svg+xml', documentTypeCode: null, s3Key: 'k' })).toBeNull();
    expect(defaultPhotoRank({ mimeType: 'application/pdf', documentTypeCode: 'PHOTO', s3Key: 'k' })).toBeNull();
    const m = pickDefaultAssetPhotos([1], [f(1, { documentTypeCode: 'INVOICE' }), f(2, { documentTypeCode: null }), f(5, { documentTypeCode: 'PHOTO' })]);
    expect(m.get(1)?.fileId).toBe(5);
    expect(pickDefaultAssetPhotos([1], [f(1, { documentTypeCode: 'INVOICE' })]).size).toBe(0);
  });

  it('L59-2c — rattachement par colonne secondaire ou lien N-N ; bien non demandé ignoré', () => {
    const m = pickDefaultAssetPhotos([2, 3], [f(1, { assetId: 1, linkedAssetId: 2 }), f(2, { assetId: 1, otherAssetIds: [3] })]);
    expect(m.get(2)?.fileId).toBe(1);
    expect(m.get(3)?.fileId).toBe(2);
    expect(m.has(1)).toBe(false);
  });

  it('L59-2d — la vignette choisie l’emporte toujours ; sans photo ni vignette : l’icône', () => {
    expect(effectiveThumbnailUrl('choisie.webp', { fileId: 1, s3Key: 'k/1.jpg' })).toBe('choisie.webp');
    expect(effectiveThumbnailUrl(null, { fileId: 1, s3Key: 'k/1.jpg' })).toBe('k/1.jpg');
    expect(effectiveThumbnailUrl(null, undefined)).toBeNull();
    expect(displayThumbnailKey({ thumbnailUrl: null, effectiveThumbnailUrl: 'k/1.jpg' })).toBe('k/1.jpg');
    // Vignette changée sur la fiche (mise à jour locale) : affichée sans attendre la relecture.
    expect(displayThumbnailKey({ thumbnailUrl: 'nouvelle.webp', effectiveThumbnailUrl: 'k/1.jpg' })).toBe('nouvelle.webp');
    expect(displayThumbnailKey({ thumbnailUrl: null })).toBeNull();
  });

  it('L59-2e — accueil, liste des biens et fiche (desktop et mobile) affichent la vignette effective ; la route signée applique la même règle', () => {
    expect(lire('src/components/home/HomeBlocks.tsx')).toContain('displayThumbnailKey(asset)');
    expect(lire('src/app/(dashboard)/assets/page.tsx')).toContain('useThumbnailUrl(asset.id, displayThumbnailKey(asset))');
    expect(lire('src/app/(dashboard)/assets/[id]/page.tsx')).toContain('displayThumbnailKey(asset)');
    expect(lire('src/services/home/HomeSummaryService.ts')).toContain('effectiveThumbnailUrl: effectiveThumbnailUrl(asset.thumbnailUrl, defaultPhotos.get(asset.id))');
    const api = lire('src/app/api/assets/route.ts');
    expect(api.match(/effectiveThumbnailUrl: effectiveThumbnailUrl\(/g)).toHaveLength(2);
    const route = lire('src/app/api/assets/[id]/thumbnail/route.ts');
    expect(route).toContain('loadDefaultAssetPhotos(session.currentAccountId, [assetId])');
    // Le cache serveur des URL signées dépend de la clé résolue (vignette changée : jamais resservie).
    expect(route).toContain('const cacheKey = `${session.currentAccountId}-${assetId}-${s3Key}`;');
    // Aucun import `@/db` côté client.
    expect(lire('src/lib/assets/display-thumbnail.ts')).not.toMatch(/^import /m);
  });
});

// ── L59-3 ──────────────────────────────────────────────────────────────────
describe('L59-3 — Centre d’aide : nouvel onglet du navigateur, jamais dans l’application', async () => {
  const { helpPathFromAppHref, openHelpFromLink, openHelpCenter } = await import('@/lib/help-center/open');
  const { openDrawerFromLink } = await import('@/lib/drawers');
  const { publicSiteUrl } = await import('@/lib/external-urls');

  const avecFenetre = (fn: (open: ReturnType<typeof vi.fn>) => void) => {
    const open = vi.fn();
    const g = globalThis as { window?: unknown };
    const avant = g.window;
    g.window = { open, dispatchEvent: noop };
    try { fn(open); } finally { g.window = avant; }
  };

  it('L59-3a — liens internes de l’assistant vers l’aide : page publique correspondante', () => {
    expect(helpPathFromAppHref('/aide')).toBe('/aide');
    expect(helpPathFromAppHref('/aide?page=%2Faide%2Fcreer-un-bien&retour=%2Fassets')).toBe('/aide/creer-un-bien');
    expect(helpPathFromAppHref('/aide/creer-un-bien')).toBe('/aide/creer-un-bien');
    expect(helpPathFromAppHref('/aide?q=agenda')).toBe('/aide?q=agenda');
    expect(helpPathFromAppHref('/aide?page=javascript:alert(1)')).toBe('/aide');
    expect(helpPathFromAppHref('/assets/12')).toBeNull();
    expect(helpPathFromAppHref('/aidez-moi')).toBeNull();
  });

  it('L59-3b — « Ouvrir le Centre d’aide » et liens d’aide : window.open(site public, _blank, noopener)', () => {
    avecFenetre((open) => {
      openHelpCenter('/aide');
      expect(open).toHaveBeenCalledWith(publicSiteUrl('/aide'), '_blank', 'noopener,noreferrer');
      const e = { preventDefault: vi.fn() };
      expect(openDrawerFromLink(e, '/aide?page=%2Faide%2Fcreer-un-bien')).toBe(true);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(open).toHaveBeenLastCalledWith(publicSiteUrl('/aide/creer-un-bien'), '_blank', 'noopener,noreferrer');
      // Un lien qui n'est pas l'aide n'est pas détourné.
      expect(openHelpFromLink({ preventDefault: noop }, '/agenda')).toBe(false);
      expect(open).toHaveBeenCalledTimes(2);
    });
  });

  it('L59-3c — « Besoin d’aide ? » : même ouverture sur ordinateur ET mobile (plus de Centre d’aide intégré)', () => {
    const modal = lire('src/components/help/HelpModal.tsx');
    expect(modal).toContain('openHelpCenter(path)');
    expect(modal).not.toMatch(/prefersIntegratedHelp|integratedHelpHref|router\.push/);
    expect(lire('src/components/verebona/space/VerebonaSpaceProvider.tsx')).toContain('openHelpFromLink(null, r.href)');
  });
});

// ── L59-4 / L60-6 / L60-7 ──────────────────────────────────────────────────
describe('« À traiter » — Ouvrir, cartes seules, propositions longues', async () => {
  const { ActionCard, PROPOSAL_BUTTON_CLASS } = await import('@/components/to-process/ActionCard');
  type View = Parameters<typeof ActionCard>[0]['action'];
  const action = (over: Partial<View> = {}): View => ({
    publicId: 'a1b2c3d4-0001', targetType: 'AGENDA_ITEM', targetId: 7, fieldKey: null, relationKey: null,
    actionKind: 'COMPLETE', priority: 'DO_NEXT', ruleCode: 'R', question: 'Quelle est la date ?', proposals: [],
    target: { label: 'Entretien' }, ...over,
  });

  it('L59-4 — « Ouvrir » remplace « Compléter » (bouton seul et saisie en ligne)', () => {
    const seul = renderToStaticMarkup(h(ActionCard, { action: action(), onChoose: noop, onOpenTarget: noop, visual: true }));
    expect(seul).toMatch(/>Ouvrir<\/button>/);
    expect(seul).not.toContain('Compléter');
    const enLigne = renderToStaticMarkup(h(ActionCard, { action: action({ inputType: 'date' }), onChoose: noop, onOpenTarget: noop }));
    expect(enLigne).toMatch(/>Ouvrir<\/button>/);
    expect(enLigne).not.toContain('Compléter');
  });

  it('L60-6a — la bascule Cartes / Liste et la variante liste ont disparu', async () => {
    const page = lire('src/components/to-process/ToProcessQueue.tsx');
    expect(page).not.toMatch(/ActionRow|aria-label="Présentation"|> Liste|LayoutGrid|choosePresentation/);
    expect(page).not.toMatch(/localStorage\.(getItem|setItem)/);
    expect(page).toMatch(/<ActionCard[\s\S]*?visual\s*\/>/);
    expect('ActionRow' in (await import('@/components/to-process/ActionCard'))).toBe(false);
  });

  it('L60-6b — préférence « Liste » déjà mémorisée : ignorée (Cartes) et effacée ; stockage indisponible sans effet', async () => {
    const { forgetLegacyPresentation, LEGACY_PRESENTATION_KEY } = await import('@/components/to-process/ToProcessQueue');
    const store = new Map([[LEGACY_PRESENTATION_KEY, 'LIST'], ['autre', 'x']]);
    forgetLegacyPresentation({ removeItem: (k: string) => { store.delete(k); } });
    expect(store.has(LEGACY_PRESENTATION_KEY)).toBe(false);
    expect(store.get('autre')).toBe('x');
    expect(() => forgetLegacyPresentation({ removeItem: () => { throw new Error('SecurityError'); } })).not.toThrow();
    expect(() => forgetLegacyPresentation(null)).not.toThrow();
  });

  it('L60-7 — propositions longues : retour à la ligne, libellé sur plusieurs lignes, largeur bornée à la carte', () => {
    const longues = action({
      actionKind: 'ARBITRATE', question: 'Cet événement est-il déjà dans l’agenda ?',
      proposals: [
        { value: 'SAME:1', label: 'Oui, « Entretien réalisé — Peugeot 3008 Hybrid - 2022 » du 19/10/2025' },
        { value: 'SAME:2', label: 'Oui, « Réparation — Intervention » du 19/10/2025' },
        { value: 'NEW', label: 'Non, ajouter un nouvel événement', isCurrentValue: true },
      ],
    });
    for (const visual of [true, false]) { // file « À traiter » (vignette) et choix de la mascotte
      const html = renderToStaticMarkup(h(ActionCard, { action: longues, onChoose: noop, onOpenTarget: noop, visual }));
      expect(html).toContain('data-proposals="true" class="flex min-w-0 max-w-full flex-wrap items-center gap-2"');
      const boutons = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?data-proposal-label[\s\S]*?<\/button>/g) ?? [];
      expect(boutons).toHaveLength(3);
      for (const b of boutons) {
        const cls = /class="([^"]+)"/.exec(b)![1].split(' ');
        for (const c of ['h-auto', 'min-h-9', 'max-w-full', 'whitespace-normal']) expect(cls).toContain(c);
        // Ni hauteur fixe ni ligne unique (cause du chevauchement).
        expect(cls).not.toContain('h-9');
        expect(cls).not.toContain('h-8');
        expect(cls).not.toContain('whitespace-nowrap');
        expect(b).not.toContain('truncate');
      }
      expect(html).toContain('[overflow-wrap:anywhere]');
      expect(html).toContain('Entretien réalisé — Peugeot 3008 Hybrid - 2022');
      expect(html).toContain('(actuelle)');
    }
    expect(PROPOSAL_BUTTON_CLASS).not.toMatch(/nowrap|truncate/);
    // Choix ouverts depuis l'accueil : même carte, aucun composant propre.
    expect(lire('src/components/home/TodoChoicesDialog.tsx')).toContain('<ActionCard');
    // Aucun défilement horizontal de la page.
    expect(lire('src/components/to-process/ToProcessQueue.tsx')).toContain('w-full max-w-full overflow-x-hidden');
  });
});

// ── L59-5 ──────────────────────────────────────────────────────────────────
describe('L59-5 — agenda d’un bien : Liste / Mensuel / Annuel', async () => {
  const { AgendaViewControls, shiftMonth, parseAgendaView, currentMonth, YearView } = await import('@/components/agenda/AgendaPeriodViews');

  it('L59-5a — navigation de mois exacte (sans fuseau), passage d’année', () => {
    expect(shiftMonth('2026-10', 1)).toBe('2026-11');
    expect(shiftMonth('2026-10', -1)).toBe('2026-09');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(currentMonth(new Date(2026, 9, 1, 0, 5))).toBe('2026-10');
    expect(parseAgendaView('year')).toBe('year');
    expect(parseAgendaView('nimporte')).toBe('list');
    expect(parseAgendaView(null)).toBe('list');
  });

  it('L59-5b — même sélecteur que « Mon agenda » (capture pj3) : trois vues, mobile pleine largeur, desktop sur une ligne', () => {
    const html = renderToStaticMarkup(h(AgendaViewControls, { view: 'calendar', month: '2026-10', year: 2026, onView: noop, onMonth: noop, onYear: noop, label: 'Affichage de l’agenda du bien' }));
    for (const l of ['Liste', 'Mensuel', 'Annuel']) expect(html).toContain(l);
    expect(html).toContain('aria-label="Affichage de l’agenda du bien"');
    expect(html).toContain('flex w-full overflow-hidden rounded-md border md:w-auto');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Mois précédent');
    expect(html).toContain('octobre 2026');
    const annuel = renderToStaticMarkup(h(AgendaViewControls, { view: 'year', month: '2026-10', year: 2026, onView: noop, onMonth: noop, onYear: noop }));
    expect(annuel).toContain('Année précédente');
    expect(annuel).not.toContain('Mois précédent');
  });

  it('L59-5c — l’onglet Agenda du bien affiche les grilles partagées, limitées au bien (mois / année transmis à l’API)', () => {
    const tab = lire('src/components/assets/AssetAgendaTab.tsx');
    expect(tab).toContain('<AgendaViewControls');
    expect(tab).toContain('<CalendarView items={items} month={month}');
    expect(tab).toContain('<YearView items={items} year={year}');
    expect(tab).toContain("if (view === 'calendar') params.set('month', month);");
    expect(tab).toContain("if (view === 'year') params.set('year', String(year));");
    expect(tab).toContain('assetIds: String(assetId)');
    expect(tab).toContain('onClick={ouvrirCreation}');
    const page = lire('src/app/(dashboard)/agenda/page.tsx');
    expect(page).toContain('<AgendaViewControls');
    expect(page).not.toMatch(/function (CalendarView|YearView|MonthCard)\(/);
    // Vue annuelle : 12 mois, rendu identique quel que soit l'écran (grille 2 → 4 colonnes).
    const an = renderToStaticMarkup(h(YearView, { items: [], year: 2026, onItemClick: noop }));
    expect(an).toContain('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3');
    expect(an.match(/Rien ce mois-ci/g)).toHaveLength(12);
  });
});
