/**
 * Option « Sans échéance » d'un événement d'agenda — lot 77A (décision PO du
 * 21/10/2026, suite lot 76C : conflit RES-14 / décision 72C).
 *
 * Module PUR, sans import serveur : partagé par les tiroirs de création et
 * de modification (desktop ET mobile — mêmes composants), les vues de
 * l'agenda (« Mon agenda », onglet Agenda d'un bien, équipement) et la
 * validation de l'API.
 *
 * Règles :
 *   · cochée — l'événement n'a pas de date : toute date saisie est vidée
 *     (avec confirmation dans l'interface si une date existait) ; la règle
 *     « À traiter » DATA-AGENDA-DATE ne réclame plus de date ;
 *   · saisir une date décoche l'option (incompatibles) ;
 *   · non cochée et sans date : comportement antérieur (décision PO 72C).
 */

export const NO_DEADLINE_LABEL = 'Sans échéance';
export const NO_DEADLINE_HELP = 'Cette tâche n’a pas de date à respecter.';
export const NO_DEADLINE_CONFIRM_TITLE = 'Retirer la date ?';
export const NO_DEADLINE_CONFIRM_BODY = 'Une tâche « Sans échéance » n’a pas de date : la date saisie sera retirée.';
/** Libellé d'un élément sans date qui n'a pas été déclaré « sans échéance ». */
const UNDATED_LABEL = 'Sans date';

/** Champs de date d'un formulaire d'événement. */
export interface AgendaDateFormState {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  noDeadline: boolean;
}

/** Une date (début ou fin) est-elle saisie ? (les heures seules ne datent pas l'événement). */
function formHasDate(s: Pick<AgendaDateFormState, 'startDate' | 'endDate'>): boolean {
  return !!s.startDate || !!s.endDate;
}

/** Cocher (date vidée, heures comprises) ou décocher l'option. */
export function toggleNoDeadline(s: AgendaDateFormState, checked: boolean): AgendaDateFormState {
  return checked
    ? { startDate: '', startTime: '', endDate: '', endTime: '', noDeadline: true }
    : { ...s, noDeadline: false };
}

/** Cocher demande-t-il une confirmation ? (une date existait). */
export function needsNoDeadlineConfirm(s: AgendaDateFormState, checked: boolean): boolean {
  return checked && !s.noDeadline && formHasDate(s);
}

/** Saisie d'une date ou d'une heure : une date non vide décoche l'option. */
export function withDateEntry(s: AgendaDateFormState, patch: Partial<Omit<AgendaDateFormState, 'noDeadline'>>): AgendaDateFormState {
  const next = { ...s, ...patch };
  return formHasDate({ startDate: patch.startDate ?? '', endDate: patch.endDate ?? '' }) ? { ...next, noDeadline: false } : next;
}

/** Libellé d'un élément SANS date : « Sans échéance » s'il est déclaré tel, sinon « Sans date ». */
export function undatedLabel(item: { noDeadline?: boolean | null }): string {
  return item.noDeadline ? NO_DEADLINE_LABEL : UNDATED_LABEL;
}

// ══════════════════════════════════════════════════════════════════════════
// VALIDATION SERVEUR (création, modification)
// ══════════════════════════════════════════════════════════════════════════

interface NoDeadlineWriteInput {
  noDeadline?: unknown;
  startDate?: string | null;
  endDate?: string | null;
}

type NoDeadlineResolution =
  /** `noDeadline` : valeur à écrire (`undefined` = inchangée) ; `clearDates` : dates et heures à vider. */
  | { ok: true; noDeadline: boolean | undefined; clearDates: boolean }
  | { ok: false; error: string };

const nonVide = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/**
 * Décision serveur d'une écriture (pure) :
 *   · `noDeadline` non booléen → refus ;
 *   · `noDeadline: true` avec une date (début ou fin) dans la MÊME demande →
 *     refus explicite (jamais un choix silencieux entre les deux) ;
 *   · `noDeadline: true` → dates et heures vidées ;
 *   · `noDeadline` absent et date saisie → l'option est retirée ;
 *   · sinon inchangée.
 */
export function resolveNoDeadlineWrite(input: NoDeadlineWriteInput): NoDeadlineResolution {
  const v = input.noDeadline;
  if (v !== undefined && v !== null && typeof v !== 'boolean') {
    return { ok: false, error: 'Validation : « Sans échéance » doit valoir vrai ou faux.' };
  }
  const date = nonVide(input.startDate) || nonVide(input.endDate);
  if (v === true) {
    if (date) return { ok: false, error: 'Validation : une tâche « Sans échéance » n’a pas de date — retirez la date ou décochez « Sans échéance ».' };
    return { ok: true, noDeadline: true, clearDates: true };
  }
  if (v === false) return { ok: true, noDeadline: false, clearDates: false };
  return { ok: true, noDeadline: date ? false : undefined, clearDates: false };
}
