/**
 * Purge des téléversements jamais confirmés.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * D'OÙ VIENNENT CES LIGNES
 *
 * `/api/files/presign` crée la ligne `asset_files` AVANT le transfert vers le
 * stockage, pour disposer d'un identifiant à mettre dans la clé S3. Le
 * transfert a lieu ensuite, directement du navigateur vers le stockage, puis
 * `/api/files/confirm` bascule la ligne en `COMPLETED`.
 *
 * Entre les deux, tout peut s'arrêter : onglet fermé, réseau coupé, refus
 * CORS du bucket, transfert annulé. La ligne reste alors en `PENDING`, pour
 * toujours. Les vignettes de biens empruntent le même chemin.
 *
 * Ces lignes sont invisibles partout — toutes les lectures filtrent sur
 * `upload_status` — mais elles s'accumulent, et une seule requête qui oublie
 * ce filtre les fait resurgir. C'est arrivé : le compteur de documents de
 * l'écran d'abonnement annonçait « 2 documents » à un compte qui n'en avait
 * aucun.
 *
 * ── POURQUOI UNE SUPPRESSION LOGIQUE ET NON UN DELETE ─────────────────────
 *
 * La ligne est marquée `deleted_at`, pas effacée. Trois raisons :
 *   · c'est la politique de l'application pour tout fichier, et la déroger
 *     ici créerait un deuxième régime à retenir ;
 *   · `asset_files` est référencée par les liaisons agenda, les sources
 *     d'analyse et les suppressions différées — un DELETE demanderait de
 *     vérifier chacune ;
 *   · une purge trop ancienne resterait rattrapable, ce qu'un DELETE interdit.
 *
 * L'objet de stockage, lui, est programmé pour suppression immédiate via
 * `pending_blob_deletions` : s'il existe, personne ne le réclamera jamais —
 * le transfert n'a pas été confirmé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { assetFiles, pendingBlobDeletions } from '@/db/schema';
import { and, eq, isNull, lt, inArray } from 'drizzle-orm';

/**
 * Délai de grâce. Un téléversement en cours ne doit jamais être purgé sous
 * les pieds de l'utilisateur : 24 h laissent largement de quoi finir une
 * vidéo de 500 Mo sur une connexion lente, reprise comprise.
 */
const DEFAULT_GRACE_HOURS = 24;

/** Plafond par tour, pour ne pas tenir une transaction trop longtemps. */
const DEFAULT_LIMIT = 500;

export interface PendingUploadsPurgeResult {
  found: number;
  purged: number;
  blobsScheduled: number;
}

export async function purgePendingUploads(options?: {
  graceHours?: number;
  limit?: number;
}): Promise<PendingUploadsPurgeResult> {
  const graceHours = options?.graceHours ?? DEFAULT_GRACE_HOURS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const seuil = new Date(Date.now() - graceHours * 60 * 60 * 1000);

  const result: PendingUploadsPurgeResult = { found: 0, purged: 0, blobsScheduled: 0 };

  const candidats = await db
    .select({ id: assetFiles.id, s3Key: assetFiles.s3Key })
    .from(assetFiles)
    .where(
      and(
        eq(assetFiles.uploadStatus, 'PENDING'),
        isNull(assetFiles.deletedAt),
        lt(assetFiles.createdAt, seuil),
      ),
    )
    .limit(limit);

  result.found = candidats.length;
  if (candidats.length === 0) return result;

  const maintenant = new Date();

  // Programmation de la suppression des objets de stockage. `temp` est la
  // valeur posée par le presign avant de connaître l'identifiant : elle ne
  // désigne aucun objet réel, il ne faut surtout pas l'envoyer au purgeur.
  const aSupprimer = candidats.filter(
    (c) => c.s3Key && c.s3Key !== 'temp',
  );

  if (aSupprimer.length > 0) {
    try {
      await db.insert(pendingBlobDeletions).values(
        aSupprimer.map((c) => ({
          fileId: c.id,
          storagePath: c.s3Key as string,
          // Immédiat : un transfert non confirmé n'a pas de valeur à conserver.
          scheduledFor: maintenant,
          createdAt: maintenant,
        })),
      );
      result.blobsScheduled = aSupprimer.length;
    } catch (err) {
      // Le nettoyage du stockage est accessoire : mieux vaut un objet orphelin
      // qu'une ligne fantôme conservée parce que la programmation a échoué.
      console.error('[pending-uploads-purge] programmation des blobs échouée :', err);
    }
  }

  const ids = candidats.map((c) => c.id);
  await db
    .update(assetFiles)
    .set({ deletedAt: maintenant, updatedAt: maintenant })
    .where(inArray(assetFiles.id, ids));

  result.purged = ids.length;

  console.info(
    `[pending-uploads-purge] ${result.purged} téléversement(s) jamais confirmé(s) purgé(s), ` +
    `${result.blobsScheduled} objet(s) de stockage programmé(s) — seuil ${graceHours} h.`,
  );

  return result;
}

/** Nombre de lignes purgeables, sans rien modifier. Utile pour un contrôle. */
export async function countPendingUploads(graceHours = DEFAULT_GRACE_HOURS): Promise<number> {
  const seuil = new Date(Date.now() - graceHours * 60 * 60 * 1000);
  const rows = await db
    .select({ id: assetFiles.id })
    .from(assetFiles)
    .where(
      and(
        eq(assetFiles.uploadStatus, 'PENDING'),
        isNull(assetFiles.deletedAt),
        lt(assetFiles.createdAt, seuil),
      ),
    );
  return rows.length;
}
