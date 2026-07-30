/**
 * Parcours public et libellés imposés — CDC 6 §6.1, §6.3, §7.3, §12.2.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { VERIFICATION_TOKEN_TTL_MINUTES } from '@/services/withdrawal/public-verification.service';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('vérification d’adresse (§6.3)', () => {
  it('limite la validité du lien à trente minutes', () => {
    expect(VERIFICATION_TOKEN_TTL_MINUTES).toBe(30);
  });
});

describe('libellés imposés par le cahier des charges', () => {
  const page = read('src/app/retractation/page.tsx');

  it('emploie « Confirmer la rétractation » comme bouton final (§7.3)', () => {
    expect(page).toContain('Confirmer la rétractation');
  });

  it('n’utilise aucun bouton de confirmation ambigu', () => {
    // §7.3 : « aucun bouton de confirmation ambigu, tel que Continuer,
    // Valider ou Envoyer, ne doit être utilisé seul ».
    const buttons = [...page.matchAll(/<Button[^>]*>([\s\S]*?)<\/Button>/g)]
      .map((m) => m[1].replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').trim())
      .filter(Boolean);

    for (const label of buttons) {
      expect(label).not.toMatch(/^(Valider|Envoyer|Continuer)$/);
    }
  });

  it('distingue explicitement rétractation et résiliation (§7.1)', () => {
    expect(page).toMatch(/non une résiliation|et non une résiliation|Rétractation, et non résiliation/i);
    expect(page).toContain('résiliation');
  });

  it('indique qu’aucun motif n’est exigé (§7.1)', () => {
    expect(page).toMatch(/aucun motif|sans motif/i);
  });

  it('annonce les cinq conséquences du §7.1', () => {
    for (const fragment of [
      'annulé immédiatement',
      'intégral',
      'suspendu',
      '30 jours',
      'supprimées',
    ]) {
      expect(page).toContain(fragment);
    }
  });
});

describe('lien « Renoncer au contrat ici » (§6.1)', () => {
  // Le libellé est imposé mot pour mot. Un test le fige, car une reformulation
  // bien intentionnée le ferait dériver.
  const LABEL = 'Renoncer au contrat ici';

  it('figure dans le pied de page de l’application', () => {
    expect(read('src/components/Footer.tsx')).toContain(LABEL);
  });

  it('figure dans le pied de page public', () => {
    expect(read('src/components/LandingFooter.tsx')).toContain(LABEL);
  });

  it('figure sur l’écran de connexion', () => {
    expect(read('src/app/(auth)/login/page.tsx')).toContain(LABEL);
  });

  it('figure dans Mon compte', () => {
    expect(read('src/components/account/WithdrawalCard.tsx')).toContain(LABEL);
  });

  it('pointe toujours vers /retractation', () => {
    for (const file of [
      'src/components/Footer.tsx',
      'src/components/LandingFooter.tsx',
      'src/app/(auth)/login/page.tsx',
      'src/components/account/WithdrawalCard.tsx',
    ]) {
      expect(read(file)).toContain('/retractation');
    }
  });
});

describe('réponse du parcours public (§12.2)', () => {
  const route = read('src/app/api/withdrawal/public/start/route.ts');

  it('renvoie une réponse unique, quel que soit le cas', () => {
    // « La réponse ne doit pas révéler l'existence d'un compte à un tiers. »
    // Une constante unique rend l'écart impossible par construction.
    expect(route).toContain('GENERIC_RESPONSE');
    expect(route).toMatch(/Si un compte Verebona est associé/);
  });

  it('ne renvoie pas d’erreur différenciée sur compte inconnu', () => {
    expect(route).not.toMatch(/ACCOUNT_NOT_FOUND|USER_NOT_FOUND|UNKNOWN_EMAIL/);
  });

  it('conserve la même réponse même en cas de panne', () => {
    expect(route).toMatch(/catch[\s\S]{0,400}GENERIC_RESPONSE|GENERIC_RESPONSE[\s\S]{0,200}$/);
  });
});
