/**
 * Contrôle d'intégrité des CGVU publiées — CDC 7 §16.2 et scénario R09.
 *
 *   npm run legal:verify
 *
 * Destiné à être appelé périodiquement par l'ordonnanceur. Sort en code 1
 * lorsqu'un écart est détecté, pour que l'échec remonte à la supervision.
 *
 * ⚠️ NE RÉPARE RIEN. Le R09 exige que « la version ne soit pas remplacée
 * automatiquement par une autre ». Une restauration se décide, elle ne
 * s'automatise pas : un fichier altéré peut l'avoir été volontairement, et
 * l'écraser détruirait la preuve de l'incident.
 */
// ⚠️ EN PREMIER : `@/db` lit DATABASE_URL au chargement du module.
import '@/lib/load-env';
import { ensureMigrations } from '@/db';
import { verifyIntegrity } from '@/services/legal';

async function main() {
  // Script hors serveur Next : les migrations ne sont pas appliquées seules.
  await ensureMigrations();

  const report = await verifyIntegrity();

  console.log(`[legal] ${report.checked} version(s) publiée(s) contrôlée(s).`);

  if (report.issues.length === 0) {
    console.log('[legal] ✓ Toutes les empreintes correspondent.');
    process.exit(0);
  }

  console.error(`[legal] ✗ ${report.issues.length} écart(s) détecté(s) :`);
  for (const issue of report.issues) {
    console.error(`  · ${issue.versionCode} [${issue.scope}] ${issue.detail}`);
  }
  console.error(
    '\n[legal] Ces écarts sont journalisés (INTEGRITY_FAILED). Restaurez le\n' +
    "        document depuis la sauvegarde et vérifiez son empreinte avant\n" +
    '        remise en ligne (§18). Aucune correction automatique n\'a eu lieu.',
  );
  process.exit(1);
}

main().catch((e) => {
  const cause = (e as { cause?: { message?: string; code?: string } }).cause;
  console.error('[legal] contrôle impossible :', e.message);
  if (cause?.message) {
    console.error(`[legal] cause : ${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
  }
  process.exit(1);
});
