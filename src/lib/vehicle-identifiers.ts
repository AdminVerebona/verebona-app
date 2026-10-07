/**
 * Identifiants exacts de véhicule dans un texte — VIN et immatriculation
 * (ticket 8b §B, §D, §H ; lot 29). Module PUR.
 *
 * Correspondance EXACTE seulement, après normalisation (casse, espaces,
 * tirets) : « AB-123-CD », « AB 123 CD » et « ab123cd » désignent la même
 * plaque. Aucun rapprochement approximatif (distance d'édition, préfixe) :
 * une plaque ou un VIN « presque égal » est un AUTRE véhicule.
 *
 * Lot 31B : déplacé de `verebona-assistant/core` vers `src/lib` — partagé par
 * l'assistant (T2) ET le rattachement document → bien (T1 / T3
 * DOCUMENT_ASSET), sans dépendance d'un traitement IA vers un autre.
 * L'ancien chemin reste un simple ré-export.
 */

/** Plaque normalisée : majuscules, lettres et chiffres seulement. */
export function normalizePlate(value: string | null | undefined): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** VIN normalisé (majuscules, sans séparateurs). */
export function normalizeVin(value: string | null | undefined): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** SIV (depuis 2009) : AA-123-AA. */
const SIV = /(?<![A-Za-z0-9])([A-Za-z]{2})[\s-]?(\d{3})[\s-]?([A-Za-z]{2})(?![A-Za-z0-9])/g;
/** FNI (ancien) : 123 ABC 45 — lettres en MAJUSCULES dans le texte (évite « 12 rue 45 »). */
const FNI = /(?<![A-Za-z0-9])(\d{1,4})[\s-]?([A-Z]{2,3})[\s-]?(\d{2}|2A|2B)(?![A-Za-z0-9])/g;
/** VIN : 17 caractères, sans I, O, Q (ISO 3779). */
const VIN = /(?<![A-Za-z0-9])([A-HJ-NPR-Za-hj-npr-z0-9]{17})(?![A-Za-z0-9])/g;

export interface VehicleIdentifiers {
  plates: string[];
  vins: string[];
}

/** Immatriculations et VIN cités dans un texte, normalisés (pure, testée). */
export function vehicleIdentifiersIn(text: string): VehicleIdentifiers {
  const t = String(text ?? '');
  const vins = [...t.matchAll(VIN)].map((m) => normalizeVin(m[1]))
    .filter((v) => /\d/.test(v) && /[A-Z]/.test(v));
  // Une plaque n'est pas cherchée à l'intérieur d'un VIN.
  const sansVin = t.replace(VIN, ' ');
  const plates = [
    ...[...sansVin.matchAll(SIV)].map((m) => normalizePlate(`${m[1]}${m[2]}${m[3]}`)),
    ...[...sansVin.matchAll(FNI)].map((m) => normalizePlate(`${m[1]}${m[2]}${m[3]}`)),
  ];
  return { plates: [...new Set(plates)], vins: [...new Set(vins)] };
}

/** Le texte cite-t-il au moins un identifiant de véhicule ? */
export function hasVehicleIdentifier(text: string): boolean {
  const ids = vehicleIdentifiersIn(text);
  return ids.plates.length + ids.vins.length > 0;
}
