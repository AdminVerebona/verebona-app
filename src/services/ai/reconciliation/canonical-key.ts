/**
 * Clé écrite par la primitive canonique (registre) ou hors registre (fait
 * générique → keyCharacteristics). Module sans dépendance d'écriture : lu par
 * le moteur (rapport 58C) sans charger `apply-decision`.
 */
import { getField, resolveAlias, isExcludedKey } from '@/services/canonical/registry';

/** Clé écrite par la primitive : clé canonique ou alias connu du registre. */
export function isRegistryKey(fieldKey: string): boolean {
  if (isExcludedKey(fieldKey)) return false;
  return !!getField(fieldKey) || !!resolveAlias(fieldKey);
}
