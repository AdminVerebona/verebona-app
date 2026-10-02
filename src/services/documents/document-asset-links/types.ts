/**
 * Relation N-N document ↔ bien — types (CDC 15 X-01, §12, migration 0221).
 */

export const LINK_ROLES = ['PRIMARY', 'SECONDARY', 'MENTIONED'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const LINK_ORIGINS = ['USER', 'AI', 'MIGRATION', 'LEGACY_COLUMN'] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

export const LINK_STATUSES = ['ACTIVE', 'PROPOSED', 'REJECTED', 'REMOVED'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/**
 * Cible d'un lien : un bien, une pièce ou un équipement (au moins un).
 * Pièce = SOUS-STRUCTURE (`substructureId`, décision D-G, migration 0229).
 */
export interface LinkTarget {
  assetId?: number | null;
  /** @deprecated D-G : pièce `rooms` historique (liens non repris) — utiliser `substructureId`. */
  roomId?: number | null;
  equipmentId?: number | null;
  /** Pièce (sous-structure). */
  substructureId?: number | null;
}

export interface DocumentAssetLink {
  id: number;
  accountId: number;
  fileId: number;
  assetId: number | null;
  /** @deprecated D-G : pièce `rooms` historique — voir `substructureId`. */
  roomId: number | null;
  equipmentId: number | null;
  /** Pièce (sous-structure, 0229). */
  substructureId: number | null;
  linkRole: LinkRole;
  origin: LinkOrigin;
  confidence: number | null;
  status: LinkStatus;
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
}

/** Ordre de force des rôles (le plus fort d'abord). */
export const ROLE_RANK: Readonly<Record<LinkRole, number>> = { PRIMARY: 0, SECONDARY: 1, MENTIONED: 2 };

/**
 * Un lien existant peut-il être rafraîchi (rôle, confiance, origine) par une
 * nouvelle écriture ?
 *   · LEGACY_COLUMN : jamais — il reflète les colonnes historiques et reste
 *     sous la seule responsabilité du déclencheur ;
 *   · USER : seulement par USER (une décision explicite ne se défait pas par
 *     l'IA ni par un rattrapage) ;
 *   · AI, MIGRATION : par USER ou AI.
 */
export function canRefresh(existing: LinkOrigin, incoming: LinkOrigin): boolean {
  if (existing === 'LEGACY_COLUMN') return false;
  if (existing === 'USER') return incoming === 'USER';
  return incoming === 'USER' || incoming === 'AI';
}
