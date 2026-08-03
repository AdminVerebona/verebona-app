/**
 * Aucune route ne relit sa propre réponse.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIRE UNE RÉPONSE LA CONSOMME
 *
 * `/api/users/me` construisait sa réponse, puis appelait
 * `await meResponse.json()` pour alimenter un cache — et renvoyait la même
 * réponse, désormais vide et verrouillée :
 *
 *   Error: failed to pipe response
 *     [cause]: TypeError: Invalid state: The ReadableStream is locked
 *
 * La route répondait 500. Comme elle porte l'identité, tout ce qui suivait
 * tombait en 401 — accueil, biens, à-traiter, statut d'essai. Un import de
 * document paraissait « rester en cours » alors que le navigateur n'était
 * simplement plus authentifié.
 *
 * Le défaut ne se voyait qu'en production : en développement, Next.js sert
 * les routes différemment et l'erreur ne remonte pas de la même façon.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function routes(dossier: string, trouvees: string[] = []): string[] {
  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) {
      if (entree !== '__tests__') routes(chemin, trouvees);
    } else if (entree === 'route.ts') {
      trouvees.push(chemin);
    }
  }
  return trouvees;
}

/** Code seul : un commentaire décrivant le défaut n'est pas le défaut. */
const sansCommentaires = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

describe('une réponse n’est jamais relue avant d’être renvoyée', () => {
  it('aucune route ne consomme sa propre réponse', () => {
    const fautives: string[] = [];

    for (const chemin of routes(join(process.cwd(), 'src/app/api'))) {
      const code = sansCommentaires(readFileSync(chemin, 'utf-8'));

      // On cherche la lecture d'une variable qui porte une réponse
      // construite localement — pas celle d'un `fetch` sortant, qui est
      // légitime.
      const lectures = [...code.matchAll(/await\s+(\w*[Rr]esponse\w*)\.(json|text)\(\)/g)];
      for (const m of lectures) {
        const variable = m[1];
        // Construite ici ? Alors la relire consomme ce qu'on va renvoyer.
        if (new RegExp(`(const|let)\\s+${variable}\\s*=\\s*NextResponse`).test(code)) {
          fautives.push(`${chemin.replace(process.cwd() + '/', '')} (${variable})`);
        }
      }
    }

    expect(fautives, `routes relisant leur réponse :\n  ${fautives.join('\n  ')}`)
      .toEqual([]);
  });
});
