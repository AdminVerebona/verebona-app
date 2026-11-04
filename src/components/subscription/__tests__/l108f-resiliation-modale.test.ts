/**
 * Lot 108F — texte de la fenêtre « Résilier votre abonnement ? ».
 *
 *   L108F-TXT    texte exact (titre, deux phrases, deux boutons) ;
 *   L108F-SRC    offre et date réelles (Standard / Premium / Premium Duo,
 *                mensuel / annuel), format « 18 septembre 2027 » à Paris ;
 *   L108F-REPLI  date ou offre inconnue : rien d'inventé, résiliation possible ;
 *   L108F-ABS    plus de rétractation / remboursement / biens et documents ;
 *   L108F-COMP   comportement inchangé (fermer = rien, confirmer = stop-renewal),
 *                petit écran (320 px).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RESILIATION_CONFIRMATION, resiliationConfirmationLines, resiliationEndDate, resiliationOfferName,
} from '@/lib/billing/resiliation-confirmation';
import { ResiliationConfirmBody } from '@/components/subscription/NativeResiliation';

(globalThis as { React?: typeof React }).React = React;
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const INTERDITS = /r[ée]tractation|rembours|biens|documents/i;
const texte = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('L108F-TXT — texte exact', () => {
  it('titre et boutons', () => {
    expect(RESILIATION_CONFIRMATION.title).toBe('Résilier votre abonnement ?');
    expect(RESILIATION_CONFIRMATION.cancel).toBe('Garder mon abonnement');
    expect(RESILIATION_CONFIRMATION.confirm).toBe('Confirmer la résiliation');
  });

  it('corps : deux phrases exactes (apostrophe typographique)', () => {
    expect(resiliationConfirmationLines({ planCode: 'premium', periodEndAt: '2027-09-18T08:00:00Z' })).toEqual([
      'Votre offre Premium restera active jusqu’au 18 septembre 2027.',
      'À cette date, votre abonnement prendra fin et ne sera pas renouvelé.',
    ]);
  });

  it('rendu du corps : exactement les deux phrases, rien d’autre', () => {
    const html = renderToStaticMarkup(h(ResiliationConfirmBody, { planCode: 'standard', periodEndAt: '2026-12-01T10:00:00Z' }));
    expect(texte(html)).toBe('Votre offre Standard restera active jusqu’au 1 décembre 2026. À cette date, votre abonnement prendra fin et ne sera pas renouvelé.');
    expect((html.match(/<p>/g) ?? []).length).toBe(2);
  });
});

describe('L108F-SRC — offre et date du compte', () => {
  it('Standard / Premium / Premium Duo depuis plan_code ; repli sur l’offre des droits', () => {
    expect(resiliationOfferName('standard')).toBe('Standard');
    expect(resiliationOfferName('premium')).toBe('Premium');
    expect(resiliationOfferName('premium_duo')).toBe('Premium Duo');
    expect(resiliationOfferName('PREMIUM_DUO')).toBe('Premium Duo');
    // plan_code (abonnement résilié) prime sur les droits.
    expect(resiliationOfferName('standard', 'premium')).toBe('Standard');
    expect(resiliationOfferName(null, 'premium_duo')).toBe('Premium Duo');
    // Essai / aucune offre : pas un nom d'offre payante.
    expect(resiliationOfferName(null, 'trial')).toBeNull();
    expect(resiliationOfferName(null, 'none')).toBeNull();
  });

  it('mensuel et annuel : la date affichée est l’échéance réelle, pas une date figée', () => {
    const mensuel = resiliationConfirmationLines({ planCode: 'standard', periodEndAt: '2026-12-03T09:00:00Z' })[0];
    const annuel = resiliationConfirmationLines({ planCode: 'premium_duo', periodEndAt: '2027-11-03T09:00:00Z' })[0];
    expect(mensuel).toBe('Votre offre Standard restera active jusqu’au 3 décembre 2026.');
    expect(annuel).toBe('Votre offre Premium Duo restera active jusqu’au 3 novembre 2027.');
  });

  it('fuseau Europe/Paris (minuit passé à Paris, veille en UTC)', () => {
    expect(resiliationEndDate('2027-09-17T22:30:00Z')).toBe('18 septembre 2027');
    expect(resiliationEndDate('2027-01-31T23:30:00Z')).toBe('1 février 2027');
  });
});

describe('L108F-REPLI — valeurs inconnues : rien d’inventé', () => {
  it('date absente ou invalide → « jusqu’à la fin de la période en cours »', () => {
    for (const periodEndAt of [null, undefined, '', 'pas-une-date']) {
      expect(resiliationConfirmationLines({ planCode: 'premium', periodEndAt })[0])
        .toBe('Votre offre Premium restera active jusqu’à la fin de la période en cours.');
    }
  });

  it('offre inconnue → nom omis', () => {
    expect(resiliationConfirmationLines({ planCode: null, plan: null, periodEndAt: '2027-09-18T08:00:00Z' })[0])
      .toBe('Votre offre restera active jusqu’au 18 septembre 2027.');
  });
});

describe('L108F-ABS — mentions supprimées de la fenêtre', () => {
  it('aucun mot rétractation / remboursement / biens / documents dans le texte rendu', () => {
    for (const planCode of ['standard', 'premium', 'premium_duo', null]) {
      for (const periodEndAt of ['2027-09-18T08:00:00Z', null]) {
        const html = renderToStaticMarkup(h(ResiliationConfirmBody, { planCode, periodEndAt }));
        expect(texte(html)).not.toMatch(INTERDITS);
      }
    }
    expect(Object.values(RESILIATION_CONFIRMATION).join(' ')).not.toMatch(INTERDITS);
  });

  it('source du composant : plus aucune de ces mentions dans la fenêtre', () => {
    const src = read('src/components/subscription/NativeResiliation.tsx');
    const dialogue = src.slice(src.indexOf('<AlertDialog '), src.indexOf('</AlertDialog>'));
    expect(dialogue).not.toMatch(INTERDITS);
    expect(src).not.toContain('Ce n’est pas une rétractation');
    expect(src).not.toContain('restent conservés');
  });
});

describe('L108F-COMP — comportement et petit écran', () => {
  const src = read('src/components/subscription/NativeResiliation.tsx');

  it('« Garder mon abonnement » / fermeture : aucune action ; confirmer : stop-renewal seul', () => {
    expect(src).toMatch(/<AlertDialogCancel disabled=\{busy\}[^>]*>\{RESILIATION_CONFIRMATION\.cancel\}<\/AlertDialogCancel>/);
    expect(src).not.toMatch(/<AlertDialogCancel[^>]*onClick/);
    expect(src).toMatch(/onOpenChange=\{\(o\) => \{ if \(!busy\) setOpen\(o\); \}\}/);
    expect(src.match(/apiClient\.\w+/g)).toEqual(['apiClient.post']);
    expect(src).toContain("apiClient.post<{ endsAt: string | null }>('/api/billing/stop-renewal', {})");
  });

  it('Mon abonnement transmet l’offre réelle et l’échéance', () => {
    const s = read('src/components/subscription/SubscriptionSummary.tsx');
    const bloc = s.slice(s.indexOf('<NativeResiliation'), s.indexOf('/>', s.indexOf('<NativeResiliation')));
    expect(bloc).toContain('periodEndAt={data.subscription.currentPeriodEndAt}');
    expect(bloc).toContain('planCode={data.subscription.planCode}');
    expect(bloc).toContain('plan={data.plan}');
  });

  it('320 px : marge latérale, boutons pleine largeur empilés, libellés repliables, défilement interne', () => {
    expect(src).toContain('max-w-[calc(100%-2rem)] sm:max-w-md');
    expect(src).not.toMatch(/AlertDialogContent className="max-w-md/);
    expect(src).toContain('max-h-[calc(100dvh-2rem)] overflow-y-auto');
    expect(src).toContain('<AlertDialogFooter className="flex-col gap-2 sm:flex-row">');
    expect((src.match(/h-auto min-h-9 w-full whitespace-normal sm:w-auto/g) ?? []).length).toBe(2);
  });
});
