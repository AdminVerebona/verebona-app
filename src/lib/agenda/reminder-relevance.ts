/**
 * Bloc « Rappels sur l'accueil » de la fiche Agenda — EXISTENCE (lot 103D,
 * ticket « Agenda — statut et rappels », CA04 à CA06).
 *
 * Le bloc ne présente plus un RÉGLAGE disponible mais un RAPPEL EFFECTIF :
 * il n'existe que si la décision T6 existante (évaluation conservée
 * `t6_interpellation_assessments`) ou une préférence de l'utilisateur
 * (report, refus) porte sur cette échéance. Aucun second moteur : cette
 * fonction ne décide pas d'interpeller, elle lit ce que T6 a déjà décidé, et
 * applique les exclusions métier déjà établies (D-14 : un fait passé n'est
 * jamais une action).
 *
 * Lot 113P (#715) : plus de statut d'événement — plus de « sujet clos » par
 * statut ou preuve de réalisation. Un rappel se fonde sur une DATE FUTURE
 * (ou sur une préférence de l'utilisateur) : une date passée ne crée jamais
 * de relance (« à confirmer » ou autre).
 *
 * Module PUR (sans import serveur) : appelé par la route des rappels, testé.
 */

/** Conclusions T6 qui signifient « un rappel existe » (immédiat, à anticiper, informatif ou plus tard). */
export const T6_REMINDER_INTERPELLATIONS: readonly string[] = ['ACT_NOW', 'ANTICIPATE', 'INFORM', 'LATER'];

export type AgendaReminderRelevanceReason =
  /** Lot 113P : date passée (ou absente) — jamais une relance, quel que soit l'avis de T6. */
  | 'PAST_DATE'
  /** Fait historique (D-14) : jamais une action, jamais un rappel. */
  | 'HISTORICAL_FACT'
  /** Report ou refus enregistré par l'utilisateur : le bloc permet de le modifier. */
  | 'USER_PREFERENCE'
  /** Évaluation T6 existante : un rappel est prévu ou présenté. */
  | 'T6_REMINDER'
  /** Évaluation T6 « aucune interpellation », ou aucune évaluation : pas de rappel. */
  | 'NO_REMINDER';

export interface AgendaReminderRelevance {
  visible: boolean;
  reason: AgendaReminderRelevanceReason;
  /** Démarche attendue (T6), sinon null — l'écran retombe sur l'intitulé de l'échéance. */
  action: string | null;
  /** Date utile (T6, sinon échéance), AAAA-MM-JJ. */
  actionDate: string | null;
}

export function agendaReminderRelevance(p: {
  historical: boolean;
  dueDate: string | null;
  /** Date du jour (AAAA-MM-JJ, Europe/Paris) : une échéance antérieure est passée. */
  today: string;
  hasPreference: boolean;
  assessment: { interpellation: string | null; action: string | null; actionDate: string | null } | null;
}): AgendaReminderRelevance {
  const action = p.assessment?.action?.trim() || null;
  const actionDate = p.assessment?.actionDate ?? p.dueDate ?? null;
  const out = (visible: boolean, reason: AgendaReminderRelevanceReason): AgendaReminderRelevance => ({ visible, reason, action, actionDate });
  if (p.historical) return out(false, 'HISTORICAL_FACT');
  if (!p.dueDate || p.dueDate < p.today) return out(false, 'PAST_DATE');
  if (p.hasPreference) return out(true, 'USER_PREFERENCE');
  if (p.assessment?.interpellation && T6_REMINDER_INTERPELLATIONS.includes(p.assessment.interpellation)) return out(true, 'T6_REMINDER');
  return out(false, 'NO_REMINDER');
}

/** Libellés de la fiche (formulation minimale et concrète ; portée explicite). */
export const REMINDER_BLOCK_LABELS = {
  title: 'Rappels sur l’accueil',
  active: 'Rappel actif',
  dueOn: (date: string) => `Date utile : ${date}`,
  snooze: 'Reporter ce rappel',
  changeDate: 'Changer la date du rappel',
  dismiss: 'Ne plus rappeler cette échéance',
  reactivate: 'Réactiver ce rappel',
  reactivateSeries: 'Réactiver pour la série',
  /** Portée exacte des commandes : ce sujet seulement, jamais tous les rappels. */
  scope: 'Concerne uniquement cette échéance : vos autres rappels ne changent pas.',
} as const;
