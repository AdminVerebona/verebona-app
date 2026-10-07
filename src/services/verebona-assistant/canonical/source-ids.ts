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

/**
 * Identifiant de source d'un champ d'ÉQUIPEMENT ou de PIÈCE (lot 29, ticket
 * 13 §L, AC09) : `equipment_field:<id>:<clé>` / `room_field:<id>:<clé>` —
 * l'entité réellement interrogée, jamais le bien parent (`asset_field:`).
 * La méta de la source porte `targetType`, `targetId`, `assetId`, `fieldKey`.
 */
export const entityFieldSourceId = (type: 'EQUIPMENT' | 'ROOM', id: number, key: string): string =>
  `${type === 'ROOM' ? 'room' : 'equipment'}_field:${id}:${key}`;

/** Décode `equipment_field:<id>:<clé>` / `room_field:<id>:<clé>` (null sinon, ou clé hors registre). */
export function parseEntityFieldSourceId(id: string): { type: 'EQUIPMENT' | 'ROOM'; id: number; key: string } | null {
  const m = /^(equipment|room)_field:(\d+):([A-Za-z][A-Za-z0-9_]*)$/.exec(id);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) && n > 0 && getField(m[3]) ? { type: m[1] === 'room' ? 'ROOM' : 'EQUIPMENT', id: n, key: m[3] } : null;
}
