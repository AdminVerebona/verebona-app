/**
 * Garde administrateur sur TOUTES les routes `/api/admin/**` — CDC BO GEN-002,
 * §2 (SEC/AUD), audit BO §1.
 *
 * Le middleware n'exige qu'un JWT valide : le contrôle du rôle est délégué aux
 * handlers. Une route qui l'oublie est donc ouverte à tout utilisateur connecté
 * (cas de `reset-account-freemium`, `investigate-user`, `test-invite`,
 * `assets/[id]/transfer`, supprimées). Ce test parcourt l'arborescence et
 * échoue dès qu'un fichier `route.ts` n'appelle pas la garde serveur, ou lit
 * l'identité de l'acteur dans un en-tête forgeable par le client.
 *
 * Test statique volontaire : il s'applique aux routes à venir sans qu'on ait à
 * les déclarer, ce qu'aucun test d'intégration ciblé ne ferait.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(process.cwd(), 'src', 'app', 'api', 'admin');

/**
 * Appels reconnus comme garde admin serveur :
 *  - `requireAdmin(request)` (`@/lib/auth-guards`) ;
 *  - `SessionService.requireAdmin(request)` (même implémentation) ;
 *  - `requireAdminContext(req)` (routes IA, enveloppe de `requireAdmin`).
 */
const GUARD = /\b(?:SessionService\.)?requireAdmin(?:Context)?\s*\(/;

/** Lecture d'identité par en-tête client : interdite (falsifiable). */
const HEADER_IDENTITY = /headers\.get\(\s*['"]x-(?:admin-)?user-id['"]\s*\)/i;

/**
 * Exceptions explicites, chemin relatif à `src/app/api/admin` → justification.
 * Toute nouvelle entrée doit être motivée ; une exception devenue inutile fait
 * échouer le test (voir plus bas), pour que la liste ne s'allonge pas en silence.
 */
const EXCEPTIONS: Record<string, string> = {
  // Route retirée : répond 410 sans lire ni écrire aucune donnée.
  'ai-instructions/apply/route.ts': 'Route retirée (410 Gone), aucun accès aux données.',
  // Les routes ai/accounts/[accountId]/{quota,reset-counter,unlock-security}
  // passent désormais par `requireAdmin` (lot IA 2, GEN-013) : plus d'exception.
};

function listRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...listRoutes(full));
    } else if (name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

/** Retire les commentaires : une garde citée en commentaire ne protège rien. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Un fichier `route.ts` qui n'exporte aucun handler HTTP n'est pas une route :
 * Next.js répond 405 à toute méthode. C'est la forme des routes supprimées
 * livrées « inertes » (commentaire + `export {}`) pour qu'un dépôt où le
 * fichier n'a pas encore été effacé reste sûr.
 */
const HANDLER = /export\s+(?:async\s+function|const|function)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;

const routes = listRoutes(ROOT)
  .filter((full) => HANDLER.test(stripComments(readFileSync(full, 'utf8'))))
  .map((full) => ({
    full,
    rel: relative(ROOT, full).split(sep).join('/'),
  }));

describe('routes /api/admin/** — garde administrateur (GEN-002)', () => {
  it('trouve des routes à contrôler', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it.each(routes.filter((r) => !EXCEPTIONS[r.rel]).map((r) => [r.rel, r.full]))(
    '%s appelle la garde admin serveur',
    (_rel, full) => {
      const src = stripComments(readFileSync(full, 'utf8'));
      expect(src).toMatch(GUARD);
    },
  );

  it.each(routes.map((r) => [r.rel, r.full]))(
    '%s ne lit pas l\'identité dans un en-tête x-user-id / x-admin-user-id',
    (_rel, full) => {
      const src = stripComments(readFileSync(full, 'utf8'));
      expect(src).not.toMatch(HEADER_IDENTITY);
    },
  );

  it('chaque exception pointe vers une route existante et toujours sans garde', () => {
    for (const rel of Object.keys(EXCEPTIONS)) {
      const route = routes.find((r) => r.rel === rel);
      expect(route, `exception obsolète : ${rel}`).toBeDefined();
      const src = stripComments(readFileSync(route!.full, 'utf8'));
      expect(GUARD.test(src), `exception devenue inutile : ${rel}`).toBe(false);
    }
  });

  it('les routes hors V1 dangereuses ont disparu (audit BO §1, SEC-001)', () => {
    const removed = [
      'reset-account-freemium/route.ts',
      'investigate-user/route.ts',
      'test-invite/route.ts',
      'assets/[id]/transfer/route.ts',
      'files/[id]/view/route.ts',
      'files/[id]/route.ts',
    ];
    for (const rel of removed) {
      expect(routes.some((r) => r.rel === rel), rel).toBe(false);
    }
  });
});
