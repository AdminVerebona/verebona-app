/**
 * APP-PERF-38 — garde anti-retour des références Vercel, Supabase et Orchids.
 *
 * L'architecture retenue est Scalingo / PostgreSQL / OVH. Chaque occurrence
 * restante des anciennes plateformes est une EXCEPTION justifiée, listée
 * ci-dessous avec son nombre maximal d'occurrences (inventaire complet :
 * docs/exploitation/residus-historiques.md). Toute nouvelle occurrence — ou
 * un fichier non listé — fait échouer la CI (`npm run test:run`) : la
 * justifier ici, ou la retirer.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const RACINE = process.cwd();
const MOTIF = /vercel|supabase|orchids/gi;

/** Fichier → occurrences maximales tolérées, et pourquoi. */
const EXCEPTIONS: Record<string, { max: number; raison: string }> = {
  '.gitignore': { max: 3, raison: 'Protection : empêche de versionner les dossiers locaux .vercel/.orchids.' },
  '.env.example': { max: 2, raison: 'Documentation : aucune planification dans le dépôt (ni vercel.json…) ; aucune variable Vercel lue.' },
  'next.config.mjs': { max: 4, raison: 'Commentaires de traçabilité des retraits APP-PERF-38.' },
  'scripts/diagnose-migrations.ts': { max: 1, raison: 'Historique justifiant prepare:false (pooler transactionnel) — garde-fou APP-PERF-38.' },
  'src/app/layout.tsx': { max: 2, raison: 'Commentaire documentant le retrait du script tiers (ne pas le réintroduire).' },
  'src/components/ErrorReporter.tsx': { max: 2, raison: 'Commentaire documentant le retrait du message et de l\'envoi Orchids.' },
  'src/db/__tests__/pool-config.test.ts': { max: 5, raison: 'Test : VERCEL n\'a plus d\'effet sur le pool (APP-PERF-01).' },
  'src/db/index.ts': { max: 1, raison: 'Commentaire : plus de détection VERCEL (APP-PERF-01).' },
  'src/db/pool-config.ts': { max: 3, raison: 'Commentaires : ancienne détection serverless retirée (APP-PERF-01).' },
  'src/lib/email/email-service.ts': { max: 1, raison: 'Commentaire : repli de logo Supabase remplacé (APP-PERF-38).' },
  'src/lib/runtime-identity.ts': { max: 2, raison: 'Commentaires : plus aucune variable Vercel lue (APP-PERF-37).' },
  'src/services/ai/telemetry/__tests__/execution-context.test.ts': { max: 2, raison: 'Test : VERCEL_GIT_COMMIT_SHA ignorée (APP-PERF-37).' },
  'src/services/ai/telemetry/execution-context.ts': { max: 1, raison: 'Commentaire : plus aucune variable Vercel (APP-PERF-37).' },
  'src/services/scheduling/daily-maintenance-scheduler.ts': { max: 1, raison: 'Documentation : aucune planification dans le dépôt (ni vercel.json…).' },
  'src/app/api/health/__tests__/health-probes.test.ts': { max: 4, raison: 'Test : variables Vercel ignorées par la sonde (APP-PERF-37 T-01).' },
  'src/components/__tests__/ecran-erreur-global.test.ts': { max: 2, raison: 'Test : aucun nom d\'outil historique à l\'écran (APP-PERF-38 T-02).' },
  'src/lib/email/__tests__/logo-repli.test.ts': { max: 3, raison: 'Test : aucun domaine Supabase dans les emails (APP-PERF-38 T-02).' },
  'src/__tests__/residus-historiques.test.ts': { max: Infinity, raison: 'Ce contrôle.' },
};

const IGNORES = new Set(['node_modules', '.next', '.git', 'docs', 'coverage', '.turbo', 'dist', 'build', '.history']);
const FICHIERS_IGNORES = new Set(['package-lock.json', 'tsconfig.tsbuildinfo']);
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|yml|yaml|md|css|html|txt|svg|example)$|^(\.gitignore|\.npmrc|\.buildpacks|Procfile|Aptfile)$/;

function parcourir(dir: string, out: string[]): string[] {
  for (const nom of readdirSync(dir)) {
    if (IGNORES.has(nom)) continue;
    const chemin = join(dir, nom);
    const st = statSync(chemin, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) parcourir(chemin, out);
    else if (!FICHIERS_IGNORES.has(nom) && EXTENSIONS.test(nom) && st.size < 2_000_000) out.push(chemin);
  }
  return out;
}

function occurrences(): Map<string, number> {
  const res = new Map<string, number>();
  for (const f of parcourir(RACINE, [])) {
    const n = (readFileSync(f, 'utf8').match(MOTIF) ?? []).length;
    if (n > 0) res.set(relative(RACINE, f).split(sep).join('/'), n);
  }
  return res;
}

describe('APP-PERF-38 — références historiques Vercel / Supabase / Orchids', () => {
  const trouvees = occurrences();

  it('aucune occurrence hors des exceptions justifiées', () => {
    const horsListe = [...trouvees].filter(([f, n]) => !EXCEPTIONS[f] || n > EXCEPTIONS[f].max)
      .map(([f, n]) => `${f} (${n})`);
    expect(horsListe, 'occurrence nouvelle : la retirer ou la justifier dans EXCEPTIONS').toEqual([]);
  });

  it('aucune dépendance active : ni domaine Supabase/Orchids, ni variable VERCEL lue', () => {
    for (const [f] of trouvees) {
      if (f === 'src/__tests__/residus-historiques.test.ts') continue;
      const src = readFileSync(join(RACINE, f), 'utf8');
      expect(src, f).not.toMatch(/[a-z0-9-]+\.supabase\.co|orchids\.cloud/i);
      if (!f.includes('__tests__')) expect(src, f).not.toMatch(/process\.env\.VERCEL/);
    }
  });

  it('chaque exception a une raison', () => {
    for (const [f, e] of Object.entries(EXCEPTIONS)) expect(e.raison.length, f).toBeGreaterThan(10);
  });
});
