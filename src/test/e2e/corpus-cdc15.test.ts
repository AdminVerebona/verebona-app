/**
 * Contrôle BLOQUANT du corpus E2E du CDC 15 §15 (D-17 : « 100 % bloquant en
 * CI sur sorties enregistrées »). Exécuté par `npm run test:run`, sans base :
 * lecture statique des fichiers `*.e2e.ts`.
 *
 * Échoue si l'un des 43 ID n'a aucun test ACTIF dont le titre porte l'ID
 * (absent, ou seulement `it.todo` / `it.skip` / `it.skipIf`…), ou si l'index
 * `CORPUS-CDC15.md` ne désigne pas un fichier qui le porte.
 *
 * Portabilité (Windows) : chemins par `path.join`, lecture par `fs`, aucun
 * processus lancé.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const RACINE = join(__dirname);

export const CORPUS_IDS: readonly string[] = [
  ...Array.from({ length: 20 }, (_, i) => `E2E-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 23 }, (_, i) => `E2E-T2-${String(i + 1).padStart(2, '0')}`),
];

function fichiersE2E(dir: string): string[] {
  return readdirSync(dir).flatMap((nom) => {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) return fichiersE2E(chemin);
    return nom.endsWith('.e2e.ts') ? [chemin] : [];
  });
}

export interface TestTrouve { titre: string; actif: boolean }

/**
 * Titres des appels `it(...)` / `test(...)` d'un source (pure, testée) :
 * un modificateur `todo`, `skip`, `skipIf`, `runIf`, `fails` ou `only`… rend
 * le test inactif pour le corpus (seul `it(...)` / `test(...)` simple
 * compte), et un `describe.skip` / `.todo` / `.skipIf` / `.runIf` dans le
 * fichier désactive tout le fichier.
 */
export function testsDuSource(source: string): TestTrouve[] {
  // Un bloc conditionnel ou sauté peut contenir les tests porteurs d'ID : le
  // fichier entier cesse alors de compter (prudence : jamais de faux vert).
  const fichierInactif = /\b(describe|suite|scenario)\.(skip|todo|skipIf|runIf)\s*\(/.test(source);
  const re = /\b(it|test)((?:\.[A-Za-z]+(?:\([^)]*\))?)*)\s*\(\s*(['"`])((?:\\.|(?!\3)[\s\S])*?)\3/g;
  const out: TestTrouve[] = [];
  for (const m of source.matchAll(re)) {
    const modificateurs = m[2] ?? '';
    out.push({ titre: m[4], actif: !fichierInactif && modificateurs === '' });
  }
  return out;
}

/** L'ID est-il porté par le titre, comme mot entier (E2E-01 ≠ E2E-010, ≠ E2E-T2-01) ? */
export function porteId(titre: string, id: string): boolean {
  return new RegExp(`(^|[^\\w-])${id.replace(/-/g, '\\-')}(?![\\w])`).test(titre);
}

describe('corpus E2E CDC 15 §15 — 43 scénarios', () => {
  const fichiers = fichiersE2E(RACINE);
  const parFichier = new Map(fichiers.map((f) => [f, testsDuSource(readFileSync(f, 'utf8'))]));
  const nomDe = (f: string) => f.split(/[\\/]/).pop()!;

  it('43 identifiants, uniques', () => {
    expect(CORPUS_IDS).toHaveLength(43);
    expect(new Set(CORPUS_IDS).size).toBe(43);
  });

  it.each(CORPUS_IDS)('%s : au moins un test E2E actif porte l’ID', (id) => {
    const actifs = [...parFichier].flatMap(([f, ts]) => ts.filter((t) => t.actif && porteId(t.titre, id)).map(() => nomDe(f)));
    expect(actifs, `${id} : aucun test actif (absent, todo ou skip)`).not.toEqual([]);
  });

  it('l’index CORPUS-CDC15.md désigne, pour chaque ID, un fichier qui porte ce test', () => {
    const index = readFileSync(join(RACINE, 'CORPUS-CDC15.md'), 'utf8');
    const lignes = new Map<string, string>();
    for (const l of index.split(/\r?\n/)) {
      const m = l.match(/^\|\s*(E2E-[\w-]+)\s*\|\s*([^|]+?)\s*\|/);
      if (m) lignes.set(m[1], m[2]);
    }
    const manquants = CORPUS_IDS.filter((id) => !lignes.has(id));
    expect(manquants, 'ID absents de l’index').toEqual([]);
    const incoherents = CORPUS_IDS.filter((id) => {
      const f = fichiers.find((x) => nomDe(x) === lignes.get(id));
      return !f || !parFichier.get(f)!.some((t) => t.actif && porteId(t.titre, id));
    });
    expect(incoherents, 'ID dont le fichier indexé ne porte pas de test actif').toEqual([]);
  });
});

describe('analyse statique des titres (garde du contrôle lui-même)', () => {
  it('todo, skip, skipIf et describe.skip ne comptent pas', () => {
    expect(testsDuSource(`it.todo('E2E-01 — a'); it.skip('E2E-02 — b', () => {}); it.skipIf(x)('E2E-03 — c', () => {});`)
      .map((t) => t.actif)).toEqual([false, false, false]);
    expect(testsDuSource(`it('E2E-01 — a', async () => {}); test("E2E-02 : b", () => {})`).map((t) => [t.titre, t.actif]))
      .toEqual([['E2E-01 — a', true], ['E2E-02 : b', true]]);
    expect(testsDuSource(`it.runIf(ok)('E2E-04 — d', () => {});`)[0].actif).toBe(false);
    for (const d of ['describe.skip(', 'describe.skipIf(ci)(', 'describe.runIf(ok)(', 'describe.todo(']) {
      expect(testsDuSource(`${d}'x', () => { it('E2E-01 — a', () => {}); });`).every((t) => !t.actif)).toBe(true);
    }
  });

  it('ID en mot entier', () => {
    expect(porteId('E2E-01 — a', 'E2E-01')).toBe(true);
    expect(porteId('E2E-010 — a', 'E2E-01')).toBe(false);
    expect(porteId('E2E-T2-01 — a', 'E2E-01')).toBe(false);
    expect(porteId('E2E-T2-19 (master) + P-T2-02', 'E2E-T2-19')).toBe(true);
    expect(porteId('E2E-T2-19 (master) + P-T2-02', 'E2E-T2-02')).toBe(false);
  });
});
