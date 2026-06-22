import { S3Client } from "@aws-sdk/client-s3";

// Validate required environment variables
if (!process.env.OVH_S3_ACCESS_KEY_ID) {
  throw new Error('OVH_S3_ACCESS_KEY_ID manquant dans .env');
}

if (!process.env.OVH_S3_SECRET_ACCESS_KEY) {
  throw new Error('OVH_S3_SECRET_ACCESS_KEY manquant dans .env');
}

if (!process.env.OVH_S3_BUCKET) {
  throw new Error('OVH_S3_BUCKET manquant dans .env');
}

if (!process.env.OVH_S3_ENDPOINT) {
  throw new Error('OVH_S3_ENDPOINT manquant dans .env');
}

/**
 * S3 Client configured for OVH Object Storage
 * 
 * Configuration Notes:
 * - forcePathStyle: true is REQUIRED for OVH S3 compatibility
 * - Endpoint: https://s3.gra.io.cloud.ovh.net (Gravelines region)
 * - Region: gra (must match endpoint)
 */
export const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || "gra",
  endpoint: process.env.OVH_S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // CRITICAL for OVH S3
});

// Export bucket configuration
export const S3_BUCKET = process.env.OVH_S3_BUCKET;
export const S3_ENDPOINT = process.env.OVH_S3_ENDPOINT;
export const S3_REGION = process.env.OVH_S3_REGION || "gra";

/**
 * Generate public URL for an S3 object
 * Format: https://verebona-files.s3.gra.io.cloud.ovh.net/path/to/file
 */
export function getS3PublicUrl(key: string): string {
  const bucketName = S3_BUCKET;
  const region = S3_REGION;
  return `https://${bucketName}.s3.${region}.io.cloud.ovh.net/${key}`;
}
