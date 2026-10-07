/**
 * Lot 26 — point 3 : le bloc rétractation disparaît 15 jours après la
 * souscription ; l'API refuse hors délai, par la même fonction.
 *
 * « 15 jours après la souscription » = clôture du délai légal de 14 jours
 * (jour de souscription non compté) : 00 h 00, heure de Paris, à J+15.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isWithdrawalWindowOpen,
  shouldOfferWithdrawal,
  withdrawalWindowClosesAt,
  WITHDRAWAL_PERIOD_DAYS,
} from '../withdrawal-window';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

// Mardi 6 octobre 2026, 10 h 00 à Paris (CEST, UTC+2).
const SOUSCRIT = new Date('2026-10-06T08:00:00Z');
// Mardi 20 octobre 2026 (J+14), 23 h 59 min 59 s à Paris.
const DERNIER_INSTANT = new Date('2026-10-20T21:59:59Z');
// Mercredi 21 octobre 2026 (J+15), 00 h 00 à Paris.
const J_PLUS_15 = new Date('2026-10-20T22:00:00Z');

describe('lot 26 — AC3 : fenêtre de rétractation (fonction pure)', () => {
  it('une seule règle : le délai légal de 14 jours déjà codé', () => {
    expect(WITHDRAWAL_PERIOD_DAYS).toBe(14);
    expect(withdrawalWindowClosesAt(SOUSCRIT)?.toISOString()).toBe(DERNIER_INSTANT.toISOString());
  });

  it('ouverte pendant 14 jours après le jour de souscription, fermée à J+15 00 h 00 (Paris)', () => {
    expect(isWithdrawalWindowOpen(SOUSCRIT, SOUSCRIT)).toBe(true);
    expect(isWithdrawalWindowOpen(SOUSCRIT, new Date('2026-10-13T12:00:00Z'))).toBe(true);
    expect(isWithdrawalWindowOpen(SOUSCRIT, DERNIER_INSTANT)).toBe(true);
    expect(isWithdrawalWindowOpen(SOUSCRIT, J_PLUS_15)).toBe(false);
    expect(isWithdrawalWindowOpen(SOUSCRIT, new Date('2026-11-06T08:00:00Z'))).toBe(false);
  });

  it('souscription tard le soir : même échéance (le jour de souscription n’est pas compté)', () => {
    const soir = new Date('2026-10-06T21:30:00Z'); // 23 h 30 à Paris
    expect(withdrawalWindowClosesAt(soir)?.toISOString()).toBe(DERNIER_INSTANT.toISOString());
  });

  it('14ᵉ jour un samedi : délai légal prorogé au lundi, le bloc reste affiché', () => {
    const samedi = new Date('2026-10-03T10:00:00Z'); // J+14 = samedi 17 octobre
    expect(isWithdrawalWindowOpen(samedi, new Date('2026-10-18T10:00:00Z'))).toBe(true); // dimanche
    expect(isWithdrawalWindowOpen(samedi, new Date('2026-10-19T21:59:59Z'))).toBe(true); // lundi 23:59:59
    expect(isWithdrawalWindowOpen(samedi, new Date('2026-10-19T22:00:00Z'))).toBe(false);
  });

  it('accepte une date ISO (réponse d’API) ; date absente ou invalide : fermée', () => {
    expect(isWithdrawalWindowOpen(SOUSCRIT.toISOString(), DERNIER_INSTANT)).toBe(true);
    expect(isWithdrawalWindowOpen(null, SOUSCRIT)).toBe(false);
    expect(isWithdrawalWindowOpen(undefined, SOUSCRIT)).toBe(false);
    expect(isWithdrawalWindowOpen('pas une date', SOUSCRIT)).toBe(false);
  });
});

describe('lot 26 — AC3 : faut-il proposer la rétractation ?', () => {
  it('éligible : oui pendant la fenêtre, non à J+15', () => {
    expect(shouldOfferWithdrawal({ verdict: 'eligible', subscribedAt: SOUSCRIT, now: DERNIER_INSTANT })).toBe(true);
    expect(shouldOfferWithdrawal({ verdict: 'eligible', subscribedAt: SOUSCRIT, now: J_PLUS_15 })).toBe(false);
  });

  it('inéligible (délai écoulé, aucun contrat payant, membre Duo, déjà rétracté) : jamais', () => {
    expect(shouldOfferWithdrawal({ verdict: 'ineligible', subscribedAt: SOUSCRIT, now: SOUSCRIT })).toBe(false);
    expect(shouldOfferWithdrawal({ verdict: 'ineligible', subscribedAt: null, now: SOUSCRIT })).toBe(false);
  });

  it('indéterminé : selon la date de repli (première facturation) ; sans aucune date, proposé (examen humain)', () => {
    expect(shouldOfferWithdrawal({ verdict: 'undetermined', subscribedAt: SOUSCRIT, now: DERNIER_INSTANT })).toBe(true);
    expect(shouldOfferWithdrawal({ verdict: 'undetermined', subscribedAt: SOUSCRIT, now: J_PLUS_15 })).toBe(false);
    expect(shouldOfferWithdrawal({ verdict: 'undetermined', subscribedAt: null, now: J_PLUS_15 })).toBe(true);
  });
});

describe('lot 26 — AC3 : affichage et API alignés sur la même fonction', () => {
  it('l’éligibilité (refus DEADLINE_PASSED) utilise isWithdrawalWindowOpen', () => {
    const src = read('src/services/withdrawal/eligibility.service.ts');
    expect(src).toContain("import { isWithdrawalWindowOpen } from './withdrawal-window';");
    expect(src).toContain('if (!isWithdrawalWindowOpen(subscription.contractConcludedAt, now)) {');
  });

  it('GET /api/withdrawal/eligibility décide l’affichage côté serveur (offerWithdrawal)', () => {
    const src = read('src/app/api/withdrawal/eligibility/route.ts');
    expect(src).toContain('shouldOfferWithdrawal({');
    expect(src).toContain('offerWithdrawal,');
  });

  it('POST /api/withdrawal/confirm refuse hors délai (409), sans enregistrer', () => {
    const src = read('src/app/api/withdrawal/confirm/route.ts');
    const refus = src.indexOf("eligibility.reason === 'DEADLINE_PASSED'");
    expect(refus).toBeGreaterThan(-1);
    expect(src.indexOf("code: 'WITHDRAWAL_WINDOW_CLOSED'")).toBeGreaterThan(refus);
    expect(refus).toBeLessThan(src.indexOf('await recordDeclaration('));
  });

  it('Mon compte : tout le bloc disparaît hors fenêtre, seul le suivi d’une demande reste', () => {
    const src = read('src/components/account/WithdrawalCard.tsx');
    expect(src).toContain('setOfferWithdrawal(Boolean(data.offerWithdrawal));');
    expect(src).toContain('if (!offerWithdrawal) return null;');
    // Plus de « Rétractation en ligne indisponible » ni de lien de repli.
    expect(src).not.toContain('Rétractation en ligne indisponible');
    expect(src.match(/Renoncer au contrat ici<\/Link>/g)).toHaveLength(1);
    // Le suivi d'une demande enregistrée passe avant le masquage.
    expect(src.indexOf('if (request) {')).toBeLessThan(src.indexOf('if (!offerWithdrawal) return null;'));
  });
});
