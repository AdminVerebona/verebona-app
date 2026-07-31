/**
 * Reprise mécanique du classement — CDC 5 §4.3 règle 1.
 *
 *   npm run db:reclassify -- --dry-run     # rapporte sans écrire
 *   npm run db:reclassify                  # applique
 *   npm run db:reclassify -- --account=42  # limité à un compte
 *
 * Ne consomme aucun appel modèle : il ne s'agit que de déduction depuis le
 * référentiel. Un type qui n'admet qu'une seule catégorie la reçoit.
 *
 * ⚠️ Toujours lancer une première fois en `--dry-run` : la sortie indique
 * combien de documents seraient classés et lesquels resteraient ambigus.
 */
import '@/lib/load-env';
import { ensureMigrations, getMigrationFailures } from '@/db';
import {
  reclassifyUnclassifiedDocuments,
  classificationCounts,
} from '@/services/documents/reclassify.service';

async function main() {
  await ensureMigrations();

  const echecs = getMigrationFailures();
  if (echecs.length > 0) {
    console.error(
      `[reclassify] ${echecs.length} migration(s) en échec — schéma incomplet.\n` +
      `             Première : ${echecs[0].filename} (${echecs[0].code ?? 'sans code'})`,
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const compte = args.find((a) => a.startsWith('--account='));
  const accountId = compte ? Number(compte.split('=')[1]) : undefined;

  const avant = await classificationCounts(accountId);
  console.log(
    `\n[reclassify] Avant : ${avant.total} document(s), ` +
    `${avant.classified} classé(s), ${avant.toClassify} à classer.\n`,
  );

  if (avant.toClassify === 0) {
    console.log('[reclassify] Rien à reprendre.\n');
    process.exit(0);
  }

  const rapport = await reclassifyUnclassifiedDocuments({ accountId, dryRun });

  console.log(`  Examinés                     ${rapport.examined}`);
  console.log(`  Classés par déduction        ${rapport.classified}`);
  console.log(`  Type ambigu, laissés         ${rapport.ambiguous}`);
  console.log(`  Type inconnu ou absent       ${rapport.skippedNoType}`);
  console.log(`  Catégorie inapplicable       ${rapport.skippedNotApplicable}`);

  const parCategorie = Object.entries(rapport.byCategory).sort((a, b) => b[1] - a[1]);
  if (parCategorie.length > 0) {
    console.log('\n  Répartition :');
    for (const [code, n] of parCategorie) console.log(`    ${code.padEnd(30)} ${n}`);
  }

  if (dryRun) {
    console.log('\n[reclassify] Simulation — rien n\'a été écrit.');
    console.log('             Relancer sans --dry-run pour appliquer.\n');
    process.exit(0);
  }

  const apres = await classificationCounts(accountId);
  console.log(
    `\n[reclassify] Après : ${apres.classified} classé(s), ${apres.toClassify} à classer.\n`,
  );
  console.log(
    '  Les documents restants attendent le traitement de cohérence par l\'IA\n' +
    '  (§7.2), qui suppose la bascule de AI_UNIFIED_SOURCE_ANALYSIS.\n',
  );
  process.exit(0);
}

main().catch((e) => {
  const cause = (e as { cause?: { message?: string } }).cause;
  console.error('[reclassify] échec :', e.message);
  if (cause?.message) console.error('[reclassify] cause :', cause.message);
  process.exit(1);
});
