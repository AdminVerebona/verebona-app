/**
 * Seconde passe : suppression des gardes devenues sans objet.
 *
 * Le jeton n'etant plus lisible en JavaScript, les gardes du type
 *
 *     if (!token) { setError('Non authentifie'); return; }
 *
 * ne peuvent plus fonctionner : le front ne sait plus s'il existe une session
 * avant d'interroger le serveur. Elles sont donc retirees ; l'absence de
 * session se traduit desormais par une reponse 401, traitee par la gestion
 * d'erreur existante.
 *
 * PERIMETRE STRICTEMENT LIMITE AU CODE CLIENT.
 * Cote serveur, la variable `token` designe fréquemment tout autre chose :
 * jeton d'invitation Duo, jeton de transmission, jeton de verification
 * d'adresse electronique, jeton d'acces a un fichier. Y supprimer les gardes
 * casserait des controles de securite legitimes. Les repertoires
 * `src/app/api`, `src/lib` et `src/services` sont donc exclus.
 *
 * Usage :
 *   npx tsx scripts/migrate-auth-guards.ts --dry-run
 *   npx tsx scripts/migrate-auth-guards.ts
 *
 * Puis, imperativement :
 *   npx tsc --noEmit
 *   git diff        // relecture manuelle recommandee
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = join(process.cwd(), 'src');

/** Repertoires exclus : code serveur, ou `token` a d'autres significations. */
const EXCLUDED = ['src/app/api', 'src/lib', 'src/services', 'src/db'];

const TOKEN_VARS = 'token|accessToken|authToken|bearerToken';

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(process.cwd(), full).replace(/\\/g, '/');
    if (EXCLUDED.some((ex) => rel.startsWith(ex))) continue;
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Retire les gardes negatives dont le corps se termine par return ou throw. */
function removeGuards(source: string): { output: string; count: number } {
  const lines = source.split('\n');
  const kept: string[] = [];
  let count = 0;
  let i = 0;

  const openRe = new RegExp(`^(\\s*)if \\(!(?:${TOKEN_VARS})\\) \\{\\s*$`);
  const inlineRe = new RegExp(`^\\s*if \\(!(?:${TOKEN_VARS})\\)\\s*(?:return[^;]*;|throw [^;]+;)\\s*$`);

  while (i < lines.length) {
    const open = openRe.exec(lines[i]);
    if (open) {
      const indent = open[1];
      let close: number | null = null;
      // Chercher la fermeture au meme niveau, dans une fenetre courte.
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        if (lines[j] === `${indent}}`) { close = j; break; }
      }
      if (close !== null) {
        const body = lines.slice(i + 1, close).join('\n');
        // Garde pure uniquement : le corps interrompt le flux.
        if (/\b(return|throw)\b/.test(body)) {
          i = close + 1;
          count++;
          continue;
        }
      }
    }
    if (inlineRe.test(lines[i])) { i++; count++; continue; }
    kept.push(lines[i]);
    i++;
  }

  return { output: kept.join('\n'), count };
}

function main() {
  const files = walk(ROOT);
  let touched = 0;
  let total = 0;
  const review: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    if (!new RegExp(`if \\(!?(?:${TOKEN_VARS})\\)`).test(source)) continue;

    const { output, count } = removeGuards(source);
    if (count > 0) {
      if (!DRY_RUN) writeFileSync(file, output, 'utf-8');
      touched++;
      total += count;
    }

    // Formes positives : `if (token) { ... }` — semantique a repenser.
    if (new RegExp(`if \\((?:${TOKEN_VARS})\\)\\s*\\{`).test(output)) {
      review.push(relative(process.cwd(), file));
    }
  }

  console.log(`\n=== Gardes${DRY_RUN ? ' (simulation)' : ''} ===\n`);
  console.log(`Fichiers modifies : ${touched}`);
  console.log(`Gardes retirees   : ${total}`);

  if (review.length) {
    console.log(`\n--- ${review.length} fichier(s) a reprendre manuellement ---`);
    console.log('Forme `if (token) { ... }` : la presence de session doit');
    console.log('desormais etre obtenue via /api/auth/me ou cote serveur.\n');
    for (const f of review) console.log(`  ${f}`);
  }

  console.log(
    DRY_RUN
      ? '\nSimulation terminee.\n'
      : '\nApplique. Lancer : npx tsc --noEmit puis relire git diff\n',
  );
}

main();
