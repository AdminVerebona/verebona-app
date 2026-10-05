/**
 * Client S3 applicatif — façade de compatibilité sur `@/lib/s3-config`
 * (APP-PERF-26).
 *
 * La configuration (variables, validation, mode d'adressage, délais) est
 * définie UNIQUEMENT dans `s3-config.ts`. Ce module conserve les exports
 * historiques (`s3Client`, `S3_BUCKET`, …) pour les appelants existants et,
 * comme avant, lève à l'import si la configuration est invalide — les
 * modules qui doivent survivre à un stockage absent l'importent
 * dynamiquement ou utilisent directement `getS3Client()`.
 *
 * Le commentaire « forcePathStyle: true is REQUIRED for OVH » n'est plus une
 * règle : le style est un réglage (`OVH_S3_FORCE_PATH_STYLE`, défaut true).
 */
import { getS3Client, getS3Config } from '@/lib/s3-config';

const config = getS3Config();

/** Client du profil `interactive` (délais courts, 2 tentatives). */
export const s3Client = getS3Client('interactive');

export const S3_BUCKET = config.bucket;
export const S3_ENDPOINT = config.endpoint;
export const S3_REGION = config.region;
