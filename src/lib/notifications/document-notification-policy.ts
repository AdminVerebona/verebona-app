/**
 * Notifications des documents — lot 108I (ticket « Une seule notification
 * maximum par document pour le cycle normal d'import et d'analyse »).
 * Module PUR (paramètres + décision), lu par le serveur (résultat du lot,
 * suivi de l'analyse) et par le client (relève du bandeau d'analyse).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONFIRMATION DANS L'INTERFACE ≠ JOURNAL TECHNIQUE ≠ NOTIFICATION UTILE
 *
 *   Ajout réussi                    confirmation discrète dans le parcours
 *                                   d'ajout ; AUCUNE notification ;
 *   Analyse réussie, suivie         l'interface se met à jour (« Analyse
 *                                   terminée · Voir ») ; AUCUNE notification ;
 *   Analyse réussie, non suivie     UNE notification maximum, qui ouvre le
 *                                   document (cloche, push selon préférence) ;
 *   Réanalyse / reprise / relance   AUCUNE notification de succès (document
 *   (cohérence, 108B…)              déjà analysé avec succès avant ce lot) ;
 *   Échec définitif                 notification utile avec action (inchangé,
 *                                   lot 81E : une par lot, regroupée) ;
 *   Décision requise                carte « À traiter » (inchangé).
 * Toute décision « sans notification » est tracée sur le lot
 * (`document_lots.notification_skip_reason`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « UTILISATEUR ENCORE DANS LE PARCOURS » : SIGNAL DE SUIVI
 *
 * Le bandeau d'analyse (header ordinateur, bandeau mobile — même interface
 * dans l'application native) relève l'état de chaque document en cours toutes
 * les `ANALYSIS_FOLLOW_POLL_MS`. Quand la page est VISIBLE, la relève porte
 * `?suivi=1` : le serveur date alors le suivi sur les lots EN ATTENTE du
 * compte de la session dont l'utilisateur est le destinataire (rien d'autre :
 * ni autre compte, ni autre utilisateur, ni lot clos). À l'issue du lot, un
 * suivi plus récent que `ANALYSIS_FOLLOW_FRESHNESS_SECONDS` (horloge de la
 * base) signifie que l'utilisateur voit le résultat à l'écran.
 * Application fermée, en arrière-plan ou onglet masqué : plus de suivi → la
 * notification part (une seule).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Intervalle de relève du bandeau d'analyse (client). */
export const ANALYSIS_FOLLOW_POLL_MS = 4_000;

/**
 * Fenêtre de fraîcheur du suivi : ~2,5 relèves. Plus court, une relève lente
 * (réseau mobile) ferait notifier un utilisateur présent ; plus long, un
 * utilisateur qui vient de quitter l'application ne serait pas prévenu.
 */
export const ANALYSIS_FOLLOW_FRESHNESS_SECONDS = 10;

/** Le serveur n'écrit pas deux suivis du même lot à moins de cet écart. */
export const ANALYSIS_FOLLOW_WRITE_THROTTLE_SECONDS = 2;

/** Paramètre de la relève qui déclare un suivi visible. */
export const ANALYSIS_FOLLOW_QUERY = 'suivi';

/** Durée d'affichage de « Analyse terminée · Voir » dans le bandeau. */
export const ANALYSIS_DONE_CUE_MS = 8_000;

/** Motif tracé d'un résultat de lot non notifié. */
export type LotSkipReason = 'followed_in_app' | 'reanalysis' | 'technical' | 'no_recipient' | 'no_outcome';

/** Document analysé du lot, tel que la décision le voit. */
export interface SuccessCandidate {
  assetFileId: number;
  title: string;
  /** Aucune analyse réussie de ce document avant l'ouverture du lot. */
  firstSuccess: boolean;
  /** Traitement présenté à l'utilisateur (`analysis_visibility`, lot 50). */
  userVisible: boolean;
}

export type SuccessDecision =
  | { notify: true; documents: Array<{ assetFileId: number; title: string }>; dedupeKey: string }
  | { notify: false; reason: LotSkipReason };

/**
 * Clé d'idempotence STABLE document × traitement (T1) : un seul succès
 * notifié par document, quels que soient les lots, relances et reprises.
 */
export function documentSuccessDedupeKey(assetFileId: number): string {
  return `document:analysis-success:t1:${assetFileId}`;
}

/** Clé d'un succès groupé (plusieurs documents du même lot). */
export function lotSuccessDedupeKey(lotId: number): string {
  return `document:lot-result:${lotId}`;
}

/**
 * Faut-il notifier la RÉUSSITE totale d'un lot ? (pure)
 *  1. seuls comptent les documents dont c'est la PREMIÈRE analyse réussie et
 *     dont le traitement est présenté à l'utilisateur — une réanalyse, une
 *     reprise ou une relance technique réussie ne notifie jamais ;
 *  2. analyse suivie dans l'application jusqu'au bout : l'interface suffit ;
 *  3. sinon UNE notification, qui ne nomme que ces documents ; un seul
 *     document → clé stable document × traitement.
 */
export function decideLotSuccessNotification(input: {
  lotId: number;
  analysed: SuccessCandidate[];
  followedRecently: boolean;
}): SuccessDecision {
  if (input.analysed.length === 0) return { notify: false, reason: 'no_outcome' };
  const premiers = input.analysed.filter((d) => d.firstSuccess);
  if (premiers.length === 0) return { notify: false, reason: 'reanalysis' };
  const nouveaux = premiers.filter((d) => d.userVisible);
  if (nouveaux.length === 0) return { notify: false, reason: 'technical' };
  if (input.followedRecently) return { notify: false, reason: 'followed_in_app' };
  const documents = nouveaux.map((d) => ({ assetFileId: d.assetFileId, title: d.title }));
  return {
    notify: true,
    documents,
    dedupeKey: documents.length === 1 ? documentSuccessDedupeKey(documents[0].assetFileId) : lotSuccessDedupeKey(input.lotId),
  };
}

/** URL de relève de l'état d'un document, avec le suivi visible déclaré (client). */
export function analysisStatusUrl(fileId: number, visible: boolean): string {
  return `/api/documents/${fileId}/analysis-status${visible ? `?${ANALYSIS_FOLLOW_QUERY}=1` : ''}`;
}
