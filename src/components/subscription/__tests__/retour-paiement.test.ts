/**
 * Retour de paiement et fenêtres de refus — anomalies de recette.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('une lecture ne déclenche jamais de fenêtre', () => {
  it('api-client ignore les refus sur GET', () => {
    // « Mon compte » lit le jeton d'agenda au chargement : la fenêtre
    // « Fonctionnalité Premium » s'ouvrait sans aucun clic.
    expect(read('src/lib/api-client.ts')).toMatch(/method === 'GET' \? null : parseWriteBlocked\(errorBody\)/);
  });

  it('un compte sans offre voit la fenêtre de fin d’essai, pas l’argumentaire Premium', () => {
    const src = read('src/contexts/WriteGuardContext.tsx');
    expect(src).toMatch(/recu\.code === 'PREMIUM_REQUIRED' && sansOffre/);
    expect(src).toMatch(/essaiFini \? 'TRIAL_EXPIRED'/);
  });
});

describe('retour de Stripe', () => {
  const SUCCES = read('src/app/abonnement/success/page.tsx');

  it('Stripe renvoie vers la page de retour dédiée', () => {
    expect(read('src/app/api/billing/create-checkout-session/route.ts'))
      .toMatch(/success_url: `\$\{appUrl\}\/abonnement\/success\?session_id=\{CHECKOUT_SESSION_ID\}`/);
  });

  it('l’activation ne se déduit plus de l’offre enregistrée', () => {
    // Un compte en essai porte déjà PREMIUM : il passait pour « activé ».
    expect(SUCCES).not.toMatch(/plan !== 'STANDARD'/);
    expect(SUCCES).toMatch(/checkout_sync === 'synced' \|\| statut === 'ACTIVE'/);
    expect(read('src/components/subscription/PendingSyncBanner.tsx')).not.toMatch(/plan !== 'STANDARD'/);
  });

  it('le retour recharge complètement l’application', () => {
    expect(SUCCES).toMatch(/window\.location\.href = '\/accueil'/);
  });

  it('la lecture des droits applique un paiement resté en attente', () => {
    const src = read('src/app/api/billing/trial-status/route.ts');
    expect(src).toMatch(/await syncPendingCheckoutForAccount\(accountId\)/);
    expect(src).toMatch(/session\.currentAccountId \?\? membership\.accountId/);
  });

  it('le changement d’offre n’est plus bloqué par PLAN_MISMATCH', () => {
    const src = read('src/app/api/billing/create-checkout-session/route.ts')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/PLAN_MISMATCH/);
    expect(src).not.toMatch(/ne correspond pas au plan configuré/);
  });
});
