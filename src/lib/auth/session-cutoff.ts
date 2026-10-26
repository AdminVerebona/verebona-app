/** Clé de cache de la borne de révocation globale (contrôle des jetons d'accès). */
export const sessionCutoffCacheKey = (userId: number) => `session-cutoff:${userId}`;
