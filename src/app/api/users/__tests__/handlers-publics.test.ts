/**
 * `/api/users` est public (inscription, sans JWT dans `middleware.ts`) : seul
 * POST doit y exister. GET, PUT et DELETE permettaient à un visiteur anonyme
 * de lister, modifier et supprimer n'importe quel utilisateur.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/app/api/users/route.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('/api/users — route publique', () => {
  it('n’expose que POST (inscription)', () => {
    const handlers = [...source.matchAll(/export\s+(?:async\s+function|const|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]
      .map((m) => m[1]);
    expect(handlers).toEqual(['POST']);
  });
});
