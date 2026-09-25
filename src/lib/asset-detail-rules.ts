/**
 * Règles de saisie des caractéristiques d'un bien — partagées par
 * l'interface (fiche bien), la route PATCH /details/[section] et les
 * commandes de l'assistant. Une seule définition : une valeur refusée à
 * l'écran l'est aussi par le serveur, et par le chat.
 *
 * Module pur (aucun import serveur) : lisible côté client.
 */

/** AAAA-MM-JJ du jour, à Paris — la date qui compte pour l'utilisateur. */
export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Champs datés : jour calendaire valide attendu. */
export const DATE_DETAIL_FIELDS = new Set([
  'acquisitionDate', 'estimatedValueDate', 'valuationDate', 'dpeDate', 'firstRegistrationDate',
  'mileageDate', 'insuranceExpiry', 'nextInspection', 'lastRevision',
]);

/**
 * Champs qui annoncent une échéance à venir : une date passée n'a pas de
 * sens (« prochain contrôle technique : 18 avril 2020 »). Le jour même est
 * accepté.
 */
export const FUTURE_ONLY_DETAIL_FIELDS: Record<string, string> = {
  nextInspection: 'Le prochain contrôle technique ne peut pas être dans le passé.',
};

export interface DetailFieldError {
  field: string;
  message: string;
}

export function isValidDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const vide = (v: unknown) => v === null || v === undefined || v === '';

/**
 * Valide les valeurs MODIFIÉES d'une section.
 *
 * L'interface renvoie la section entière à l'enregistrement : une valeur
 * déjà en base (un contrôle technique passé saisi il y a deux ans) ne doit
 * pas empêcher d'enregistrer un autre champ. Seules les valeurs qui changent
 * sont contrôlées.
 */
export function validateDetailChanges(
  fields: Record<string, unknown>,
  previous: Record<string, unknown>,
  today: string = todayParis(),
): DetailFieldError[] {
  const errors: DetailFieldError[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (vide(value) || value === previous[key]) continue;
    if (DATE_DETAIL_FIELDS.has(key)) {
      const day = String(value).slice(0, 10);
      if (!isValidDay(day)) {
        errors.push({ field: key, message: 'Date invalide.' });
        continue;
      }
      if (FUTURE_ONLY_DETAIL_FIELDS[key] && day < today) {
        errors.push({ field: key, message: FUTURE_ONLY_DETAIL_FIELDS[key] });
      }
    }
  }
  return errors;
}

/**
 * Filtre des écritures automatiques (analyse de document, suggestions IA,
 * propagation) : une date passée pour un champ « à venir » est écartée
 * plutôt qu'enregistrée — un procès-verbal de contrôle technique de 2021
 * ne dit pas quand aura lieu le prochain.
 */
export function acceptDetailDate(key: string, day: string, today: string = todayParis()): string | null {
  return FUTURE_ONLY_DETAIL_FIELDS[key] && day < today ? null : day;
}
