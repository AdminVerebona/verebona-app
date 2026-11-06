/**
 * Lot 113B (#690) — bloc TCO verrouillé (Standard) : textes PO exacts + CTA
 * « Découvrir les offres Premium » vers la page Offres.
 *
 *   L113B-U01  titre et description repris à l'identique ; « Vos données sont conservées » supprimé
 *   L113B-U02  CTA (modèle existant Button + Link) → `/mon-compte/offres` directement (ni Stripe, ni écran intermédiaire)
 *   L113B-U03  application iOS / Android : aucun lien d'offre, message stores existant (lot 97B / A9)
 *   L113B-U04  câblage : TcoSection n'affiche le bloc que sur PREMIUM_REQUIRED ; aucune donnée TCO en Standard (API)
 *   L113B-U05  page Offres : Premium et Premium Duo présentés, aucun départ automatique vers Stripe à l'arrivée
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;
const { TcoLockedNotice, TCO_LOCKED_TITLE, TCO_LOCKED_DESCRIPTION, TCO_LOCKED_CTA_LABEL } = await import('../tco-locked');
const { OFFERS_PATH } = await import('@/lib/write-blocked');
const { NATIVE_COMMERCE_MESSAGE, isCommercePath } = await import('@/lib/native/commerce');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('L113B — bloc TCO verrouillé (Standard)', () => {
  const web = decode(renderToStaticMarkup(h(TcoLockedNotice, { commerceHidden: false })));
  const app = decode(renderToStaticMarkup(h(TcoLockedNotice, { commerceHidden: true })));

  it('L113B-U01 — textes du ticket à l’identique, ancien texte supprimé', () => {
    expect(TCO_LOCKED_TITLE).toBe('Suivez le coût de possession de vos biens');
    expect(TCO_LOCKED_DESCRIPTION).toBe('Visualisez combien vous coûte chaque bien dans le temps : achat, entretien, assurances, travaux et autres dépenses. Cette fonctionnalité est disponible avec Premium et Premium Duo.');
    expect(TCO_LOCKED_CTA_LABEL).toBe('Découvrir les offres Premium');
    for (const html of [web, app]) {
      expect(html).toContain(TCO_LOCKED_TITLE);
      expect(html).toContain(TCO_LOCKED_DESCRIPTION);
      expect(html).not.toContain('Vos données sont conservées');
      expect(html).not.toContain('Fonction Premium');
      expect(html).toContain('data-tco-locked');
    }
    const section = lire('src/components/assets/TcoSection.tsx');
    expect(section).not.toContain('Vos données sont conservées');
    expect(section).not.toContain('résultat de cession) est disponible avec Premium');
  });

  it('L113B-U02 — CTA unique vers la page Offres, modèle existant', () => {
    expect(OFFERS_PATH).toBe('/mon-compte/offres');
    const liens = [...web.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)];
    expect(liens).toHaveLength(1);
    expect(liens[0][1]).toBe('/mon-compte/offres');
    expect(liens[0][2]).toBe('Découvrir les offres Premium');
    expect(web).toContain('data-tco-offers-cta');
    expect(web).not.toMatch(/stripe|checkout|billing/i);
    const src = lire('src/components/assets/tco-locked.tsx');
    expect(src).toMatch(/<Button size="sm" asChild[^>]*>\s*<Link href=\{OFFERS_PATH\}>\{TCO_LOCKED_CTA_LABEL\}<\/Link>/);
    expect(src).not.toMatch(/onClick|fetch\(|apiClient|router\.push/);
  });

  it('L113B-U03 — application : message stores, aucun lien ni bouton d’offre', () => {
    expect(isCommercePath(OFFERS_PATH)).toBe(true);
    expect(app).not.toMatch(/<a |<button/);
    expect(app).not.toContain(TCO_LOCKED_CTA_LABEL);
    expect(app).toContain(NATIVE_COMMERCE_MESSAGE);
    expect(app).toContain('data-testid="native-commerce-notice"');
  });

  it('L113B-U04 — câblage : bloc seulement sur PREMIUM_REQUIRED, API sans donnée TCO en Standard', () => {
    const section = lire('src/components/assets/TcoSection.tsx');
    expect(section).toMatch(/\) : locked \? \([\s\S]{0,200}<TcoLockedNotice commerceHidden=\{commerceHidden\} \/>/);
    expect(section).toContain("if ((e as { code?: string }).code === 'PREMIUM_REQUIRED') { hasData.current = false; setLocked(true); setData(null); return; }");
    expect(section).toContain('const commerceHidden = useNativeCommerceHidden();');
    expect(section.match(/<TcoLockedNotice/g)).toHaveLength(1);
    const route = lire('src/app/api/assets/[id]/tco/route.ts');
    const garde = route.indexOf('if (!droits.premiumFeatures)');
    expect(garde).toBeGreaterThan(0);
    expect(garde).toBeLessThan(route.indexOf('readAssetTco(asset.accountId'));
    expect(route).toContain("NextResponse.json({ error: 'PREMIUM_REQUIRED', code: 'PREMIUM_REQUIRED', message: TCO_PREMIUM_MESSAGE, locked: true }, { status: 403 })");
  });

  it('L113B-U05 — page Offres : Premium et Premium Duo, pas de redirection Stripe à l’arrivée', () => {
    const offres = lire('src/app/(dashboard)/mon-compte/offres/page.tsx');
    expect(offres).toMatch(/id: 'PREMIUM',\n/);
    expect(offres).toMatch(/id: 'PREMIUM_DUO',\n/);
    expect(offres).toContain('{offers.map((offer) => {');
    // Le paiement ne part que d'un choix explicite de l'utilisateur (aucun départ automatique au montage).
    expect(offres).not.toMatch(/useEffect\(\(\) => \{\s*(void )?(handleSubscribe|startCheckout|subscribe)\(/);
  });
});
