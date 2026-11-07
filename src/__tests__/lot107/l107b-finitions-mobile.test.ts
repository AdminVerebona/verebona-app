/**
 * Lot 107B — finitions mobile (recette iOS du 02/11/2026) :
 *  1. pastilles de type de document : un seul style neutre (EquipmentDrawer) ;
 *  2. bouton « Retour » déterministe vers Mon compte (Notifications et autres
 *     sous-pages) ;
 *  3. plus de toast de simple confirmation d'interrupteur + zones sûres
 *     partagées pour le conteneur de toasts, la barre haute et la coquille.
 * Rendu côté serveur (renderToStaticMarkup) et lecture des sources ; le
 * placement réel est vérifié dans Chromium (l107b-toasts-zones-sures-navigateur).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement as h, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// JSX classique sous vitest : React global (même convention que les tests UI).
(globalThis as { React?: typeof React }).React = React;

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Retire les commentaires (blocs et lignes) pour ne tester que le code. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\}/g, '');

// ─── 1. Pastilles de type de document ─────────────────────────────────────
describe('L107B-1 — pastilles de type de document : un seul style neutre', () => {
  const drawer = code('src/components/assets/EquipmentDrawer.tsx');

  it('plus aucune table de couleurs par type (DOC_TYPE_COLORS / DOC_TYPE_NEUTRE supprimées)', () => {
    expect(drawer).not.toContain('DOC_TYPE_COLORS');
    expect(drawer).not.toContain('DOC_TYPE_NEUTRE');
    expect(drawer).not.toMatch(/typeColor/);
  });

  it('style unique, neutre, en jetons de la charte — indépendant du code (V1, V2, web, inconnu)', () => {
    const defs = drawer.match(/const DOC_TYPE_PILL = '([^']+)'/g) ?? [];
    expect(defs).toHaveLength(1);
    const cls = /const DOC_TYPE_PILL = '([^']+)'/.exec(drawer)![1];
    expect(cls).toBe('bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border-[color:var(--border)]');
    expect(cls).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|accent|success|danger|attention|info/i);
    // Une seule pastille, dont la classe ne dépend d'aucun code de type.
    const pills = drawer.match(/data-testid="equipment-doc-type-pill"[^>]*>/g) ?? [];
    expect(pills).toHaveLength(1);
    expect(pills[0]).toContain('${DOC_TYPE_PILL}');
    expect(pills[0]).not.toMatch(/documentType/);
    // Le libellé affiché reste le libellé V2 ; date inchangée.
    expect(drawer).toMatch(/\{doc\.documentTypeLabel\}/);
    // Lot 108D : la date passe par la cellule de date documentaire partagée.
    expect(drawer).toMatch(/<DocumentDateCell value=\{doc\.documentDate\}/);
  });

  // #715 : plus de statut d'événement — seule la couleur d'état de l'équipement demeure.
  it('les couleurs d’état de l’équipement ne sont pas touchées ; plus aucune couleur d’état d’agenda', () => {
    expect(drawer).toContain("EN_PANNE: 'bg-[color:var(--danger-soft)]");
    expect(drawer).not.toContain("status === 'en_retard'");
  });

  it('les autres listes de documents affichent déjà le type en pastille neutre unique', () => {
    expect(code('src/components/documents/DocumentTypeBadge.tsx')).toMatch(/<Badge variant="outline"/);
    expect(code('src/components/assets/AssetOverviewTab.tsx')).toMatch(/<Badge variant="outline" className="text-xs">\s*\{userFacingLabel\(doc\.documentTypeLabel\)\}/);
  });
});

// ─── 2. Bouton « Retour » vers Mon compte ─────────────────────────────────
describe('L107B-2 — bouton Retour déterministe vers Mon compte', () => {
  it('composant standard : lien fixe /mon-compte, nom accessible, 44 × 44, chevron décoratif, jetons', async () => {
    const { ParentBackLink, PARENT_BACK_LINK_CLASS } = await import('@/components/shell/ParentBackLink');
    const html = renderToStaticMarkup(h(ParentBackLink, { to: 'monCompte' }));
    expect(html).toMatch(/<a[^>]*href="\/mon-compte"/);
    expect(html).toContain('aria-label="Retour à Mon compte"');
    expect(html).toContain('data-testid="parent-back-link"');
    expect(html).toContain('>Mon compte</span>');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('<nav aria-label="Navigation de retour"');
    expect(PARENT_BACK_LINK_CLASS).toContain('min-h-11');
    expect(PARENT_BACK_LINK_CLASS).toContain('min-w-11');
    expect(PARENT_BACK_LINK_CLASS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).not.toMatch(/accueil/i);
    // Destination déterministe : jamais l'historique.
    expect(code('src/components/shell/ParentBackLink.tsx')).not.toMatch(/history\.back|router\.back/);
  });

  const SOUS_PAGES = [
    'src/app/(dashboard)/mon-compte/notifications/page.tsx',
    'src/app/(dashboard)/mon-compte/enrichissements/page.tsx',
    'src/app/(dashboard)/mon-compte/offres/page.tsx',
    'src/components/billing/ManageSubscriptionView.tsx',
  ];
  for (const p of SOUS_PAGES) {
    it(`${p.split('/').slice(-2).join('/')} : bouton Retour vers Mon compte, AVANT le titre`, () => {
      const src = code(p);
      const back = src.indexOf('<ParentBackLink to="monCompte"');
      expect(back).toBeGreaterThan(-1);
      const h1 = src.search(/<h1 /);
      expect(h1).toBeGreaterThan(back);
    });
  }

  it('Notifications : rendu — le bouton précède le titre « Notifications »', async () => {
    vi.resetModules();
    vi.doMock('@/contexts/BreadcrumbContext', () => ({ useBreadcrumb: () => ({ setBreadcrumbs: () => {} }) }));
    vi.doMock('@/lib/api-client', () => ({ apiClient: { get: async () => null, post: async () => ({}), patch: async () => ({}) } }));
    const { default: Page } = await import('@/app/(dashboard)/mon-compte/notifications/page');
    const html = renderToStaticMarkup(h(Page));
    const back = html.indexOf('href="/mon-compte"');
    expect(back).toBeGreaterThan(-1);
    expect(back).toBeLessThan(html.indexOf('>Notifications</h1>'));
    vi.doUnmock('@/contexts/BreadcrumbContext');
    vi.doUnmock('@/lib/api-client');
  });
});

// ─── 3. Toast redondant et zones sûres ────────────────────────────────────
describe('L107B-3 — plus de toast de simple confirmation d’interrupteur', () => {
  it('Notifications : aucun toast de succès (« Vous recevrez nos actualités » supprimé)', () => {
    const src = code('src/app/(dashboard)/mon-compte/notifications/page.tsx');
    expect(src).not.toContain('toast.success');
    expect(src).not.toMatch(/recevrez nos actualités|ne recevrez plus nos actualités/);
    expect(src).toContain('saveNewsConsent(');
    expect(src).toContain('toast.error(result.error)');
    expect(src).toMatch(/disabled=\{newsSaving\}/);
  });

  it('enregistrement réussi : état relu du serveur, aucun message', async () => {
    const { saveNewsConsent } = await import('@/lib/notifications/news-consent-toggle');
    const calls: unknown[] = [];
    const r = await saveNewsConsent(true, async (url, body) => { calls.push([url, body]); return { ok: true, consented: true, consentedAt: '2026-11-02T10:00:00.000Z', source: 'x', version: 'v1' }; });
    expect(r).toEqual({ ok: true, consent: { consented: true, consentedAt: '2026-11-02T10:00:00.000Z' } });
    expect(calls).toEqual([['/api/notification-preferences/news-consent', { consented: true, source: 'mon-compte/notifications' }]]);
  });

  it('le serveur décide : un refus d’opt-in enregistré reste « non » (aucun consentement implicite)', async () => {
    const { saveNewsConsent } = await import('@/lib/notifications/news-consent-toggle');
    const r = await saveNewsConsent(true, async () => ({ ok: true, consented: false, consentedAt: null }));
    expect(r).toEqual({ ok: true, consent: { consented: false, consentedAt: null } });
    const vide = await saveNewsConsent(true, async () => ({}));
    expect(vide).toEqual({ ok: true, consent: null }); // la page relit alors les préférences
  });

  it('échec : erreur compréhensible (pas de faux succès)', async () => {
    const { saveNewsConsent, NEWS_CONSENT_SAVE_ERROR } = await import('@/lib/notifications/news-consent-toggle');
    const r = await saveNewsConsent(false, async () => { throw new Error('500'); });
    expect(r).toEqual({ ok: false, error: NEWS_CONSENT_SAVE_ERROR });
    expect(NEWS_CONSENT_SAVE_ERROR).toMatch(/pas été enregistré/);
  });

  it('équivalents supprimés : synchronisation du calendrier et opposition (l’interrupteur fait foi), erreurs conservées', () => {
    const info = code('src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx');
    expect(info).not.toMatch(/Synchronisation (activée|désactivée)/);
    expect(info).toContain("toast.error('Erreur lors de la mise à jour')");
    const privacy = code('src/components/account/PrivacyCard.tsx');
    expect(privacy).not.toMatch(/Opposition (enregistrée|retirée)\./);
    expect(privacy).toContain('toast.error(');
  });
});

describe('L107B-3 — zones sûres : une seule variable partagée', () => {
  const css = read('src/app/globals.css');

  it('conteneur de toasts : décalages sonner = jetons partagés (ordinateur et mobile)', async () => {
    const { AppToaster, TOASTER_OFFSET } = await import('@/components/AppToaster');
    expect(TOASTER_OFFSET).toEqual({
      top: 'var(--vb-toast-top)', bottom: 'var(--vb-toast-bottom)',
      left: 'var(--vb-toast-inline)', right: 'var(--vb-toast-inline)',
    });
    const el = (AppToaster as () => ReactElement)();
    expect(isValidElement(el)).toBe(true);
    const props = el.props as Record<string, unknown>;
    expect(props.offset).toBe(TOASTER_OFFSET);
    expect(props.mobileOffset).toBe(TOASTER_OFFSET);
    expect(props.position).toBe('top-center');
    expect(props.closeButton).toBe(true);
    // Un seul conteneur de toasts dans l'application, celui-ci.
    const shell = code('src/components/ClientShell.tsx');
    expect(shell).toContain('<AppToaster />');
    expect(shell).not.toMatch(/<Toaster[\s/>]/);
  });

  it('jetons dérivés des encarts --vb-safe-* et du bas de l’en-tête, sans valeur par modèle', () => {
    expect(css).toContain('--vb-header-bottom: calc(max(8px, var(--vb-safe-top)) + var(--vb-mobile-topbar-row));');
    expect(css).toContain('--vb-toast-top: calc(var(--vb-header-bottom) + 8px);');
    expect(css).toContain('--vb-toast-bottom: calc(var(--vb-safe-bottom) + 16px);');
    expect(css).toContain('--vb-toast-inline: calc(max(var(--vb-safe-left), var(--vb-safe-right)) + 16px);');
    expect(css).toMatch(/@media \(min-width: 48rem\) \{\s*:root \{\s*--vb-header-bottom: calc\(var\(--vb-safe-top\) \+ var\(--app-header\)\);/);
    // Rangée de la barre haute mobile = champ 44 px + marge basse 8 px.
    expect(css).toContain('--vb-mobile-topbar-row: 52px;');
    expect(code('src/components/verebona/space/VerebonaField.tsx')).toMatch(/flex h-\[44px\] min-w-0 flex-1/);
  });

  it('barre haute mobile et coquille : encart réservé une seule fois (mobile : barre haute ; ≥ 768 px : coquille)', () => {
    const layout = code('src/components/DashboardLayout.tsx');
    const harness = read('src/__tests__/lot107/fixtures/l107b-toast-harness.tsx');
    const root = /SHELL_ROOT = '([^']+)'/.exec(harness)![1];
    const bar = /MOBILE_TOPBAR = '([^']+)'/.exec(harness)![1];
    expect(layout).toContain(`className="${root}"`);
    expect(layout).toContain(`className="${bar}"`);
    expect(bar).toContain('pb-2 pt-[max(8px,var(--vb-safe-top))] md:hidden');
    expect(root).toContain('md:pt-[var(--vb-safe-top)]');
    expect(root).not.toMatch(/(^|\s)pt-\[/); // pas d'encart haut sous 768 px (la barre haute le porte)
    // La TopBar de bureau garde sa hauteur : l'encart est porté par la coquille.
    const topbar = code('src/components/TopBar.tsx');
    expect(topbar).toContain('hidden h-[60px] flex-shrink-0');
    expect(read('src/__tests__/lot107/fixtures/l107b-toast-harness.tsx')).toContain(/hidden h-\[60px\] flex-shrink-0 items-center gap-3\.5 border-b border-\[color:var\(--border-subtle\)\] bg-\[color:var\(--bg-page\)\] px-7 md:flex/.exec(topbar)![0]);
  });

  it('surfaces superposées de la coquille : plus aucun env() direct (variable partagée partout)', () => {
    const fichiers = [
      'src/components/DashboardLayout.tsx', 'src/components/mobile/bottom-navigation.tsx',
      'src/components/mobile/mobile-account-panel.tsx', 'src/components/verebona/space/VerebonaField.tsx',
      'src/components/NotificationBell.tsx', 'src/components/ScrollToTop.tsx', 'src/components/pwa/PwaRecovery.tsx',
      'src/components/exports/preparation/ExportPreparationScreen.tsx', 'src/components/shell/CguvReacceptanceScreen.tsx',
      'src/components/mobile/AppUpdateRequiredGate.tsx', 'src/app/not-found.tsx',
    ];
    for (const f of fichiers) {
      expect(code(f), f).not.toMatch(/env\(safe-area-inset/);
      expect(code(f), f).toMatch(/var\(--vb-safe-(top|bottom)\)/);
    }
  });

  it('mode de la barre d’état inchangé : application sous la barre (viewport-fit=cover, black-translucent, contentInset never)', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toContain("viewportFit: 'cover'");
    expect(layout).toContain("statusBarStyle: 'black-translucent'");
    expect(read('mobile/capacitor.config.ts')).toContain("contentInset: 'never'");
  });
});
