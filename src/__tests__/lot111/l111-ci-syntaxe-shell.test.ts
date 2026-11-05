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
import yaml from 'js-yaml';

type Step = { name?: string; run?: string; shell?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[]; defaults?: { run?: { shell?: string } } }> };

const DIR = join(process.cwd(), '.github', 'workflows');
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const tmp = mkdtempSync(join(tmpdir(), 'ci-shell-'));

describe('L111-CI — syntaxe bash des étapes des workflows', () => {
  for (const file of files) {
    it(`${file} : chaque bloc run est un script bash valide`, () => {
      const wf = yaml.load(readFileSync(join(DIR, file), 'utf8')) as Workflow;
      const errors: string[] = [];
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        (job.steps ?? []).forEach((step, i) => {
          if (!step.run) return;
          const shell = step.shell ?? job.defaults?.run?.shell ?? 'bash';
          if (!shell.startsWith('bash') && shell !== 'sh') return;
          // Les expressions GitHub ${{ … }} sont remplacées avant l'exécution.
          const script = step.run.replace(/\$\{\{[^}]*\}\}/g, 'X');
          const p = join(tmp, `${file}-${jobId}-${i}.sh`);
          writeFileSync(p, script);
          try {
            execFileSync('bash', ['-n', p], { stdio: 'pipe' });
          } catch (e) {
            const msg = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? String(e);
            errors.push(`${jobId} › ${step.name ?? `étape ${i + 1}`} : ${msg}`);
          }
        });
      }
      expect(errors).toEqual([]);
    });
  }

  it('mobile-ios.yml : aucune apostrophe dans une valeur par défaut ${var:-…}', () => {
    const src = readFileSync(join(DIR, 'mobile-ios.yml'), 'utf8');
    expect(src).not.toMatch(/\$\{[A-Za-z_]+:-[^}]*'/);
  });
});
