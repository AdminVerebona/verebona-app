/**
 * Retrait définitif du classement V1 — CDC V2.0 §15.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SCRIPT, PAS UNE MIGRATION
 *
 * Les migrations s'exécutent seules au déploiement. Celle-ci supprime des
 * colonnes : elle partirait donc AVANT que quiconque ait pu constater que la
 * bascule tient sur un compte réel, et c'est la seule opération du chantier
 * qu'un retour arrière de déploiement ne rattrape pas — le code revient, les
 * données non.
 *
 * Ce script est donc manuel, refuse de s'exécuter si le parc n'est pas prêt,
 * et exige une confirmation explicite.
 *
 *   npx tsx scripts/drop-v1-classification.ts            # contrôle seul
 *   npx tsx scripts/drop-v1-classification.ts --confirm  # exécution
 *
 * À faire AVANT : une sauvegarde de la base. Le script le rappelle, il ne peut
 * pas la faire à votre place.
 * ══════════════════════════════════════════════════════════════════════════
 */
import '@/lib/load-env';
import { pgClient, ensureMigrations } from '@/db';

const confirmed = process.argv.includes('--confirm');

async function main() {
  await ensureMigrations();

  // ── 1. Le parc est-il prêt ? ────────────────────────────────────────────
  //
  // `a_retraiter` compte les documents classés en V1 et pas encore en V2.
  // Supprimer les colonnes avec un reste non nul perdrait leur classement
  // sans recours : la Rubrique ne serait plus déductible de rien.
  const rows = (await pgClient.unsafe(
    `SELECT COALESCE(SUM(a_retraiter), 0)::int      AS a_retraiter,
            COALESCE(SUM(version_obsolete), 0)::int AS version_obsolete,
            COALESCE(SUM(total), 0)::int            AS total
       FROM v2_classification_progress`,
  )) as unknown as Array<{ a_retraiter: number; version_obsolete: number; total: number }>;

  const { a_retraiter, version_obsolete, total } = rows[0] ?? {
    a_retraiter: 0, version_obsolete: 0, total: 0,
  };

  console.log(`Parc documentaire : ${total} documents`);
  console.log(`  classés en V1 sans équivalent V2 : ${a_retraiter}`);
  console.log(`  version de référentiel obsolète  : ${version_obsolete}`);

  if (a_retraiter > 0) {
    console.error(
      `\n✗ Retrait refusé : ${a_retraiter} document(s) n'ont pas de Rubrique V2.\n` +
        '  Lancer /api/cron/documents/referential-upgrade jusqu\'à ce que ce\n' +
        '  nombre atteigne 0, puis relancer ce script.',
    );
    process.exit(1);
  }

  if (!confirmed) {
    console.log(
      '\nContrôle passé. Rien n\'a été supprimé.\n' +
        'Faire une sauvegarde de la base, puis relancer avec --confirm.',
    );
    process.exit(0);
  }

  // ── 2. Retrait ──────────────────────────────────────────────────────────
  //
  // Les colonnes d'abord, les tables de référentiel ensuite : l'inverse
  // échouerait sur les clés étrangères, et laisserait le schéma à moitié
  // migré — l'état le plus difficile à diagnostiquer.
  console.log('\nRetrait des colonnes V1…');
  await pgClient.unsafe(`
    ALTER TABLE asset_files
      DROP COLUMN IF EXISTS document_category_id,
      DROP COLUMN IF EXISTS classification_state,
      DROP COLUMN IF EXISTS category_confidence,
      DROP COLUMN IF EXISTS type_confidence,
      DROP COLUMN IF EXISTS category_source,
      DROP COLUMN IF EXISTS type_source,
      DROP COLUMN IF EXISTS category_user_locked,
      DROP COLUMN IF EXISTS type_user_locked;
  `);

  console.log('Retrait du référentiel en base…');
  await pgClient.unsafe(`
    DROP TABLE IF EXISTS document_category_type_associations;
    DROP TABLE IF EXISTS document_category_asset_associations;
    DROP TABLE IF EXISTS document_categories CASCADE;
  `);

  console.log('\n✓ Classement V1 retiré. Pensez à supprimer du code :');
  console.log('  · src/services/documents/classification-rules.ts');
  console.log('  · src/services/documents/classification.service.ts');
  console.log('  · src/services/documents/reclassify.service.ts');
  console.log('  · src/services/ai/source-analysis/steps/classify-category.step.ts');
  console.log('  · src/db/seeds/documents/, src/app/api/admin/document-categories/');
  console.log('  · les pages /documents/classement et l\'onglet V1 de « À traiter »');

  process.exit(0);
}

main().catch((e) => {
  console.error('Échec :', e);
  process.exit(1);
});
