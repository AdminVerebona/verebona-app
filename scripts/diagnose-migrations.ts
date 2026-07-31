/**
 * Diagnostic de la chaîne de migrations.
 *
 *   npm run db:diagnose
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE SCRIPT
 *
 * Une préproduction a remonté 49 migrations en échec sur 51. Ce n'est jamais
 * 49 causes distinctes : c'est une cascade. Une table absente fait échouer
 * toutes celles qui la référencent, et le bruit masque la cause.
 *
 * Ce script rejoue chaque migration en attente DANS UNE TRANSACTION ANNULÉE,
 * et rapporte l'erreur exacte de chacune sans rien modifier. On voit alors,
 * en une exécution, laquelle a rompu la chaîne et pourquoi.
 *
 * ── IL N'ÉCRIT RIEN ───────────────────────────────────────────────────────
 *
 * Chaque essai s'exécute dans un `BEGIN` suivi d'un `ROLLBACK` systématique.
 * Une migration qui réussirait en essai n'est pas appliquée pour autant :
 * diagnostiquer et corriger sont deux gestes distincts, et les confondre sur
 * une base de production serait imprudent.
 * ══════════════════════════════════════════════════════════════════════════
 */
import '@/lib/load-env';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
// ⚠️ On réutilise LE client de l'application, on n'en crée pas un second.
//
// La première version appelait `postgres(url)` avec les options par défaut.
// Sur un pooler Supabase, la connexion était refusée avec
// « tenant/user postgres.<ref> not found » : le pooler en mode transaction
// exige `prepare: false`, et l'application le configure déjà.
//
// Recréer un client, c'est dupliquer une configuration qui finira par
// diverger — et diverger justement sur l'outil censé diagnostiquer.
import { pgClient } from '@/db';

interface Essai {
  filename: string;
  verdict: 'appliquée' | 'réussirait' | 'échoue';
  code?: string;
  message?: string;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[db] DATABASE_URL absente.');
    process.exit(1);
  }

  const client = pgClient;
  const dir = join(process.cwd(), 'src', 'db', 'migrations');

  // ⚠️ AFFICHER LA CIBLE, TOUJOURS.
  //
  // Un diagnostic exécuté depuis un poste lit `.env.local`, qui ne désigne pas
  // forcément la base dont on observe les symptômes. Sans cette ligne, on
  // compare les résultats de deux bases différentes en croyant parler de la
  // même — et on tire des conclusions fausses.
  //
  // Le mot de passe est retiré : cette sortie finit dans des copier-coller.
  try {
    const cible = new URL(process.env.DATABASE_URL!);
    console.log(
      `\n[db] Cible : ${cible.username.split('.')[0]}@${cible.hostname}${cible.pathname}\n` +
      `     Projet : ${cible.username.includes('.') ? cible.username.split('.')[1] : '—'}\n`,
    );
  } catch {
    console.log('\n[db] Cible : URL non analysable.\n');
  }

  try {
    const fichiers = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    let appliquees: Set<string>;
    try {
      appliquees = new Set(
        (await client<{ filename: string }[]>`SELECT filename FROM _migrations`)
          .map((r) => r.filename),
      );
    } catch (e) {
      // ⚠️ NE CONCLURE QUE SUR LE CODE QUI LE DIT.
      //
      // Un `catch` nu concluait « table absente » sur n'importe quelle erreur —
      // droits insuffisants, connexion coupée, schéma de recherche mal réglé.
      // Un diagnostic qui se trompe de cause est pire qu'aucun diagnostic.
      const code = (e as { code?: string }).code;
      if (code !== '42P01') {
        console.error(
          `\n[db] Lecture de \`_migrations\` impossible (${code ?? 'sans code'}) :\n` +
          `     ${(e as Error).message}\n\n` +
          "     Ce n'est PAS un diagnostic de migration : la table existe peut-être,\n" +
          '     mais elle est illisible. Vérifiez les droits du compte de connexion.\n',
        );
        process.exit(1);
      }
      console.log(
        '[db] ⚠ La table `_migrations` n’existe pas : aucune migration n’a jamais\n' +
        '     été enregistrée sur CETTE base. Si la préproduction en signale,\n' +
        '     c’est que vous ne diagnostiquez pas la même — comparez la cible\n' +
        '     affichée ci-dessus à celle du déploiement.\n',
      );
      appliquees = new Set();
    }

    console.log(`\n[db] ${fichiers.length} migration(s), ${appliquees.size} déjà appliquée(s).\n`);

    const essais: Essai[] = [];

    let traites = 0;
    for (const fichier of fichiers) {
      traites += 1;
      // Une campagne de cinquante essais sur un pooler distant demande une
      // minute ou deux : sans progression, on croit le script bloqué.
      if (traites % 10 === 0) {
        process.stdout.write(`  … ${traites}/${fichiers.length}\r`);
      }
      if (appliquees.has(fichier)) {
        essais.push({ filename: fichier, verdict: 'appliquée' });
        continue;
      }

      const sql = await readFile(join(dir, fichier), 'utf-8');

      try {
        // Transaction systématiquement annulée : on mesure, on ne corrige pas.
        await client.begin(async (tx) => {
          await tx.unsafe(sql);
          throw new Error('__ROLLBACK__');
        });
        essais.push({ filename: fichier, verdict: 'réussirait' });
      } catch (e) {
        const err = e as { message?: string; code?: string };
        if (err.message === '__ROLLBACK__') {
          essais.push({ filename: fichier, verdict: 'réussirait' });
        } else {
          essais.push({
            filename: fichier,
            verdict: 'échoue',
            code: err.code,
            message: (err.message ?? String(e)).split('\n')[0].slice(0, 200),
          });
        }
      }
    }

    const enEchec = essais.filter((e) => e.verdict === 'échoue');
    const reussiraient = essais.filter((e) => e.verdict === 'réussirait');

    for (const e of essais) {
      if (e.verdict === 'appliquée') continue;
      const marque = e.verdict === 'réussirait' ? '✓' : '✗';
      console.log(`  ${marque} ${e.filename}`);
      if (e.verdict === 'échoue') {
        console.log(`      ${e.code ?? 'sans code'} — ${e.message}`);
      }
    }

    console.log(
      `\n[db] ${reussiraient.length} passerai(en)t, ${enEchec.length} échoue(nt).\n`,
    );

    if (enEchec.length > 0) {
      const premier = enEchec[0];
      console.log('  ── À CORRIGER EN PREMIER ──────────────────────────────');
      console.log(`  ${premier.filename}`);
      console.log(`  ${premier.code ?? 'sans code'} — ${premier.message}\n`);
      console.log(
        '  Les migrations étant appliquées dans l\'ordre, les échecs suivants\n' +
        '  découlent souvent de celui-ci : une table absente fait échouer\n' +
        '  toutes celles qui la référencent.\n',
      );

      // Regroupement par code : un même code sur trente fichiers désigne une
      // cause unique, pas trente problèmes.
      const parCode = new Map<string, number>();
      for (const e of enEchec) parCode.set(e.code ?? 'sans code', (parCode.get(e.code ?? 'sans code') ?? 0) + 1);
      console.log('  Répartition des causes :');
      for (const [code, n] of [...parCode.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${code.padEnd(10)} ${n} migration(s)`);
      }
      console.log('');
    }

    process.exit(enEchec.length > 0 ? 1 : 0);
  } finally {
    // Le client est partagé avec l'application : on le ferme car ce script
    // est un processus court, mais jamais depuis du code applicatif.
    await client.end();
  }
}

main().catch((e) => {
  console.error('[db] diagnostic impossible :', (e as Error).message);
  process.exit(1);
});
