/**
 * Lot 111 (correctif du 05/11) : l'étape « Garde-fou — droits signés du
 * partage » de mobile-ios.yml échouait dès son lancement (« unexpected EOF
 * while looking for matching `'' ») : une apostrophe dans ${var:-…} entre
 * guillemets. Ce test vérifie la syntaxe bash de TOUS les blocs `run:` des
 * workflows, pour qu'une telle erreur soit vue avant l'exécution sur GitHub.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type RunBlock = { name: string; script: string };

/**
 * Extraction des blocs `run:` sans dépendance YAML : `run: |` (bloc indenté)
 * ou `run: commande` sur une ligne. Les workflows du dépôt n'utilisent que
 * bash (pas de `shell:` différent).
 */
function runBlocks(src: string): RunBlock[] {
  const lines = src.split('\n');
  const out: RunBlock[] = [];
  let lastName = '';
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = lines[i].match(/^\s*-\s*name:\s*(.+)$/);
    if (nameMatch) lastName = nameMatch[1].trim();
    const m = lines[i].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!m) continue;
    const head = m[2].trim();
    if (head && !/^[|>][-+]?$/.test(head)) { out.push({ name: lastName, script: head }); continue; }
    const body: string[] = [];
    let indent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(''); continue; }
      const ind = l.length - l.trimStart().length;
      if (indent < 0) indent = ind;
      if (ind < indent || ind <= m[1].length) break;
      body.push(l.slice(indent));
      i = j;
    }
    out.push({ name: lastName, script: body.join('\n') });
  }
  return out;
}

const DIR = join(process.cwd(), '.github', 'workflows');
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const tmp = mkdtempSync(join(tmpdir(), 'ci-shell-'));

describe('L111-CI — syntaxe bash des étapes des workflows', () => {
  for (const file of files) {
    it(`${file} : chaque bloc run est un script bash valide`, () => {
      const errors: string[] = [];
      runBlocks(readFileSync(join(DIR, file), 'utf8')).forEach((b, i) => {
        // Les expressions GitHub ${{ … }} sont remplacées avant l'exécution.
        const script = b.script.replace(/\$\{\{[^}]*\}\}/g, 'X');
        const p = join(tmp, `${file}-${i}.sh`);
        writeFileSync(p, script);
        try {
          execFileSync('bash', ['-n', p], { stdio: 'pipe' });
        } catch (e) {
          const msg = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? String(e);
          errors.push(`${b.name || `bloc ${i + 1}`} : ${msg}`);
        }
      });
      expect(errors).toEqual([]);
    });
  }

  it('l’extracteur trouve bien les blocs (garde-fou du test lui-même)', () => {
    const blocks = runBlocks(readFileSync(join(DIR, 'mobile-ios.yml'), 'utf8'));
    expect(blocks.some((b) => b.name.startsWith('Garde-fou — droits signés du partage') && b.script.includes('set -euo pipefail'))).toBe(true);
  });

  it('mobile-ios.yml : aucune apostrophe dans une valeur par défaut ${var:-…}', () => {
    const src = readFileSync(join(DIR, 'mobile-ios.yml'), 'utf8');
    expect(src).not.toMatch(/\$\{[A-Za-z_]+:-[^}]*'/);
  });
});
