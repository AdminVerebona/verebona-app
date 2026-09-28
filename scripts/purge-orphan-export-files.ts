/**
 * Script ponctuel — fichiers S3 des exports supprimés AVANT le lot 7.
 *
 *   npx tsx scripts/purge-orphan-export-files.ts           # simulation (défaut)
 *   npx tsx scripts/purge-orphan-export-files.ts --apply   # programme la purge
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IDENTIFICATION (fiable)
 *
 * L'ancien DELETE passait l'export au statut `deleted` SANS toucher à
 * `output_payload` : les clés `pdfS3Key` / `zipS3Key` y sont restées et les
 * objets n'ont jamais été supprimés. Le nouveau DELETE (DRH-004) remplace
 * `output_payload` par `{ fileDeletedAt, … }`, sans aucune clé.
 *
 * Une ligne `status = 'deleted'` dont `output_payload` contient encore une
 * clé de stockage est donc, sans ambiguïté, une suppression de l'ancien
 * comportement. Garde-fou supplémentaire : seules les clés sous `exports/`
 * sont retenues (jamais un fichier de bien).
 *
 * ACTION (--apply), par ligne et dans une transaction :
 *   · les clés sont ajoutées à `pending_blob_deletions` (échéance immédiate,
 *     sauf si déjà en attente) — la purge quotidienne `daily-blob-purge` les
 *     supprime ; un objet déjà absent est traité comme supprimé ;
 *   · `output_payload` est réécrit au nouveau format (sans clé) : l'entrée
 *     reste dans l'historique et un second passage ne trouve plus rien.
 *
 * Sans --apply, rien n'est écrit : le script liste les lignes et les clés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import '@/lib/load-env';
import { db } from '@/db';
import { exportGenerations, pendingBlobDeletions } from '@/db/schema';
import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { exportStorageKeys } from '@/services/assets/asset-deletion.service';

/** Clés d'export encore présentes dans un payload (préfixe `exports/` seulement). */
export function legacyExportKeys(outputPayload: string | null): string[] {
  return exportStorageKeys(outputPayload).filter((k) => k.startsWith('exports/'));
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.info(`[purge-orphan-export-files] mode : ${apply ? 'APPLICATION' : 'simulation (ajouter --apply pour agir)'}`);

  const rows = await db
    .select({ id: exportGenerations.id, assetId: exportGenerations.assetId, outputPayload: exportGenerations.outputPayload })
    .from(exportGenerations)
    .where(and(eq(exportGenerations.status, 'deleted'), isNotNull(exportGenerations.outputPayload)));

  const candidats = rows
    .map((r) => ({ ...r, keys: legacyExportKeys(r.outputPayload) }))
    .filter((r) => r.keys.length > 0);

  const totalKeys = candidats.reduce((n, r) => n + r.keys.length, 0);
  console.info(`[purge-orphan-export-files] ${candidats.length} export(s) supprimé(s) avec fichier(s) conservé(s), ${totalKeys} objet(s).`);
  for (const r of candidats) console.info(`  export #${r.id} (bien #${r.assetId}) : ${r.keys.join(', ')}`);

  if (!apply || candidats.length === 0) return;

  let queued = 0;
  for (const r of candidats) {
    const now = new Date();
    await db.transaction(async (tx) => {
      const deja = await tx
        .select({ storagePath: pendingBlobDeletions.storagePath })
        .from(pendingBlobDeletions)
        .where(and(inArray(pendingBlobDeletions.storagePath, r.keys), isNull(pendingBlobDeletions.processedAt)));
      const enAttente = new Set(deja.map((d) => d.storagePath));
      const aAjouter = r.keys.filter((k) => !enAttente.has(k));
      if (aAjouter.length > 0) {
        await tx.insert(pendingBlobDeletions).values(
          aAjouter.map((storagePath) => ({ fileId: null, storagePath, scheduledFor: now, createdAt: now })),
        );
        queued += aAjouter.length;
      }
      await tx
        .update(exportGenerations)
        .set({ outputPayload: JSON.stringify({ fileDeletedAt: now.toISOString(), legacyPurge: true }) })
        .where(and(eq(exportGenerations.id, r.id), eq(exportGenerations.status, 'deleted')));
    });
  }
  console.info(`[purge-orphan-export-files] ${queued} objet(s) confié(s) à la file de purge.`);
}

// Exécution directe uniquement (le module est aussi importé par les tests).
if (process.argv[1]?.includes('purge-orphan-export-files')) {
  main()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[purge-orphan-export-files] échec :', e); process.exit(1); });
}
