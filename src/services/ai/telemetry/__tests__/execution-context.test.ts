/**
 * CDC BO IA §9.1, GEN-008 — contexte d'exécution des traces.
 *
 * Le SCR-07 promet qu'« un administrateur peut expliquer quelle version, quelle
 * config et quel code ont produit un résultat ». Ces trois informations
 * n'existent que si elles sont écrites au moment de l'appel : aucune ne se
 * reconstitue après coup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getAppVersion, rankOf } from '../execution-context';

const initial = { ...process.env };
afterEach(() => { process.env = { ...initial }; });

describe('commit applicatif (GEN-008)', () => {
  it('lit les variables posées par les hébergeurs', () => {
    process.env.SOURCE_VERSION = 'abc123';
    delete process.env.APP_COMMIT;
    expect(getAppVersion()).toBe('abc123');
  });

  it('privilégie une valeur explicite', () => {
    process.env.SOURCE_VERSION = 'hebergeur';
    process.env.APP_COMMIT = 'explicite';
    expect(getAppVersion()).toBe('explicite');
  });

  it("rend null plutôt qu'une valeur inventée", () => {
    // Une trace qui affirmerait un commit faux serait pire qu'une trace muette :
    // elle serait crue.
    delete process.env.APP_COMMIT;
    delete process.env.SOURCE_VERSION;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    expect(getAppVersion()).toBeNull();
  });

  it('borne la longueur', () => {
    process.env.APP_COMMIT = 'x'.repeat(200);
    expect(getAppVersion()!.length).toBe(40);
  });
});

describe('rang du modèle (§9.1)', () => {
  it('distingue les deux replis', () => {
    // `is_fallback` ne le fait pas : un traitement qui bascule toujours sur le
    // second ressemblerait à un repli ordinaire, alors que c'est un incident.
    expect(rankOf('p', 'p', ['f1', 'f2'])).toBe('primary');
    expect(rankOf('f1', 'p', ['f1', 'f2'])).toBe('fallback_1');
    expect(rankOf('f2', 'p', ['f1', 'f2'])).toBe('fallback_2');
  });

  it("ne classe pas un modèle hors de la chaîne configurée", () => {
    // Le classer arbitrairement ferait passer pour un repli normal un appel qui
    // n'aurait pas dû avoir lieu.
    expect(rankOf('inattendu', 'p', ['f1'])).toBeNull();
  });

  it('gère une chaîne sans repli', () => {
    expect(rankOf('p', 'p', [])).toBe('primary');
    expect(rankOf('autre', 'p', [])).toBeNull();
  });
});
