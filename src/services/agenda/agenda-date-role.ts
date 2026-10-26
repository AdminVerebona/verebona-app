/**
 * Rôle fonctionnel de la date d'un élément d'agenda — lot 50 (ticket
 * « Mascotte : fiabiliser les sujets affichés et le contexte transmis à T6 »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « DATE CERTAINE » N'EST PAS « RENDEZ-VOUS PRIS »
 *
 *   DEADLINE         date à respecter : action à prévoir ou à planifier
 *                    (« le prochain contrôle technique est à prévoir pour le
 *                    18 avril 2028 ») ;
 *   SCHEDULED_EVENT  événement effectivement planifié (« le contrôle
 *                    technique est prévu le 18 avril 2028 »).
 *
 * Notion DISTINCTE de la certitude de la date (`occurrence_nature`,
 * confirmée / prévisionnelle) : une échéance certaine peut ne pas être
 * organisée. Les deux sont transmises séparément (mascotte, T6).
 *
 * Lot 53 (retour PO D27) : l'expression dépend de la PREUVE d'une
 * programmation, pas de l'existence d'une heure ni de la seule origine
 * technique. Une heure enregistrée (lue dans un document, recopiée d'une
 * règle, ajoutée à une échéance automatique) ne prouve pas un rendez-vous
 * pris. La seule preuve de programmation dont dispose Verebona est la SAISIE
 * de l'événement par l'utilisateur lui-même dans son agenda (il déclare
 * l'avoir organisé) — encore faut-il que ce ne soit pas une échéance.
 *
 * Données structurées seulement (jamais le titre), dans cet ordre :
 *   1. occurrence PRÉVISIONNELLE (calculée d'une récurrence) → DEADLINE :
 *      une prévision n'est jamais un rendez-vous ;
 *   2. nature T4 / registre DEADLINE ou HISTORICAL (`event_nature`, 0223)
 *      → DEADLINE (jamais « prévu » comme un rendez-vous) ;
 *   3. élément SAISI par l'utilisateur dans l'agenda (manuel, non
 *      automatique, non projeté d'une Opération) → SCHEDULED_EVENT ;
 *   4. sinon (échéance automatique : champ du bien, règle déduite, document
 *      qualifié, projection d'une Opération, ancienne échéance migrée), AVEC
 *      OU SANS HEURE → DEADLINE.
 * L'heure n'intervient plus. Le cas incertain retombe sur DEADLINE : on ne
 * présente jamais comme organisé ce qui ne l'est peut-être pas. Aucun rôle ne
 * dit un rendez-vous « confirmé » (aucune donnée de réservation n'existe) :
 * les textes de la mascotte et le validateur T6 l'interdisent.
 * ══════════════════════════════════════════════════════════════════════════
 */
export type AgendaDateRole = 'DEADLINE' | 'SCHEDULED_EVENT';

interface AgendaDateRoleSignals {
  /** `occurrence_nature = 'FORECAST'`. */
  forecast: boolean;
  isAutomatic: boolean;
  /** `origin_type` (manual, asset_field, qualified_document, deduced_rule, legacy_*). */
  originType: string;
  /** `projection_origin` ('OPERATION' : généré depuis une Opération, lot 39). */
  projectionOrigin?: string | null;
  /** `event_nature` (0223) : HISTORICAL | DEADLINE | null. */
  eventNature?: string | null;
  /** `start_time` (HH:MM) ou null — lu, mais n'établit plus rien (D27, lot 53). */
  startTime?: string | null;
}

/** Origines d'un élément saisi par l'utilisateur (événement, pas échéance déduite). */
const SAISIES_UTILISATEUR: readonly string[] = ['manual', 'legacy_event_migration'];

/** Rôle de la date (pure, testée). */
export function agendaDateRole(i: AgendaDateRoleSignals): AgendaDateRole {
  if (i.forecast) return 'DEADLINE';
  // D27 : une heure seule ne prouve pas une programmation (plus de règle « heure → planifié »).
  if (i.eventNature === 'DEADLINE' || i.eventNature === 'HISTORICAL') return 'DEADLINE';
  if (!i.isAutomatic && !i.projectionOrigin && SAISIES_UTILISATEUR.includes(i.originType)) return 'SCHEDULED_EVENT';
  return 'DEADLINE';
}
