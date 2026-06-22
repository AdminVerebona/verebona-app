/**
 * S3 Naming Convention for Verebona
 * 
 * Format figé pour tous les fichiers uploadés sur S3 OVH :
 * 
 * verebona/u_{userId}/a_{assetId}/f_{fileId}/{timestamp}_{sanitizedFilename}
 * 
 * Exemples :
 * - verebona/u_42/a_123/f_789/1700000000000_facture-electricite.pdf
 * - verebona/u_42/a_123/f_790/1700000001000_photo-facade.jpg
 * 
 * Règles :
 * - Préfixe "verebona/" pour namespace global
 * - "u_{userId}" pour isolation par utilisateur
 * - "a_{assetId}" pour regroupement par bien
 * - "f_{fileId}" pour traçabilité base de données
 * - "{timestamp}" pour éviter collisions et tri chronologique
 * - "{sanitizedFilename}" pour lisibilité humaine
 * 
 * Avantages :
 * - Isolation des données par utilisateur
 * - Facilite les opérations de cleanup (par user, par asset)
 * - Traçabilité complète (lien direct avec DB via fileId)
 * - Pas de collision possible (timestamp + fileId unique)
 * - Lisibilité pour le support/debug
 */

export interface S3KeyComponents {
  userId: number;
  assetId: number | null; // Allow null for unassigned files
  fileId: number;
  timestamp: number;
  sanitizedFilename: string;
}

/**
 * Génère une clé S3 selon le format normalisé
 * Si assetId est null ou 0, utilise "a_unassigned" pour les documents non rattachés
 */
export function generateS3Key(components: S3KeyComponents): string {
  const { userId, assetId, fileId, timestamp, sanitizedFilename } = components;
  
  const assetPart = assetId && assetId > 0 ? `a_${assetId}` : 'a_unassigned';
  
  return `verebona/u_${userId}/${assetPart}/f_${fileId}/${timestamp}_${sanitizedFilename}`;
}

/**
 * Parse une clé S3 pour extraire les composants
 * Retourne null si le format est invalide
 * 
 * Accepte les deux formats pour compatibilité:
 * - verebona/u_{userId}/a_{assetId}/f_{fileId}/{timestamp}_{filename} (nouveau)
 * - verebona/u_{userId}/a_unassigned/f_{fileId}/{timestamp}_{filename} (sans bien)
 * - owntrack/u_{userId}/a_{assetId}/f_{fileId}/{timestamp}_{filename} (legacy)
 */
export function parseS3Key(s3Key: string): S3KeyComponents | null {
  // Format: (verebona|owntrack)/u_{userId}/(a_{assetId}|a_unassigned)/f_{fileId}/{timestamp}_{filename}
  const regex = /^(?:verebona|owntrack)\/u_(\d+)\/(a_(\d+)|a_unassigned)\/f_(\d+)\/(\d+)_(.+)$/;
  const match = s3Key.match(regex);
  
  if (!match) {
    return null;
  }
  
  const [, userId, , assetId, fileId, timestamp, sanitizedFilename] = match;
  
  return {
    userId: parseInt(userId),
    assetId: assetId ? parseInt(assetId) : null,
    fileId: parseInt(fileId),
    timestamp: parseInt(timestamp),
    sanitizedFilename,
  };
}

/**
 * Génère le préfixe S3 pour tous les fichiers d'un utilisateur
 * Utile pour les opérations de listing/cleanup
 */
export function getUserS3Prefix(userId: number): string {
  return `verebona/u_${userId}/`;
}

/**
 * Génère le préfixe S3 pour tous les fichiers d'un asset
 * Utile pour les opérations de listing/cleanup
 */
export function getAssetS3Prefix(userId: number, assetId: number): string {
  return `verebona/u_${userId}/a_${assetId}/`;
}

/**
 * Génère le préfixe S3 pour un fichier spécifique (sans timestamp)
 * Utile pour rechercher toutes les versions d'un même fichier
 */
export function getFileS3Prefix(userId: number, assetId: number, fileId: number): string {
  return `verebona/u_${userId}/a_${assetId}/f_${fileId}/`;
}

/**
 * Valide qu'une clé S3 suit bien le format normalisé
 */
export function isValidS3Key(s3Key: string): boolean {
  return parseS3Key(s3Key) !== null;
}