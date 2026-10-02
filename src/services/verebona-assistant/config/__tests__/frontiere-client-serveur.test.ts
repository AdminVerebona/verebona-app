/**
 * Lot 21 (relecture `next build`) — aucun module CLIENT (« use client ») ne
 * doit atteindre, par ses imports, la base (`@/db`, `postgres`) ni les
 * réglages administrés de l'assistant (`assistant-settings`, modules
 * `*.server.ts`). `assistant-flags.ts` reste pur : la surcharge du BO passe
 * par `assistant-flags.server.ts`, importé par les seuls appelants serveur.
 *
 * Test statique sur le graphe d'import (imports de type exclus).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = join(process.cwd(), 'src');
const IMP = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const INTERDITS = [/src\/db\/index\.ts$/, /assistant-settings\.ts$/, /\.server\.ts$/, /src\/lib\/admin-audit\.ts$/, /^PKG:postgres$/];

function resolve(from: string, spec: string): string | null {
  if (spec === 'postgres') return 'PKG:postgres';
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? normalize(join(dirname(from), spec)) : null;
  if (!base) return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function fichiers(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__') fichiers(p, out); } else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

const deps = new Map<string, string[]>();
function depsOf(f: string): string[] {
  if (f.startsWith('PKG:')) return [];
  if (!deps.has(f)) {
    const s = readFileSync(f, 'utf8');
    deps.set(f, [...s.matchAll(IMP)].map((m) => resolve(f, m[1] ?? m[2])).filter((x): x is string => !!x));
  }
  return deps.get(f)!;
}

describe('frontière client / serveur', () => {
  it('aucun module client n’atteint la base ni les réglages administrés', () => {
    const clients = fichiers(SRC).filter((f) => /^\s*(\/\*[\s\S]*?\*\/\s*)?['"]use client['"]/.test(readFileSync(f, 'utf8').slice(0, 2000)));
    expect(clients.length).toBeGreaterThan(100);
    const fautes: string[] = [];
    for (const c of clients) {
      const vus = new Set([c]);
      const file: Array<[string, string[]]> = [[c, [c]]];
      while (file.length) {
        const [f, chemin] = file.shift()!;
        if (INTERDITS.some((r) => r.test(f))) { fautes.push(chemin.map((x) => x.replace(`${SRC}/`, '')).join(' → ')); break; }
        for (const d of depsOf(f)) if (!vus.has(d)) { vus.add(d); file.push([d, [...chemin, d]]); }
      }
    }
    expect(fautes).toEqual([]);
  });

  it('assistant-flags.ts : aucun import (pur)', () => {
    const s = readFileSync(join(SRC, 'services/verebona-assistant/config/assistant-flags.ts'), 'utf8');
    expect(s).not.toMatch(/^\s*import\s/m);
  });
});
