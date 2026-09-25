/**
 * Usage d'un bien immobilier (section « Occupation / usage »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE DONNÉE POUR « CE BIEN EST LOUÉ »
 *
 * L'ancien attribut « Bien mis en location » (assets.is_rented, CDC V2 §6.1)
 * doublonnait le champ Usage, qui proposait déjà « Locatif ». Deux données
 * pour une même réalité finissaient par se contredire (usage « Locatif »,
 * attribut « Non »). L'attribut est retiré : l'usage LOCATIF, libellé
 * « Mis en location », est désormais la seule source — pour l'affichage, la
 * visibilité de la Rubrique « Gestion locative » et l'assistant.
 *
 * Le code stocké reste `LOCATIF` : seules les données déjà saisies et les
 * prompts d'analyse le connaissent, et le renommer n'apporterait rien.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const RENTED_USAGE = 'LOCATIF';

export const OCCUPANCY_USAGE_LABELS: Record<string, string> = {
  RESIDENCE_PRINCIPALE: 'Résidence principale',
  RESIDENCE_SECONDAIRE: 'Résidence secondaire',
  LOCATIF: 'Mis en location',
  VACANT: 'Vacant',
};

export const OCCUPANCY_USAGE_OPTIONS = Object.entries(OCCUPANCY_USAGE_LABELS)
  .map(([value, label]) => ({ value, label }));

export function occupancyUsageLabel(code: unknown): string | null {
  if (code === null || code === undefined || code === '') return null;
  return OCCUPANCY_USAGE_LABELS[String(code)] ?? String(code);
}

/** Caractéristiques clés (texte JSON en base) → objet ; tolère un contenu invalide. */
function parse(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Le bien est-il mis en location ? Lu sur l'usage, et seulement là. */
export function isRentedFromCharacteristics(keyCharacteristics: unknown): boolean {
  return parse(keyCharacteristics).occupancyUsage === RENTED_USAGE;
}

/**
 * Même lecture en SQL, sans conversion en jsonb : une colonne texte au JSON
 * invalide ne doit pas faire échouer toute la requête.
 */
export const SQL_IS_RENTED = (alias = 'a') =>
  `coalesce(substring(coalesce(${alias}.key_characteristics, '') from '"occupancyUsage"\\s*:\\s*"([A-Z_]+)"') = '${RENTED_USAGE}', false)`;
