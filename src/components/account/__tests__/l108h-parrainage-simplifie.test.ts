/**
 * Lot 108H — Mon compte › Parrainage simplifié (décision PO) : accroche,
 * bénéfice au parrain seul avec la condition « abonnement annuel », lien vers
 * les conditions publiques ; plus de liste de conditions ni de sous-titre
 * tronqué ; fonctions opérationnelles conservées.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralSummary } from '@/components/account/ReferralBlock';
import { REFERRAL_RULES, REFERRAL_TEXT } from '@/services/referral/referral-rules';
import { legalPublicUrl } from '@/lib/legal/public-legal';

(globalThis as { React?: typeof React }).React = React;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const decode = (h: string) => h.replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('L108H-UI-01 — texte du bloc', () => {
  const html = decode(renderToStaticMarkup(createElement(ReferralSummary)));
  const strip = (h: string) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const text = [...html.matchAll(/<(p|a)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => strip(m[2]));

  it('exactement les trois éléments demandés, dans l’ordre', () => {
    expect(text).toEqual([
      'Invitez vos proches à découvrir Verebona.',
      'Recevez 1 mois d’abonnement offert pour chaque proche qui souscrit un abonnement annuel.',
      'Voir les conditions du parrainage',
    ]);
  });

  it('le lien vise la section « Parrainage » de la rubrique Légal du site public de l’environnement', () => {
    expect(html).toContain(`href="${legalPublicUrl('parrainage')}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('data-testid="referral-terms-link"');
    // Cible tactile ≥ 44 px, lien souligné (identifiable).
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*underline/);
  });

  it('bénéfice dérivé de la règle centrale ; rien ne promet un avantage au filleul', () => {
    expect(REFERRAL_TEXT.accountReward).toContain(`${REFERRAL_RULES.rewardMonths} mois d’abonnement offert`);
    expect(REFERRAL_TEXT.accountReward).toMatch(/abonnement annuel/);
    for (const t of [REFERRAL_TEXT.accountIntro, REFERRAL_TEXT.accountReward]) {
      expect(t).not.toMatch(/filleul|vous deux|chacun|votre proche (reçoit|recevra|bénéficie)/i);
    }
  });
});

describe('L108H-UI-02 — bloc et carte', () => {
  const bloc = code(read('src/components/account/ReferralBlock.tsx'));
  const carte = code(read('src/components/account/ReferralCard.tsx'));

  it('plus de liste de conditions ni de récompense longue dans le bloc', () => {
    expect(bloc).not.toContain('REFERRAL_TEXT.conditions');
    expect(bloc).not.toContain('REFERRAL_TEXT.reward}');
    expect(bloc).not.toMatch(/<ul\b/);
    expect(bloc).not.toContain('ReferralConditions');
    // Les trois états (non éligible Web, sans lien, avec lien) affichent le résumé.
    expect(bloc.match(/<ReferralSummary \/>/g)).toHaveLength(3);
  });

  it('carte : sous-titre tronqué supprimé (bénéfice dit une seule fois)', () => {
    expect(carte).not.toMatch(/description=/);
    expect(carte).not.toContain('REFERRAL_TEXT');
  });

  // Lot 111H (décision PO) : le formulaire « Inviter par email » (envoi
  // `/api/referral/send-email`, validation d'adresse) est retiré — doublon de
  // « Partager mon invitation ». Les autres fonctions restent.
  it('fonctions opérationnelles conservées : code, copie, lien, partage', () => {
    for (const s of [
      'Copier le code', 'Copier le lien', 'data-testid="referral-share"', "'Partager mon invitation'",
      'Créer mon lien de parrainage',
      'Le parrainage n’est pas encore disponible pour votre compte.', 'REFERRAL_TEXT.notEligible',
    ]) expect(bloc, s).toContain(s);
    expect(bloc).not.toContain("'/api/referral/send-email'");
    expect(bloc).not.toContain('emailRegex');
  });

  it('lien des conditions : LegalLink + useLegalLinks (navigateur système dans l’app)', () => {
    expect(bloc).toMatch(/<LegalLink\s+href=\{legalLinks\.parrainage\}/);
    expect(bloc).toContain('useLegalLinks()');
  });

  it('petits écrans : rangées code / lien empilées sous 640 px, rien de tronqué', () => {
    expect(bloc).not.toMatch(/\btruncate\b/);
    expect(bloc.match(/flex flex-col gap-2 sm:flex-row/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
