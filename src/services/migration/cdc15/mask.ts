/**
 * Masquage des valeurs écrites au rapport de migration (0225) — CDC 15 §14,
 * §29.4. Une valeur de clé `sensitive` au registre (n° client assurance,
 * adresse, complément, coordonnées GPS) n'est JAMAIS écrite : seule sa
 * présence l'est. Tout texte passe en plus par la politique §29.4
 * (secrets, pièces d'identité, coordonnées bancaires, contacts de tiers).
 * Par prudence (§29.4, relecture lot 17), la VILLE et le CODE POSTAL sont
 * masqués aussi : avec le nom du bien, ils localisent la personne. La copie
 * restaurable reste dans `cdc15_migration_backups` (accès restreint).
 */
import { getField, resolveAlias } from '@/services/canonical/registry';
import { maskSensitiveText } from '@/services/verebona-assistant/core/sensitive-data.policy';

export const MASKED = '[masqué]';

/** Clés canoniques masquées au rapport en plus des clés `sensitive` du registre. */
export const REPORT_MASKED_KEYS: ReadonlySet<string> = new Set(['city', 'postalCode']);
/** Colonnes historiques correspondantes (avant / après de MIG-07). */
const MASKED_COLUMNS = new Set(['address', 'city', 'postal_code']);

/** Clé (canonique, alias ou colonne miroir) masquée au rapport. */
export function isSensitiveKey(key: string | null | undefined): boolean {
  if (!key) return false;
  if (MASKED_COLUMNS.has(key)) return true;
  const k = getField(key) ? key : resolveAlias(key);
  return !!(k && (getField(k)?.sensitive || REPORT_MASKED_KEYS.has(k)));
}

/** Valeur prête pour le rapport (pure, testée). */
export function maskReportValue(key: string | null | undefined, value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (isSensitiveKey(key)) return MASKED;
  if (typeof value === 'string') return maskSensitiveText(value).text;
  if (Array.isArray(value)) return value.map((v) => maskReportValue(key, v));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k, maskReportValue(isSensitiveKey(k) ? k : key, v),
    ]));
  }
  return value;
}
