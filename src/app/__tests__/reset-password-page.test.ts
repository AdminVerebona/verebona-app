/**
 * Page de réinitialisation — parcours « mot de passe oublié ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES DEUX MOITIÉS MARCHAIENT, LE PARCOURS NON
 *
 * `/api/auth/forgot-password` envoyait l'email. `/api/auth/reset-password`
 * traitait le jeton. Mais la page `/reset-password` n'existait pas : le lien
 * du message menait à un 404.
 *
 * Aucun test ne le voyait, aucune erreur serveur ne le signalait — chaque
 * moitié fonctionnait isolément. Ce test vérifie la jonction.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const CHEMIN = 'src/app/(auth)/reset-password/page.tsx';
const SOURCE = readFileSync(join(process.cwd(), CHEMIN), 'utf-8');

describe('la page existe et répond au lien envoyé', () => {
  it('la page est là où le lien pointe', () => {
    expect(existsSync(join(process.cwd(), CHEMIN))).toBe(true);
  });

  it('elle lit le jeton depuis l’URL', () => {
    expect(SOURCE).toMatch(/useSearchParams\(\)\.get\('token'\)/);
  });

  it('elle appelle la bonne route avec les bons champs', () => {
    // L'API attend `{ token, newPassword }` — pas `password`.
    expect(SOURCE).toContain("'/api/auth/reset-password'");
    expect(SOURCE).toMatch(/newPassword: motDePasse/);
  });
});

describe('les cas d’échec ont leur propre message', () => {
  it('un jeton expiré est distingué', () => {
    expect(SOURCE).toContain('TOKEN_EXPIRED');
  });

  it('un jeton expiré propose la seule suite utile', () => {
    expect(SOURCE).toMatch(/href="\/forgot-password"/);
  });

  it('une arrivée sans jeton est traitée à part', () => {
    // Un lien tronqué par une messagerie est fréquent.
    expect(SOURCE).toMatch(/if \(!token\)/);
  });
});

describe('les règles de mot de passe', () => {
  it('la longueur est lue, jamais recopiée', () => {
    // Une règle affichée plus stricte que celle appliquée fait renoncer à des
    // mots de passe qui auraient été acceptés.
    expect(SOURCE).toContain('MIN_PASSWORD_LENGTH');
    expect(SOURCE).not.toMatch(/'Minimum \d+ caractères'/);
  });

  it('elles sont annoncées avant la saisie', () => {
    const posRegles = SOURCE.indexOf('REGLES.map');
    const posBouton = SOURCE.indexOf('Modifier mon mot de passe');
    expect(posRegles).toBeGreaterThan(-1);
    expect(posRegles).toBeLessThan(posBouton);
  });
});
