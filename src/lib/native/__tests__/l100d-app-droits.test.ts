/**
 * Lot 100D — décision PO A9 du 27/10/2026 : dans l'application iOS / Android,
 * AUCUN achat (paiement, tarif, offres, portail Stripe, lien d'achat) — mais
 * les DROITS de l'utilisateur restent proposés : rétractation, résiliation,
 * gestion et suppression du compte, parrainage (code visible, copiable,
 * partageable), invitation Premium Duo.
 *
 *   L100D-A9-NAV   barrières serveur (middleware) : rétractation et
 *                  résiliation ouvertes à l'app ; achat toujours refusé ;
 *   L100D-A9-SHARE feuille de partage native → navigateur → copie ;
 *   L100D-A9-RES   résiliation fin de période (Stripe simulé) ;
 *   L100D-A9-UI    écrans : présence des droits, absence de tout prix / lien
 *                  d'achat dans les branches « app ».
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import {
  NATIVE_COMMERCE_API_PATHS, NATIVE_COMMERCE_PATHS, isCommerceApiPath, isCommercePath,
} from '@/lib/native/commerce';
import { canShareNatively, shareContent } from '@/lib/native/share';
import { stopSubscriptionRenewal } from '@/services/billing/stop-renewal.service';
import { middleware } from '@/middleware';
import { generateAccessToken } from '@/lib/jwt';

(globalThis as { React?: typeof React }).React = React;
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const UA_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 VerebonaApp/1.4.0 (52; preprod)';
/** Aucun prix, aucune devise, aucun lien vers un achat. */
const COMMERCE_RE = /€|\bEUR\b|formatEuroCents|unitAmountCents|amountLabel|\/mon-compte\/offres|\/abonnement\/checkout|create-checkout-session|create-customer-portal-session|openBillingPortal|Passer (au|à) (Premium|Duo)|Choisir (une|mon) offre/;

function inApp(plugins: Record<string, unknown> = {}, nav: Record<string, unknown> = {}) {
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: plugins } });
  vi.stubGlobal('navigator', { userAgent: UA_APP, ...nav });
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('L100D-A9-NAV — rétractation et résiliation ouvertes dans l’app ; achat refusé', () => {
  it('pages : /retractation n’est plus commerciale ; offres, abonnement, paiement le restent', () => {
    expect(isCommercePath('/retractation')).toBe(false);
    expect(NATIVE_COMMERCE_PATHS).not.toContain('/retractation');
    for (const p of ['/mon-compte/offres', '/abonnement/checkout', '/mon-compte/abonnement/gerer/3']) expect(isCommercePath(p), p).toBe(true);
  });

  it('API : rétractation et résiliation fin de période permises ; paiement, portail, changement d’offre refusés', () => {
    for (const p of ['/api/withdrawal', '/api/withdrawal/eligibility', '/api/withdrawal/confirm', '/api/billing/stop-renewal']) {
      expect(isCommerceApiPath(p), p).toBe(false);
    }
    for (const p of ['/api/billing/create-checkout-session', '/api/billing/create-customer-portal-session', '/api/billing/upgrade', '/api/billing/schedule-change']) {
      expect(isCommerceApiPath(p), p).toBe(true);
    }
    expect(NATIVE_COMMERCE_API_PATHS.some((p) => p.startsWith('/api/withdrawal'))).toBe(false);
  });

  it('middleware, client natif déclaré : /retractation servie, offres redirigées ; rétractation et résiliation passent, paiement 403', async () => {
    const page = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`, { headers: { 'user-agent': UA_APP } }));
    const retract = await page('/retractation');
    expect(retract.headers.get('location') ?? '').not.toContain('/app/abonnement');
    expect((await page('/mon-compte/offres')).headers.get('location')).toContain('/app/abonnement');

    const token = await generateAccessToken({
      id: 1, email: 'a@b.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, currentAccountId: 9, hasActiveAccount: true,
    });
    const api = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`, {
      method: 'POST',
      headers: { cookie: `access_token=${token}`, origin: 'http://localhost:3000', 'x-verebona-client': 'IOS', 'user-agent': UA_APP },
    }));
    for (const p of ['/api/withdrawal/eligibility', '/api/billing/stop-renewal']) {
      const r = await api(p);
      expect(r.status, p).not.toBe(403);
    }
    const achat = await api('/api/billing/create-checkout-session');
    expect(achat.status).toBe(403);
    expect((await achat.json()).code).toBe('NOT_AVAILABLE_IN_APP');
  });
});

describe('L100D-A9-SHARE — feuille de partage native, sinon navigateur, sinon copie', () => {
  it('app : plugin natif `Share` utilisé (titre, texte, lien)', async () => {
    const share = vi.fn(async () => ({}));
    inApp({ Share: { share, canShare: async () => ({ value: true }) } });
    expect(canShareNatively()).toBe(true);
    expect(await shareContent({ title: 'Invitation Verebona', text: 'Mon code : ABC123', url: 'https://x.test/r/ABC123' })).toBe('shared');
    expect(share).toHaveBeenCalledWith({ title: 'Invitation Verebona', text: 'Mon code : ABC123', url: 'https://x.test/r/ABC123', dialogTitle: 'Invitation Verebona' });
  });

  it('feuille fermée par l’utilisateur : `cancelled` (aucune erreur affichée)', async () => {
    inApp({ Share: { share: async () => { throw new Error('Share canceled'); } } });
    expect(await shareContent({ title: 't', text: 'x' })).toBe('cancelled');
  });

  it('sans plugin : partage du navigateur ; sans rien : `unavailable` (l’écran copie l’invitation)', async () => {
    const webShare = vi.fn(async () => undefined);
    inApp({}, { share: webShare });
    expect(await shareContent({ title: 't', text: 'x' })).toBe('shared');
    expect(webShare).toHaveBeenCalled();
    inApp({}, {});
    expect(canShareNatively()).toBe(false);
    expect(await shareContent({ title: 't', text: 'x' })).toBe('unavailable');
  });
});

describe('L100D-A9-RES — résiliation fin de période (hors portail de paiement)', () => {
  const fake = (sub: Record<string, unknown>) => {
    const update = vi.fn(async (_id: string, p: Record<string, unknown>) => ({ ...sub, ...p }));
    return { update, stripe: () => ({ subscriptions: { retrieve: async () => sub, update } }) as never };
  };
  const fin = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

  it('abonnement actif : fin de période programmée, date de fin rendue, aucune annulation immédiate', async () => {
    const f = fake({ id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: fin });
    expect(await stopSubscriptionRenewal('sub_1', f.stripe)).toEqual({ ok: true, alreadyScheduled: false, endsAt: '2026-12-01T00:00:00.000Z', subscriptionId: 'sub_1' });
    expect(f.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
  });

  it('déjà programmée : idempotent ; impayé : renvoyé vers le site ; aucun abonnement : refus', async () => {
    const deja = fake({ id: 'sub_2', status: 'active', cancel_at_period_end: true, cancel_at: fin });
    expect(await stopSubscriptionRenewal('sub_2', deja.stripe)).toMatchObject({ ok: true, alreadyScheduled: true });
    expect(deja.update).not.toHaveBeenCalled();
    const impaye = fake({ id: 'sub_3', status: 'past_due', cancel_at_period_end: false });
    const r = await stopSubscriptionRenewal('sub_3', impaye.stripe);
    expect(r).toMatchObject({ ok: false, code: 'NOT_STOPPABLE_HERE' });
    expect(impaye.update).not.toHaveBeenCalled();
    expect(await stopSubscriptionRenewal(null, deja.stripe)).toMatchObject({ ok: false, code: 'NO_SUBSCRIPTION' });
  });

  it('route : titulaire seulement, pas de changement de statut local (le webhook fait foi), journal', () => {
    const route = read('src/app/api/billing/stop-renewal/route.ts');
    expect(route).toContain('resolveOwnedSessionAccount');
    expect(route).toContain("activityType: 'SUBSCRIPTION_RENEWAL_STOPPED'");
    expect(route).not.toContain('subscriptionStatus');
    expect(route).not.toMatch(COMMERCE_RE);
  });
});

describe('L100D-A9-UI — écrans de l’app : droits présents, aucun prix ni lien d’achat', () => {
  it('Mon compte : parrainage et rétractation affichés aussi dans l’app ; suppression du compte inchangée', () => {
    const page = read('src/app/(dashboard)/mon-compte/page.tsx');
    expect(page).toMatch(/^\s*<ReferralCard \/>$/m);
    expect(page).toMatch(/^\s*<WithdrawalCard \/>$/m);
    expect(page).not.toContain('commerceHidden');
    const infos = read('src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx');
    expect(infos).toMatch(/<DeleteAccountCard\s/);
    expect(infos).not.toMatch(/commerceHidden\s*&&\s*<DeleteAccountCard|!commerceHidden\s*&&\s*<DeleteAccountCard/);
  });

  it('Mon abonnement (app) : message sobre + « Résilier mon abonnement » ; invitation Duo jamais masquée ; « Passer au Duo » masqué', () => {
    const s = read('src/components/subscription/SubscriptionSummary.tsx');
    const debut = s.indexOf(') : commerceHidden ? (');
    const branche = s.slice(debut, s.indexOf('\n  ) : (', debut));
    expect(branche).toContain('<NativeCommerceNotice');
    expect(branche).toContain('<NativeResiliation');
    expect(branche).not.toMatch(COMMERCE_RE);
    expect(s).toMatch(/\{showDuoInvitation && \(/);
    expect(s).not.toMatch(/showDuoInvitation && !commerceHidden/);
    expect(s).toMatch(/data\.plan !== 'premium_duo' && !commerceHidden/);
    expect(s).toMatch(/subscription\.currentPrice && !commerceHidden/);
  });

  it('résiliation (rendu) : bouton clair, ou date de fin si déjà programmée ; aucun prix', async () => {
    const { NativeResiliation } = await import('@/components/subscription/NativeResiliation');
    const bouton = renderToStaticMarkup(h(NativeResiliation, { cancelAtPeriodEnd: false, periodEndAt: '2026-12-01T00:00:00Z' }));
    expect(bouton).toContain('Résilier mon abonnement');
    const prevue = renderToStaticMarkup(h(NativeResiliation, { cancelAtPeriodEnd: true, periodEndAt: '2026-12-01T00:00:00Z' }));
    expect(prevue).toContain('Résiliation programmée');
    expect(prevue).toContain('1 décembre 2026');
    const src = read('src/components/subscription/NativeResiliation.tsx');
    expect(src).toContain('Ce n’est pas une rétractation');
    expect(src).toContain('w-full sm:w-auto');
    expect(src).not.toMatch(COMMERCE_RE);
    expect(src).not.toMatch(/Opération/);
  });

  it('rétractation (app) : aucun montant ; libellés imposés conservés', () => {
    const card = read('src/components/account/WithdrawalCard.tsx');
    expect(card).toMatch(/inApp\s*\?\s*<Row label="Remboursement" value="Intégral, sur votre moyen de paiement d’origine" \/>/);
    expect(card).toContain('Renoncer au contrat ici');
    const page = read('src/app/retractation/page.tsx');
    expect(page).toMatch(/inApp\s*\?\s*<Row label="Remboursement" value="Intégral" \/>/);
    expect(page).toMatch(/inApp \? <Link href="\/login">Fermer<\/Link> : <a href=\{publicSiteUrl\('\/'\)\}>/);
    expect(page).toContain('Confirmer la rétractation');
  });

  it('parrainage (app) : code visible et copiable, invitation partageable ; texte neutre sans prix', async () => {
    const block = read('src/components/account/ReferralBlock.tsx');
    expect(block).toContain('Copier le code');
    expect(block).toContain('data-testid="referral-share"');
    expect(block).toContain("'Partager mon invitation'");
    expect(block).toContain('Le parrainage n’est pas encore disponible pour votre compte.');
    expect(block).not.toMatch(COMMERCE_RE);
    const { referralShareText } = await import('@/components/account/ReferralBlock');
    const t = referralShareText('ABC123');
    expect(t).toContain('ABC123');
    expect(t).not.toMatch(/€|prix|tarif|offert|gratuit|\d+ ?mois/i);
  });
});
