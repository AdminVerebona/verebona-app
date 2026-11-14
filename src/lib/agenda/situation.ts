/**
 * « Situation de l'événement » d'un élément d'Agenda — lot 114V (Trello #742,
 * décision PO du 14/11/2026 : « A eu lieu | À prévoir »).
 *
 * Module PUR, sans import serveur : partagé par les tiroirs de création et de
 * modification (desktop ET mobile — mêmes composants), les vues de l'Agenda,
 * l'accueil, la carte « À traiter » de qualification et la validation de
 * l'API.
 *
 * Règles (matrice §3 de la carte) :
 *   · la SITUATION (intention) et la DATE sont indépendantes : jamais l'une
 *     déduite de l'autre ; la date est facultative dans les deux cas ;
 *   · création MANUELLE sans situation transmise : « À prévoir » (défaut
 *     serveur, comme le formulaire) ;
 *   · élément hérité ou produit par un traitement : NON QUALIFIÉ (`null`) —
 *     jamais reclassé d'office ;
 *   · « A eu lieu » avec une date de début FUTURE : contradiction REFUSÉE
 *     explicitement (ni la date ni la situation ne sont corrigées en silence) ;
 *   · « À prévoir » avec une date passée : accepté tel quel (une date passée
 *     ne prouve pas la réalisation) ;
 *   · ce n'est pas un statut : aucun « annulé », aucun « en retard » (lot
 *     113P, #715) — un événement sans objet se SUPPRIME.
 */

/** Valeurs persistées, dans l'ORDRE D'AFFICHAGE du sélecteur (gauche, droite). */
export const AGENDA_SITUATIONS = ['A_EU_LIEU', 'A_PREVOIR'] as const;
export type AgendaSituation = (typeof AGENDA_SITUATIONS)[number];

/** Provenance persistée de la qualification. */
export type AgendaSituationSource = 'USER' | 'DEFAULT' | 'MIGRATION';

/** Libellés exacts de la carte #742. */
export const SITUATION_FIELD_LABEL = 'Situation de l’événement';
export const SITUATION_LABELS: Record<AgendaSituation, string> = {
  A_EU_LIEU: 'A eu lieu',
  A_PREVOIR: 'À prévoir',
};
/** Situation enregistrée quand l'utilisateur ne touche pas au sélecteur (création). */
export const DEFAULT_NEW_SITUATION: AgendaSituation = 'A_PREVOIR';
/** Groupe / mention d'un événement qui a eu lieu, sans date (carte #742 §5). */
export const UNKNOWN_DATE_LABEL = 'Date inconnue';
/** Groupe / mention d'un événement sans date NON qualifié (libellé antérieur, conservé). */
export const UNQUALIFIED_UNDATED_LABEL = 'Sans date';
/** Action de l'accueil et de l'Agenda sur un événement « À prévoir » sans date (carte #742 §5). */
export const PLAN_ACTION_LABEL = 'Planifier';
/** Question NEUTRE de la carte « À traiter » de qualification (carte #742 §6, texte exact). */
export const SITUATION_QUESTION = 'Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?';

/** Refus (texte à valider par le PO). */
export const SITUATION_INVALID_ERROR = 'Validation : la situation de l’événement doit être « A eu lieu » ou « À prévoir ».';
export const SITUATION_FUTURE_DATE_ERROR =
  'Validation : un événement « A eu lieu » ne peut pas avoir une date future — modifiez la date ou choisissez « À prévoir ».';
export const SITUATION_NO_DEADLINE_ERROR =
  'Validation : « Sans échéance » ne s’applique qu’à un événement « À prévoir ».';

export function isAgendaSituation(v: unknown): v is AgendaSituation {
  return typeof v === 'string' && (AGENDA_SITUATIONS as readonly string[]).includes(v);
}

/** Situation persistée lue d'une ligne (toute autre valeur : non qualifié). */
export function situationOf(v: unknown): AgendaSituation | null {
  return isAgendaSituation(v) ? v : null;
}

/** Libellé d'une situation ; `null` (non qualifié) : aucun libellé. */
export function situationLabel(v: AgendaSituation | null | undefined): string | null {
  return v ? SITUATION_LABELS[v] : null;
}

// ══════════════════════════════════════════════════════════════════════════
// LECTURE — regroupement des éléments SANS date (Agenda, accueil, fiches)
// ══════════════════════════════════════════════════════════════════════════

/** Groupe d'un élément sans date : à prévoir, a eu lieu (date inconnue), ou non qualifié. */
export type UndatedGroup = 'A_PREVOIR' | 'DATE_INCONNUE' | 'NON_QUALIFIE';

export const UNDATED_GROUP_LABELS: Record<UndatedGroup, string> = {
  A_PREVOIR: SITUATION_LABELS.A_PREVOIR,
  DATE_INCONNUE: UNKNOWN_DATE_LABEL,
  NON_QUALIFIE: UNQUALIFIED_UNDATED_LABEL,
};
/** Ordre d'affichage des groupes sans date (les événements à organiser d'abord). */
export const UNDATED_GROUP_ORDER: readonly UndatedGroup[] = ['A_PREVOIR', 'NON_QUALIFIE', 'DATE_INCONNUE'];

export function undatedGroupOf(item: { situation?: string | null }): UndatedGroup {
  const s = situationOf(item.situation);
  return s === 'A_PREVOIR' ? 'A_PREVOIR' : s === 'A_EU_LIEU' ? 'DATE_INCONNUE' : 'NON_QUALIFIE';
}

/**
 * Répartit des éléments SANS date dans leurs groupes, dans l'ordre
 * d'affichage ; un groupe vide n'est pas rendu. L'ordre d'entrée est conservé
 * dans chaque groupe (aucun tri par date : il n'y en a pas).
 */
export function groupUndated<T extends { situation?: string | null }>(items: readonly T[]): Array<{ group: UndatedGroup; label: string; items: T[] }> {
  return UNDATED_GROUP_ORDER
    .map((group) => ({ group, label: UNDATED_GROUP_LABELS[group], items: items.filter((i) => undatedGroupOf(i) === group) }))
    .filter((g) => g.items.length > 0);
}

/**
 * Un élément SANS date entre-t-il dans une période de l'Agenda ? Il n'a pas
 * de date à comparer : seule sa situation le situe — « A eu lieu » jamais
 * dans « à venir » / « aujourd'hui », « À prévoir » jamais dans « passé ».
 * Non qualifié : toutes les périodes (comportement antérieur).
 */
export function undatedMatchesPeriod(item: { situation?: string | null }, period: string): boolean {
  const s = situationOf(item.situation);
  if (s === 'A_EU_LIEU') return period !== 'upcoming' && period !== 'today';
  if (s === 'A_PREVOIR') return period !== 'past';
  return true;
}

/** Un événement qui a eu lieu n'est jamais une échéance À VENIR (accueil, rappels). */
export function isUpcomingBySituation(item: { situation?: string | null }): boolean {
  return situationOf(item.situation) !== 'A_EU_LIEU';
}

// ══════════════════════════════════════════════════════════════════════════
// VALIDATION SERVEUR (création, modification)
// ══════════════════════════════════════════════════════════════════════════

interface SituationWriteInput {
  /** Valeur transmise ; absente (ou `null`, ancien client) : inchangée / défaut. */
  situation?: unknown;
  /** Date de début APRÈS l'écriture (valeur transmise, sinon valeur en base). */
  effectiveStartDate: string | null;
  /** « Sans échéance » DEMANDÉ (`true`) par cette même demande. */
  requestedNoDeadline: boolean;
  /** Situation en base (modification) ; `undefined` : création. */
  existing?: AgendaSituation | null;
  /** Création MANUELLE par l'utilisateur : défaut « À prévoir » si rien n'est transmis. */
  defaultForManualCreation?: boolean;
  /** Une date ou une situation est-elle transmise par CETTE demande ? (le couple n'est contrôlé que s'il change). */
  coupleTouched: boolean;
  /** Date du jour, AAAA-MM-JJ (Europe/Paris) — injectée : la règle est pure. */
  today: string;
}

type SituationResolution =
  | {
    ok: true;
    /** Valeur à écrire ; `undefined` : rien à écrire (inchangée). */
    situation: AgendaSituation | undefined;
    source: AgendaSituationSource | undefined;
    /** Situation de l'élément après l'écriture. */
    effective: AgendaSituation | null;
  }
  | { ok: false; error: string };

/**
 * Décision serveur d'une écriture (pure) :
 *   · valeur transmise invalide → refus ;
 *   · valeur transmise → écrite, provenance USER ;
 *   · rien de transmis : création manuelle → « À prévoir », provenance DEFAULT ;
 *     sinon inchangée (un élément non qualifié le reste) ;
 *   · « A eu lieu » + date de début future → refus explicite ;
 *   · « A eu lieu » + « Sans échéance » demandé → refus explicite (une
 *     option déjà en base est retirée par le service, sans refus).
 */
export function resolveSituationWrite(input: SituationWriteInput): SituationResolution {
  const v = input.situation;
  if (v !== undefined && v !== null && !isAgendaSituation(v)) return { ok: false, error: SITUATION_INVALID_ERROR };
  const transmise = isAgendaSituation(v) ? v : undefined;
  const parDefaut = transmise === undefined && input.existing === undefined && input.defaultForManualCreation === true;
  const effective: AgendaSituation | null = transmise ?? (parDefaut ? DEFAULT_NEW_SITUATION : input.existing ?? null);
  if (effective === 'A_EU_LIEU' && (input.coupleTouched || transmise !== undefined)) {
    const date = typeof input.effectiveStartDate === 'string' ? input.effectiveStartDate.slice(0, 10) : '';
    if (date && date > input.today) return { ok: false, error: SITUATION_FUTURE_DATE_ERROR };
  }
  if (effective === 'A_EU_LIEU' && input.requestedNoDeadline) return { ok: false, error: SITUATION_NO_DEADLINE_ERROR };
  if (transmise !== undefined) {
    // Même valeur qu'en base : rien à réécrire (la provenance d'origine est conservée).
    if (input.existing !== undefined && input.existing === transmise) return { ok: true, situation: undefined, source: undefined, effective };
    return { ok: true, situation: transmise, source: 'USER', effective };
  }
  if (parDefaut) return { ok: true, situation: DEFAULT_NEW_SITUATION, source: 'DEFAULT', effective };
  return { ok: true, situation: undefined, source: undefined, effective };
}
