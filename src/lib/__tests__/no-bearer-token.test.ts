/**
 * Absence de jeton dans le navigateur — CDC cookies §5.1 et §11.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE TEST EXISTE POUR QUE LA MIGRATION NE SOIT PAS À REFAIRE
 *
 * 136 occurrences ont été supprimées de 54 fichiers. Sans garde-fou, le
 * premier composant recopié d'un ancien les réintroduirait — et personne ne
 * s'en apercevrait avant le prochain audit.
 *
 * Le §5.1 est catégorique : « aucun jeton accessible au JavaScript ». Le §11.4
 * demande la suppression de toutes les lectures résiduelles.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { globSync } from 'glob';

/**
 * Deux fichiers ont le droit de nommer ces clés : celui qui les efface, et
 * celui qui a servi à la migration.
 */
const AUTORISES = [
  'src/lib/auth-migration.ts',
  'src/scripts/migrate-auth-storage.ts',
];

const norm = (f: string) => f.replace(/\\/g, '/');

const SOURCES = globSync('src/**/*.{ts,tsx}', { ignore: ['**/node_modules/**'] })
  .filter((f) => !AUTORISES.some((a) => norm(f).endsWith(a)));

describe('aucun jeton dans le stockage du navigateur (§5.1)', () => {
  it('aucune lecture de bearer_token', () => {
    const coupables = SOURCES.filter((f) =>
      /(?:local|session)Storage\.getItem\(\s*['"]bearer_token['"]/.test(readFileSync(f, 'utf-8')),
    );
    expect(coupables).toEqual([]);
  });

  it('aucune écriture de bearer_token', () => {
    // La plus grave des trois : elle recrée la faille que la migration a
    // supprimée.
    const coupables = SOURCES.filter((f) =>
      /(?:local|session)Storage\.setItem\(\s*['"](?:bearer_token|refresh_token)['"]/.test(
        readFileSync(f, 'utf-8'),
      ),
    );
    expect(coupables).toEqual([]);
  });

  it('aucun en-tête Authorization construit côté navigateur', () => {
    // Un composant ne doit plus fabriquer d'en-tête : le cookie est transmis
    // automatiquement en même origine.
    const coupables = SOURCES.filter((f) => {
      const path = norm(f);
      // Les routes serveur et les services lisent légitimement des jetons ;
      // seul le navigateur est visé.
      if (path.includes('src/app/api/') || path.includes('src/lib/auth')
          || path.includes('src/services/')) return false;
      // Clé d'API d'un service tiers, portée par le serveur : hors périmètre
      // du §5.1, qui vise les jetons de SESSION accessibles au navigateur.
      if (path.includes('pdfmonkey-client')) return false;
      return /Authorization['"]?\s*:\s*`Bearer \$\{/.test(readFileSync(f, 'utf-8'));
    });
    expect(coupables).toEqual([]);
  });
});

describe('les gardes serveur sont intactes', () => {
  it('getCurrentUser refuse une requête sans jeton', () => {
    // Le codemod avait retiré cette garde : sans elle, toute requête anonyme
    // lève au lieu de rendre null, transformant chaque appel non authentifié
    // en erreur 500.
    expect(readFileSync('src/lib/auth.ts', 'utf-8')).toMatch(/if\s*\(\s*!token\s*\)/);
  });

  it('SessionService refuse une session sans jeton', () => {
    expect(readFileSync('src/lib/session-service.ts', 'utf-8')).toMatch(/if\s*\(\s*!token\s*\)/);
  });

  it('la vérification d’email refuse un lien sans jeton', () => {
    // `token` y vient de la query string du lien reçu par email.
    expect(readFileSync('src/app/api/auth/verify-email/route.ts', 'utf-8'))
      .toMatch(/if\s*\(\s*!token\s*\)/);
  });
});

describe('les chaînes de repli au cookie sont intactes', () => {
  // ══════════════════════════════════════════════════════════════════════
  // CE SONT ELLES QUI PORTENT TOUTE L'AUTHENTIFICATION
  //
  // Depuis la suppression des en-têtes construits côté navigateur, l'en-tête
  // `Authorization` n'est plus renseigné par le client. Le cookie est le seul
  // chemin restant : perdre un de ces replis rendrait l'application
  // inutilisable, et le typecheck ne le verrait pas.
  //
  // La relecture manuelle du lot en a trouvé deux, supprimés par le codemod et
  // que j'avais omis de rétablir en croyant l'avoir fait.
  // ══════════════════════════════════════════════════════════════════════

  it('SessionService lit le cookie quand l’en-tête est absent', () => {
    const s = readFileSync('src/lib/session-service.ts', 'utf-8');
    expect(s).toMatch(/cookies\.get\(['"]access_token['"]\)/);
  });

  it('extractAccessToken lit le cookie', () => {
    const s = readFileSync('src/lib/auth/token-extractor.ts', 'utf-8');
    expect(s).toMatch(/cookies\.get\(['"]access_token['"]\)/);
  });

  it('le proxy de fichiers lit le cookie', () => {
    // Le paramètre `?token=` a été retiré des appels navigateur : sans ce
    // repli, chaque prévisualisation d'image ou de PDF renverrait 401.
    const s = readFileSync('src/app/api/files/[id]/proxy/route.ts', 'utf-8');
    expect(s).toMatch(/cookies\.get\(['"]access_token['"]\)/);
  });

  it('SessionService lève AUTH_REQUIRED, le seul code traduit en 401', () => {
    // Tout autre libellé tomberait dans le cas par défaut de
    // handleSessionError et produirait un 500 sur une simple absence de
    // session. C'est l'erreur que j'avais introduite en restaurant la garde.
    const s = readFileSync('src/lib/session-service.ts', 'utf-8');
    expect(s).toMatch(/throw new Error\('AUTH_REQUIRED'\)/);
  });
});
