/**
 * Migration automatique : suppression des jetons lus dans le localStorage.
 *
 * Transforme le motif historique
 *
 *     const token = localStorage.getItem('bearer_token');
 *     if (!token) return;
 *     fetch(url, { headers: { Authorization: `Bearer ${token}` } })
 *
 * en son equivalent par cookies HttpOnly
 *
 *     fetch(url, { credentials: 'include' })
 *
 * Les appels etant en meme origine, le navigateur transmet automatiquement
 * les cookies de session : aucun en-tete d'autorisation n'est necessaire.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TROIS GARDE-FOUS, AJOUTES APRES DEGATS CONSTATES
 *
 * La premiere version de ce script a casse l'authentification serveur. Elle
 * supprimait TOUTE garde `if (!token)`, sans verifier d'ou venait la variable.
 * Trois fichiers en ont fait les frais :
 *
 *   · src/lib/auth.ts — `getCurrentUser` a perdu son garde-fou. Sans lui,
 *     toute requete anonyme leve au lieu de rendre `null` : chaque appel non
 *     authentifie serait devenu une erreur 500 ;
 *   · src/lib/session-service.ts — meme faute sur la verification de session ;
 *   · src/app/api/auth/verify-email/route.ts — la garde portait sur le jeton
 *     recu par email, dans la query string. Sans elle, un lien tronque
 *     produisait une exception au lieu d'une redirection propre.
 *
 * Dans les trois cas, `token` designait un jeton SERVEUR — en-tete HTTP,
 * cookie, parametre d'URL — sans le moindre rapport avec le stockage du
 * navigateur. Le script ne regardait que le nom de la variable.
 *
 * D'ou :
 *
 *   1. LES FICHIERS SERVEUR SONT EXCLUS. Routes d'API, services, couche
 *      d'authentification et scripts ne touchent jamais au localStorage : ils
 *      n'ont rien a migrer, et tout a perdre.
 *
 *   2. SEULS LES FICHIERS CONTENANT `localStorage` SONT TRAITES. Un fichier
 *      qui n'y accede pas n'a par definition aucun jeton de navigateur.
 *
 *   3. LES GARDES SUPPRIMEES SONT CELLES DES VARIABLES QUE LE SCRIPT VIENT
 *      LUI-MEME DE SUPPRIMER. C'est le garde-fou decisif : une garde ne
 *      disparait que si la lecture qui la justifiait a disparu dans le meme
 *      fichier, au meme passage.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Usage :
 *   npx tsx src/scripts/migrate-auth-storage.ts --dry-run   # simulation
 *   npx tsx src/scripts/migrate-auth-storage.ts             # application
 *
 * Le script est volontairement conservateur : il ne modifie que les motifs
 * exacts et signale les fichiers necessitant une relecture manuelle.
 * Lancer `npx tsc --noEmit` apres application pour detecter les references
 * residuelles.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { readdirSync, statSync } from 'fs';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = join(process.cwd(), 'src');

/** Noms de variables rencontres pour le jeton. */
const TOKEN_VARS = ['token', 'accessToken', 'authToken', 'bearerToken'];

/**
 * Chemins ou une variable nommee `token` designe un jeton SERVEUR.
 *
 * Aucun de ces fichiers ne lit le stockage du navigateur — il n'existe pas
 * cote serveur. Les exclure supprime toute possibilite de recidive.
 */
const SERVER_PATHS = [
  'src/app/api/',        // routes : jeton d'en-tete, de cookie ou d'URL
  'src/services/',       // services metier, executes cote serveur
  'src/lib/auth',        // auth.ts, auth-guards.ts, auth-migration.ts
  'src/lib/session',     // session-service.ts
  'src/lib/jwt',
  'src/db/',
  'src/scripts/',        // dont ce script lui-meme
  'src/middleware',
];

function isServerFile(file: string): boolean {
  const rel = relative(process.cwd(), file).replace(/\\/g, '/');
  return SERVER_PATHS.some((p) => rel.startsWith(p));
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

interface Report {
  file: string;
  removedReads: number;
  removedGuards: number;
  removedHeaders: number;
  addedCredentials: number;
  needsReview: string[];
}

function migrate(source: string): { output: string; report: Omit<Report, 'file'> } {
  let out = source;
  const review: string[] = [];
  let removedReads = 0;
  let removedGuards = 0;
  let removedHeaders = 0;
  let addedCredentials = 0;

  const vars = TOKEN_VARS.join('|');

  // 1. Lecture du jeton — suppression de la ligne entiere.
  //
  //    Les noms des variables supprimees sont MEMORISES : c'est eux, et eux
  //    seuls, qui autoriseront la suppression d'une garde a l'etape 2.
  const removedVars = new Set<string>();

  out = out.replace(
    new RegExp(`^[ \\t]*const (${vars}) = (?:typeof window !== 'undefined' \\? )?localStorage\\.getItem\\(['"]bearer_token['"]\\)[^\\n]*;[ \\t]*\\r?\\n`, 'gm'),
    (_m, name: string) => { removedReads++; removedVars.add(name); return ''; },
  );

  // 2. Gardes des SEULES variables supprimees ci-dessus.
  //
  //    C'est ici que la premiere version du script a casse l'authentification
  //    serveur : elle supprimait toute garde `if (!token)` sur la foi du seul
  //    nom de variable, y compris quand `token` venait d'un en-tete HTTP ou
  //    d'une query string. Une garde ne disparait desormais que si la lecture
  //    qui la justifiait a disparu dans le meme fichier, au meme passage.
  if (removedVars.size > 0) {
    const removed = [...removedVars].join('|');
    out = out.replace(
      new RegExp(`^[ \\t]*if \\(!(?:${removed})\\) \\{?\\s*return(?: [^;]*)?;\\s*\\}?[ \\t]*\\r?\\n`, 'gm'),
      () => { removedGuards++; return ''; },
    );
  }

  // 3. En-tetes d'autorisation
  //    3a. objet headers reduit au seul Authorization
  out = out.replace(
    new RegExp(`headers:\\s*\\{\\s*['"\`]?Authorization['"\`]?:\\s*\`Bearer \\$\\{(?:${vars})\\}\`,?\\s*\\}`, 'g'),
    () => { removedHeaders++; addedCredentials++; return `credentials: 'include'`; },
  );
  //    3b. entree Authorization au milieu d'autres en-tetes
  out = out.replace(
    new RegExp(`^[ \\t]*['"\`]?Authorization['"\`]?:\\s*\`Bearer \\$\\{(?:${vars})\\}\`,?[ \\t]*\\r?\\n`, 'gm'),
    () => { removedHeaders++; return ''; },
  );

  // 4. credentials: 'include' sur les fetch internes qui n'en ont pas
  //
  //    Le test portait sur le seul fragment capture — soit `fetch(url, {` —
  //    qui ne contient jamais `credentials`. Il ajoutait donc l'option meme
  //    quand elle figurait deja quelques lignes plus bas, produisant un
  //    littéral d'objet avec deux fois la meme propriete : erreur TS1117.
  //
  //    Le contrôle porte desormais sur le CORPS de l'objet d'options.
  out = out.replace(
    /fetch\((['"`])(\/api\/[^'"`]*)\1,\s*\{\s*\r?\n/g,
    (match, _q, _url, offset: number) => {
      // Fenetre de lecture couvrant l'objet d'options qui suit l'accolade.
      const corps = out.slice(offset, offset + 600);
      const fin = corps.indexOf('})');
      const options = fin === -1 ? corps : corps.slice(0, fin);
      if (/credentials\s*:/.test(options)) return match;
      addedCredentials++;
      return match.replace(/\{\s*\r?\n/, `{\n      credentials: 'include',\n`);
    },
  );

  // 5. fetch sans options du tout
  out = out.replace(
    /fetch\((['"`])(\/api\/[^'"`]*)\1\)/g,
    (_m, q, url) => { addedCredentials++; return `fetch(${q}${url}${q}, { credentials: 'include' })`; },
  );

  // 3c. en-tetes conditionnels : headers: token ? { Authorization: ... } : {}
  out = out.replace(
    new RegExp(`^[ \\t]*headers:\\s*(?:${vars})\\s*\\?\\s*\\{\\s*['"\`]?Authorization['"\`]?:\\s*\`Bearer \\$\\{(?:${vars})\\}\`\\s*\\}\\s*:\\s*\\{\\s*\\},?[ \\t]*\\r?\\n`, 'gm'),
    () => { removedHeaders++; return ''; },
  );

  // 3d. objet headers devenu vide
  out = out.replace(/^[ \t]*headers:\s*\{\s*\},?[ \t]*\r?\n/gm, '');

  // 5b. deduplication de credentials dans un meme objet
  out = out.replace(
    /(credentials:\s*'include',[^\n]*\n)((?:[ \t]*[^\n]*\n){0,3}?)[ \t]*credentials:\s*'include',[^\n]*\n/g,
    (_m, first, middle) => first + middle,
  );

  // 6. Signalements pour relecture manuelle
  if (/localStorage\.(get|set|remove)Item\(\s*['"](bearer_token|refresh_token|user)['"]/.test(out)) {
    review.push('acces localStorage residuel');
  }
  if (new RegExp(`Bearer \\$\\{(?:${vars})\\}`).test(out)) {
    review.push('en-tete Bearer residuel');
  }
  // Une garde subsistante n'est signalee que si le fichier accede encore au
  // stockage : ailleurs, elle porte sur autre chose et doit rester en place.
  if (/localStorage|sessionStorage/.test(out)
      && new RegExp(`if \\(!(?:${vars})\\)`).test(out)) {
    review.push('garde conditionnelle a reecrire');
  }

  return {
    output: out,
    report: { removedReads, removedGuards, removedHeaders, addedCredentials, needsReview: review },
  };
}

function main() {
  const files = walk(ROOT);
  const reports: Report[] = [];

  let skippedServer = 0;

  for (const file of files) {
    // Garde-fou 1 : les fichiers serveur n'ont rien a migrer, et tout a
    // perdre. Ils ne lisent jamais le stockage du navigateur.
    if (isServerFile(file)) { skippedServer++; continue; }

    const source = readFileSync(file, 'utf-8');

    // Garde-fou 2 : sans acces au stockage, aucun jeton de navigateur.
    // Ce test seul aurait epargne les trois fichiers casses.
    if (!/localStorage|sessionStorage/.test(source)) continue;

    if (!/bearer_token|Bearer \$\{/.test(source)) continue;

    const { output, report } = migrate(source);
    if (output === source) continue;

    if (!DRY_RUN) writeFileSync(file, output, 'utf-8');
    reports.push({ file: relative(process.cwd(), file), ...report });
  }

  console.log(`\n=== Migration${DRY_RUN ? ' (simulation)' : ''} ===\n`);

  const totals = { reads: 0, guards: 0, headers: 0, creds: 0 };
  const toReview: Report[] = [];

  for (const r of reports) {
    totals.reads += r.removedReads;
    totals.guards += r.removedGuards;
    totals.headers += r.removedHeaders;
    totals.creds += r.addedCredentials;
    if (r.needsReview.length) toReview.push(r);
  }

  console.log(`Fichiers modifies      : ${reports.length}`);
  console.log(`Fichiers serveur exclus: ${skippedServer}`);
  console.log(`Lectures supprimees    : ${totals.reads}`);
  console.log(`Gardes supprimees      : ${totals.guards}`);
  console.log(`En-tetes supprimes     : ${totals.headers}`);
  console.log(`credentials ajoutes    : ${totals.creds}`);

  if (toReview.length) {
    console.log(`\n--- ${toReview.length} fichier(s) a relire manuellement ---`);
    for (const r of toReview) {
      console.log(`  ${r.file}`);
      for (const reason of r.needsReview) console.log(`      · ${reason}`);
    }
  }

  console.log(
    DRY_RUN
      ? '\nSimulation terminee. Relancer sans --dry-run pour appliquer.\n'
      : '\nApplique. Lancer maintenant : npx tsc --noEmit\n',
  );
}

main();
