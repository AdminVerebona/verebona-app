/**
 * Interprétation des dates — CDC §4.4.3, étape 2.
 *
 * DÉTERMINISTE, sans appel modèle. Les dates ont déjà été extraites avec leur
 * preuve par l'usage 1 : il ne reste qu'à les qualifier.
 *
 * Supprime le double traitement de l'existant, où `extract_agenda_v1` puis
 * `agenda_detect_v1` analysaient la même information.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DateQualification =
  /** Date exploitable pour une création automatique. */
  | 'explicit'
  /** Date valide mais trop lointaine ou trop ancienne pour être utile. */
  | 'out_of_range'
  /** Date invalide ou non normalisable. */
  | 'invalid';

export interface InterpretedDate {
  qualification: DateQualification;
  iso: string | null;
  /** Nombre de jours par rapport à aujourd'hui. Négatif si passé. */
  daysFromNow: number | null;
}

/** Au-delà de 20 ans, une échéance relève de l'erreur d'extraction. */
const MAX_FUTURE_YEARS = 20;
/** Une échéance de plus de 5 ans dans le passé n'a plus d'intérêt en agenda. */
const MAX_PAST_YEARS = 5;

export function interpretDate(raw: string | null | undefined, now = new Date()): InterpretedDate {
  if (!raw || !ISO_DATE.test(raw)) {
    return { qualification: 'invalid', iso: null, daysFromNow: null };
  }

  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return { qualification: 'invalid', iso: null, daysFromNow: null };
  }

  // Contrôle de cohérence calendaire : `2026-02-31` passe le format mais pas
  // la conversion — JavaScript le décale au 3 mars, ce qui serait une valeur
  // fausse silencieuse.
  if (date.toISOString().slice(0, 10) !== raw) {
    return { qualification: 'invalid', iso: null, daysFromNow: null };
  }

  const daysFromNow = Math.round((date.getTime() - now.getTime()) / 86_400_000);
  const years = daysFromNow / 365.25;

  if (years > MAX_FUTURE_YEARS || years < -MAX_PAST_YEARS) {
    return { qualification: 'out_of_range', iso: raw, daysFromNow };
  }

  return { qualification: 'explicit', iso: raw, daysFromNow };
}

/** Une échéance est-elle dépassée ? Sert au réconciliateur de statut. */
export function isPastDue(iso: string, now = new Date()): boolean {
  const d = interpretDate(iso, now);
  return d.qualification !== 'invalid' && (d.daysFromNow ?? 0) < 0;
}
