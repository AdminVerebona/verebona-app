/**
 * Stockage des dossiers générés (OVH S3, préfixe `exports/`) et liens de
 * téléchargement (DRH-005/006/010).
 *
 * Clé : `exports/{accountId}/{assetId}/{generationId}/{fichier}` (préfixe
 * historique, déjà couvert par la purge des biens et des comptes). Le fichier
 * est envoyé en flux depuis le disque. Le téléchargement ne passe JAMAIS par
 * une URL signée émise à l'avance : l'endpoint `/download` revérifie les
 * droits et l'expiration à chaque demande, puis redirige vers une URL signée
 * de courte durée (`EXPORTS_DOWNLOAD_URL_TTL_S`, 60 s par défaut).
 */

import fs from 'node:fs';

/**
 * Même préfixe que `export-upload.service` (sans charger le client S3 à
 * l'import). `attempt` : numéro d'exécution — chaque exécution écrit sous
 * `…/{generationId}/a{attempt}/`, si bien qu'une exécution dépossédée peut
 * supprimer ses propres objets sans jamais toucher à ceux de l'exécution qui
 * l'a remplacée.
 */
export function buildExportS3Key(accountId: number, assetId: number, generationId: number, filename: string, attempt?: number | null): string {
  return `exports/${accountId}/${assetId}/${generationId}/${attempt ? `a${attempt}/` : ''}${filename}`;
}

/** Durée de disponibilité d'un dossier généré (DRH-005). */
export const EXPORT_RETENTION_DAYS = 30;

export const downloadUrlTtlSeconds = (): number => {
  const n = Number(process.env.EXPORTS_DOWNLOAD_URL_TTL_S);
  return Number.isFinite(n) && n >= 10 && n <= 3600 ? Math.floor(n) : 60;
};

export type UploadFn = (localPath: string, key: string, contentType: string) => Promise<void>;

type S3ClientType = import('@aws-sdk/client-s3').S3Client;

/**
 * Client S3 des générations : profil `worker` de la fabrique centrale
 * (`@/lib/s3-config`, APP-PERF-26) — même endpoint, région, bucket et mode
 * d'adressage que le reste de l'application, avec délais de connexion et
 * d'inactivité et 3 tentatives : un stockage qui ne répond plus fait échouer
 * l'étape (erreur transitoire, nouvelle tentative) au lieu de bloquer le
 * worker indéfiniment.
 */
export async function exportS3(): Promise<{ client: S3ClientType; bucket: string }> {
  const { getS3Client, getS3Bucket } = await import('@/lib/s3-config');
  return { client: getS3Client('worker'), bucket: getS3Bucket() };
}

/** Envoi S3 en flux (taille connue : pas de mise en mémoire). */
export const s3UploadFile: UploadFn = async (localPath, key, contentType) => {
  const [{ client: s3Client, bucket: S3_BUCKET }, { PutObjectCommand }] = await Promise.all([exportS3(), import('@aws-sdk/client-s3')]);
  const size = (await fs.promises.stat(localPath)).size;
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentLength: size,
    ContentType: contentType,
    Metadata: { 'x-verebona-type': 'export' },
  }));
};

/** En-tête Content-Disposition (RFC 6266) pour un nom de fichier ASCII sûr. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** URL signée de courte durée, avec nom de fichier de téléchargement. */
export async function shortLivedDownloadUrl(key: string, fileName: string, contentType: string): Promise<string> {
  const [{ getS3Client, getS3Bucket }, { GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    import('@/lib/s3-config'), import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner'),
  ]);
  const s3Client = getS3Client('interactive');
  const command = new GetObjectCommand({
    Bucket: getS3Bucket(),
    Key: key,
    ResponseContentDisposition: attachmentDisposition(fileName),
    ResponseContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn: downloadUrlTtlSeconds() });
}
