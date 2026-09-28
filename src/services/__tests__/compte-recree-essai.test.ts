/**
 * Compte recréé avec une adresse dont l'essai est déjà consommé (§3.4).
 *
 * L'utilisateur est en fin d'essai : « Essai gratuit terminé » et
 * « Choisir mon offre » — jamais « Plan gratuit », « Voir les offres » ni
 * « Passer à Premium ».
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

let ownerEmail: string | null = 'deja@exemple.fr';
let essaiConsomme = true;

vi.mock('@/db', () => {
  const chain = {
    select: () => chain, from: () => chain, innerJoin: () => chain, where: () => chain,
    limit: async () => (ownerEmail ? [{ email: ownerEmail }] : []),
  };
  return { db: chain };
});
vi.mock('../trial.service', () => ({
  TRIAL_LIMITS: { maxAssets: 2, maxDocuments: 30 },
  hasUsedTrial: async () => essaiConsomme,
}));

const { restrictedRefusal } = await import('../entitlements.service');
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

beforeEach(() => { ownerEmail = 'deja@exemple.fr'; essaiConsomme = true; });

describe('motif de refus d’un compte restreint', () => {
  it('sans abonnement, essai déjà consommé → fin d’essai', async () => {
    const r = await restrictedRefusal(1, 'none');
    expect(r.code).toBe('TRIAL_EXPIRED');
    expect(r.message).toContain('déjà été utilisé');
  });

  it('essai échu → fin d’essai', async () => {
    expect((await restrictedRefusal(1, 'readonly')).code).toBe('TRIAL_EXPIRED');
  });

  it('sans abonnement ni essai consommé (attribution échouée) → abonnement nécessaire', async () => {
    essaiConsomme = false;
    expect((await restrictedRefusal(1, 'none')).code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('abonnement résilié → abonnement nécessaire', async () => {
    expect((await restrictedRefusal(1, 'canceled')).code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('libellés', () => {
  it('bandeau et fenêtre de refus : « Choisir mon offre »', () => {
    const banner = read('src/components/subscription/TrialBanner.tsx');
    const debut = banner.indexOf('trial.dejaConsomme && isRestricted');
    const bloc = banner.slice(debut, banner.indexOf('</Button>', debut));
    expect(bloc).toContain('Choisir mon offre');
    expect(bloc).not.toContain('Voir les offres');
    expect(read('src/components/premium/WriteBlockedDialog.tsx')).toContain('<>Choisir mon offre</>');
  });

  it('l’accueil n’utilise plus la fenêtre « plan gratuit / Passer à Premium »', () => {
    const accueil = read('src/app/(dashboard)/accueil/page.tsx');
    expect(accueil).not.toContain('AssetLimitReachedDialog');
    expect(accueil).toContain('signalerRefus(info)');
  });
});
