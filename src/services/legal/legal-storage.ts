/**
 * Copie des versions publiées sur le stockage objet — CDC 7 §16.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CETTE COPIE EST UNE SAUVEGARDE, PAS LA SOURCE
 *
 * Le contenu figé fait foi en base (cf. en-tête de la migration 0115). Ce
 * module en dépose un double sur le stockage objet, pour satisfaire
 * l'exigence de « sauvegarde indépendante » du §16.1.
 *
 * Conséquence volontaire : le permalien ne dépend pas de ce stockage. Le §16.3
 * exige que les permaliens « restent stables » et « retournent une page
 * explicite en cas d'incident ». Si le service objet est indisponible, les
 * CGVU restent servies — ce qui n'aurait pas été le cas en faisant l'inverse.
 *
 * L'ÉCRASEMENT EST INTERDIT (§16.1) : la clé est vérifiée avant écriture et
 * une clé déjà occupée fait échouer la publication plutôt que de remplacer un
 * document contractuel.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Clé de stockage d'une version. Unique et non réutilisable (§14.1). */
export function buildLegalStorageKey(documentType: string, versionCode: string): string {
  return `legal/${documentType.toLowerCase()}/${versionCode}.html`;
}

/** Le stockage objet est-il configuré sur cet environnement ? */
export function isObjectStorageConfigured(): boolean {
  return Boolean(
    process.env.OVH_S3_ACCESS_KEY_ID &&
    process.env.OVH_S3_SECRET_ACCESS_KEY &&
    process.env.OVH_S3_BUCKET &&
    process.env.OVH_S3_ENDPOINT,
  );
}

export type MirrorResult =
  | { status: 'written' }
  | { status: 'skipped'; reason: 'not_configured' }
  | { status: 'failed'; reason: string };

/**
 * Dépose le document sur le stockage objet.
 *
 * Import dynamique du client S3 : `src/lib/s3-client.ts` lève à l'import
 * quand les variables d'environnement manquent. Un import statique rendrait
 * tout ce module — et donc la publication — impossible en développement.
 */
export async function mirrorToObjectStorage(
  storageKey: string,
  html: string,
): Promise<MirrorResult> {
  if (!isObjectStorageConfigured()) {
    return { status: 'skipped', reason: 'not_configured' };
  }

  try {
    const [{ s3Client, S3_BUCKET }, { PutObjectCommand, HeadObjectCommand }] =
      await Promise.all([
        import('@/lib/s3-client'),
        import('@aws-sdk/client-s3'),
      ]);

    // Écrasement interdit : une clé occupée fait échouer la publication.
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: storageKey }));
      return {
        status: 'failed',
        reason: `clé déjà occupée : ${storageKey} — une clé de version n'est jamais réutilisée`,
      };
    } catch (headError) {
      const name = (headError as { name?: string }).name;
      // `NotFound` / `NoSuchKey` est le cas nominal : la clé est libre.
      if (name !== 'NotFound' && name !== 'NoSuchKey') throw headError;
    }

    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: storageKey,
        Body: html,
        ContentType: 'text/html; charset=utf-8',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return { status: 'written' };
  } catch (e) {
    return { status: 'failed', reason: (e as Error).message };
  }
}

/** Relit la copie pour le contrôle d'intégrité périodique (§16.2). */
export async function readFromObjectStorage(storageKey: string): Promise<string | null> {
  if (!isObjectStorageConfigured()) return null;

  try {
    const [{ s3Client, S3_BUCKET }, { GetObjectCommand }] = await Promise.all([
      import('@/lib/s3-client'),
      import('@aws-sdk/client-s3'),
    ]);
    const result = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: storageKey }),
    );
    return (await result.Body?.transformToString('utf-8')) ?? null;
  } catch (e) {
    console.warn(`[legal-storage] lecture impossible de ${storageKey} : ${(e as Error).message}`);
    return null;
  }
}
