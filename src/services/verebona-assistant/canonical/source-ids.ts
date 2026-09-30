/**
 * Identifiants de source de niveau champ — CDC 15 T2-32 (lot 15). Module
 * PUR (registre seulement, aucune base) : importé par `core/entity-ref`.
 */
import { getField } from '@/services/canonical/registry';

/** Identifiant de source d'un champ : `asset_field:<assetId>:<clé>`. */
export const assetFieldSourceId = (assetId: number, key: string): string => `asset_field:${assetId}:${key}`;

/** Décode `asset_field:<assetId>:<clé>` (null si ce n'en est pas un, ou clé hors registre). */
export function parseAssetFieldSourceId(id: string): { assetId: number; key: string } | null {
  const m = /^asset_field:(\d+):([A-Za-z][A-Za-z0-9_]*)$/.exec(id);
  if (!m) return null;
  const assetId = Number(m[1]);
  return Number.isSafeInteger(assetId) && assetId > 0 && getField(m[2]) ? { assetId, key: m[2] } : null;
}
