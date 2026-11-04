/**
 * Date du document reçue À L'ENTRÉE d'un document (dépôt confirmé, lien web)
 * — lot 108D, cause racine du ticket « une seule date documentaire ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE RACINE (démontrée par le code)
 *
 * Jusqu'au lot 107, la fenêtre « Ajouter un document » PRÉ-REMPLISSAIT la
 * « Date du document » avec le jour courant (`new Date().toISOString()…`),
 * puis l'envoyait à `/api/files/confirm` (et `/api/web-links`), qui la
 * posait dans `asset_files.document_date` — le champ métier de référence.
 * T1 ne la remplaçait que s'il lisait une date non contradictoire ; sinon
 * (pas de date lisible, date contradictoire, compte sans analyse, run
 * dédupliqué « métadonnées manquantes seulement ») le JOUR D'IMPORT restait
 * affiché, filtré et trié comme date du document.
 *
 * Désormais :
 *   · le client n'envoie une date que si l'utilisateur l'a SAISIE, avec
 *     `documentDateSource: 'USER'` → elle est posée et marquée
 *     `user_edited_fields.documentDate` (prioritaire sur T1 / T3 / contrôles) ;
 *   · un client antérieur (PWA en cache, application mobile non mise à jour)
 *     envoie encore le jour courant par défaut, sans marque : une date égale
 *     au jour de la réception (UTC ou Paris) est alors IGNORÉE — c'est
 *     exactement la valeur pré-remplie, indiscernable d'une saisie ; toute
 *     autre date d'un ancien client reste posée (choix explicite), sans
 *     marque utilisateur ;
 *   · une valeur invalide ou partielle n'est jamais posée (aucun jour inventé).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Marque envoyée par le client quand l'utilisateur a saisi la date. */
export const USER_DOCUMENT_DATE_SOURCE = 'USER';

/** Fuseau de présentation (jour civil de l'utilisateur). */
const PRESENTATION_TIME_ZONE = 'Europe/Paris';

export type UploadDocumentDateReason = 'USER' | 'NONE' | 'INVALID' | 'LEGACY_DEFAULT_IGNORED' | 'LEGACY_KEPT';

export interface UploadDocumentDateDecision {
  /** Valeur à poser (`AAAA-MM-JJ`) ou null (aucune écriture de date). */
  documentDate: string | null;
  /** Poser `user_edited_fields.documentDate = true`. */
  markUserEdited: boolean;
  reason: UploadDocumentDateReason;
}

function jourValide(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `AAAA-MM-JJ` valide, sinon null (jamais de date partielle complétée). */
export function strictIsoDay(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  return jourValide(Number(m[1]), Number(m[2]), Number(m[3])) ? v.trim() : null;
}

/** Jour civil d'un instant dans un fuseau (`AAAA-MM-JJ`). */
export function dayIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Jours qu'un ancien client pré-remplissait à cet instant : jour UTC
 * (`toISOString`) et jour de Paris (fuseau de l'utilisateur).
 */
export function legacyDefaultDays(instant: Date): string[] {
  return [...new Set([instant.toISOString().slice(0, 10), dayIn(instant, PRESENTATION_TIME_ZONE)])];
}

/** Décision pure (testée sans base). */
export function resolveUploadDocumentDate(
  input: { documentDate: unknown; documentDateSource?: unknown },
  now: Date,
): UploadDocumentDateDecision {
  if (input.documentDate === undefined || input.documentDate === null || input.documentDate === '') {
    return { documentDate: null, markUserEdited: false, reason: 'NONE' };
  }
  const jour = strictIsoDay(input.documentDate);
  if (!jour) return { documentDate: null, markUserEdited: false, reason: 'INVALID' };
  if (input.documentDateSource === USER_DOCUMENT_DATE_SOURCE) {
    return { documentDate: jour, markUserEdited: true, reason: 'USER' };
  }
  if (legacyDefaultDays(now).includes(jour)) {
    return { documentDate: null, markUserEdited: false, reason: 'LEGACY_DEFAULT_IGNORED' };
  }
  return { documentDate: jour, markUserEdited: false, reason: 'LEGACY_KEPT' };
}
