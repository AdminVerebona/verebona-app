/**
 * Catalogue central des notifications (CDC §16).
 *
 * Source unique de vérité côté serveur : pour chaque type d'événement, décrit
 * la catégorie, la priorité, les canaux autorisés/obligatoires, les valeurs par
 * défaut (§6), les contenus (cloche / push / email), le lien profond, la durée
 * de conservation et le schéma Zod du payload.
 *
 * Le client ne contient plus la vérité métier des libellés. Un payload
 * incomplet est détecté au typage (via `NotificationPayloadMap`) et validé à
 * l'exécution (Zod), l'outbox stockant le payload en JSONB.
 *
 * Règles transverses appliquées ici :
 *  - Vie privée (§4.3) : les contenus PUSH restent génériques, sans adresse,
 *    valeur patrimoniale ni détail de document. Le détail va dans la cloche ou
 *    l'écran ouvert après le clic.
 *  - Obligatoire ≠ configurable (§2.11) : `mandatoryBell` / `mandatoryEmail`.
 *  - Lot 101B : obligation d'INFORMER ≠ CANAL obligatoire ≠ affichage dans
 *    l'application. Les informations de sécurité sont obligatoires, leur canal
 *    obligatoire est l'e-mail ; aucune n'appelle d'action immédiate dans
 *    l'application : cloche et push y sont SUPPRIMÉS (`securityInformation`).
 *  - « À traiter » et « Actualités » ne sont jamais ajoutés dans la cloche
 *    (`neverBell`).
 */

import { lotNotificationText, lotFailureText, lotPartialFailureText, ANALYSIS_RETRY_ACTION } from '@/services/ai/source-analysis/lot-notification-text';
import { drawerHref } from '@/lib/drawers';
import { z } from 'zod';
import { NOTIFICATION_TYPES, type NotificationType } from '@/types/notifications';
import { subscriptionNotificationText } from './subscription-messages';
import { formatUnpaidDeadline } from '@/services/billing/unpaid-cycle.rules';
import { uploadNotificationText } from './upload-notification-text';
import { formatSecurityIncidentDate } from '@/lib/auth/security-email';

export type NotificationCategory =
  | 'deadlines'
  | 'documents'
  | 'to_process'
  | 'duo'
  | 'transmission'
  | 'account'
  | 'security'
  | 'news';

/**
 * Lot 82A (décision PO C-Q10, §3.3) — catégories de CONTENU : nées du
 * traitement des données d'un compte (échéances, résultats d'analyse,
 * « À traiter »). Non indispensables : jamais émises ni envoyées pour un
 * compte non actif, suspendu ou en lecture seule. Les autres catégories
 * (compte, sécurité, Duo, transmissions, actualités consenties) relèvent
 * d'opérations indispensables ou d'un autre compte : jamais bloquées ici.
 */
export const CONTENT_NOTIFICATION_CATEGORIES: ReadonlySet<NotificationCategory> = new Set<NotificationCategory>(['deadlines', 'documents', 'to_process']);

/** Notification de contenu (soumise à l'éligibilité du compte) ? */
export function isContentNotificationCategory(category: string | null | undefined): boolean {
  return CONTENT_NOTIFICATION_CATEGORIES.has(category as NotificationCategory);
}

/** Motif d'un événement ignoré (outbox `outcome_reason`) : compte non éligible. */
export const ACCOUNT_INELIGIBLE_SKIP_REASON = 'account_ineligible';

export type NotificationChannel = 'bell' | 'push' | 'email';
export type DeliveryMode = 'immediate' | 'daily_digest';
export type NotificationPriority = 'low' | 'normal' | 'high';

export interface RenderedContent {
  bellTitle: string;
  bellBody: string;
  pushTitle: string;
  pushBody: string;
  emailTemplateCode?: string;
  /**
   * Lot 81E : pas d'e-mail générique parce qu'une communication DURABLE le
   * couvre (confirmation contractuelle, fin d'offre) — cause tracée sur la
   * livraison, jamais présentée comme un envoi.
   */
  emailSkipReason?: string;
}

export interface CatalogEntry {
  type: NotificationType;
  category: NotificationCategory;
  priority: NotificationPriority;
  /** Mode de livraison ; seul « À traiter » utilise `daily_digest`. */
  deliveryMode: DeliveryMode;
  /** Cloche obligatoire (toujours présente, non désactivable). */
  mandatoryBell: boolean;
  /** Email obligatoire (interrupteur verrouillé, cf. §2.11). */
  mandatoryEmail: boolean;
  /** Jamais ajouté dans la cloche (« À traiter », actualités). */
  neverBell: boolean;
  /** Valeurs par défaut des canaux configurables (§6). */
  defaults: { push: boolean; email: boolean };
  /** Durée de conservation indicative de la ligne outbox détaillée (§19.3). */
  retentionDays: number;
  /**
   * Lot 79C — canaux SUPPRIMÉS (motif affiché au BO). Bloqués au moment de
   * l'envoi, quelles que soient les préférences enregistrées, l'activation BO,
   * la file existante, les reprises et les réémissions (`retired-channels.ts`).
   * Différent d'un défaut à `false`, qu'une préférence peut réactiver.
   * Lot 101B : la cloche (`bell`) peut aussi être supprimée ; ses lignes
   * historiques ne sont alors plus servies au client.
   */
  retiredChannels?: Partial<Record<'bell' | 'email' | 'push', string>>;
  /**
   * Lot 100G (E2, un seul circuit) : l'E-MAIL de cet événement est envoyé par
   * un autre traitement — la séquence de fin d'essai (`services/trial-lifecycle`),
   * avec le MÊME gabarit et le MÊME interrupteur du BO, après ses propres
   * contrôles (souscription, paiement, compte, préférences, doublon, fenêtre).
   * Le moteur de notifications ne livre alors que la cloche et le push.
   */
  emailDeliveredBy?: 'trial-lifecycle';
  // Le payload est validé par `payloadSchema` (Zod) à l'entrée dans l'outbox ;
  // le typage fort par type est assuré côté producteur via emit<T>() (Lot 1).
  render: (payload: any) => RenderedContent;
  deepLink: (payload: any) => string | null;
  payloadSchema: z.ZodTypeAny;
}

// ── Valeurs par défaut par catégorie (référence §6) ──────────────────────────
// Utilisées par l'API de préférences pour renvoyer la matrice complète fusionnée
// et par le PolicyResolver (Lot 1, service) quand aucune ligne utilisateur
// n'existe. Les entrées ci-dessous priment lorsqu'un événement a un défaut
// spécifique (ex. quota 90 % : email désactivé).
export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  deadlines: 'Échéances et rappels',
  documents: 'Documents',
  to_process: 'À traiter',
  duo: 'Partage et Duo',
  transmission: 'Transmission',
  account: 'Compte et abonnement',
  security: 'Sécurité',
  news: 'Actualités Verebona',
};

const T = NOTIFICATION_TYPES;

// ── Lot 79C : textes partagés ───────────────────────────────────────────────
const RETIRED_ANALYSIS_EMAIL = 'Supprimé (lot 79) : le résultat de l’analyse est présenté dans l’application.';
/**
 * Lot 101B — motif (affiché au BO › Communications) de la suppression de la
 * cloche et du push des informations de sécurité.
 */
export const RETIRED_SECURITY_IN_APP =
  'Supprimé (lot 101) : information de sécurité déjà envoyée par l’e-mail obligatoire, sans action immédiate dans l’application.';

/** Action réellement possible après un échec d'analyse (source : `lot-notification-text`). */
export { ANALYSIS_RETRY_ACTION };
/** Action attendue quand la banque demande une authentification (3D Secure). */
export const PAYMENT_AUTHENTICATION_ACTION = 'Votre banque demande une validation : confirmez le paiement depuis Mon compte › Offres.';

/** « Documents concernés : A, B (et 2 autres). » — rien sans liste. */
export function failedDocumentsText(documents?: Array<{ title: string }> | null): string {
  const titres = (documents ?? []).map((d) => d?.title).filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  if (titres.length === 0) return '';
  const montres = titres.slice(0, 3).join(', ');
  const reste = titres.length - 3;
  return ` Documents concernés : ${montres}${reste > 0 ? ` (et ${reste} autre${reste > 1 ? 's' : ''})` : ''}.`;
}


/**
 * Lot 81E — e-mail générique « Votre abonnement Verebona » omis SEULEMENT
 * quand la confirmation contractuelle de la même opération est enregistrée
 * DURABLEMENT (`confirmationJobId`, file des e-mails transactionnels : reprise,
 * supervision). L'ancien drapeau `confirmationEmailSent` (posé avant l'envoi,
 * simple intention) n'est plus une preuve : l'e-mail générique part.
 */
function contractCovered(base: RenderedContent, p: { confirmationJobId?: number } | null | undefined): RenderedContent {
  return typeof p?.confirmationJobId === 'number'
    ? { ...base, emailTemplateCode: undefined, emailSkipReason: `covered_by_contract_confirmation:${p.confirmationJobId}` }
    : base;
}

// Petit utilitaire : contenu identique cloche/push (contenu déjà générique).
function content(bellTitle: string, bellBody: string, push?: { title?: string; body?: string }, emailTemplateCode?: string): RenderedContent {
  return {
    bellTitle,
    bellBody,
    pushTitle: push?.title ?? bellTitle,
    pushBody: push?.body ?? bellBody,
    emailTemplateCode,
  };
}

// ── Catalogue ────────────────────────────────────────────────────────────────
// Note : le champ `type` de chaque entrée garantit au typage que la clé et
// l'entrée correspondent. Les entrées produites dès le Lot 1 sont complètes ;
// celles des Lots 4/5 (échéances, à-traiter, sécurité, abonnement) sont déjà
// déclarées afin que ces lots n'aient qu'à brancher leurs producteurs.
export const NOTIFICATION_CATALOG: { [K in NotificationType]?: CatalogEntry } = {

  // ── Échéances et rappels (Lot 4) ───────────────────────────────────────────
  [T.DEADLINE_DUE_IN_7_DAYS]: {
    type: T.DEADLINE_DUE_IN_7_DAYS,
    category: 'deadlines', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 90,
    render: (p) => content(
      // Une occurrence prévisionnelle est annoncée comme telle.
      p.count > 1
        ? `${p.count} échéances dans 7 jours${p.forecastCount ? ` (dont ${p.forecastCount} prévisionnelle${p.forecastCount > 1 ? 's' : ''})` : ''}`
        : p.forecastCount ? 'Échéance prévisionnelle dans 7 jours' : 'Échéance dans 7 jours',
      p.forecastCount && p.count === p.forecastCount
        ? 'Date estimée à partir de la récurrence : à confirmer dans Verebona.'
        : 'Une action est à prévoir dans Verebona.',
      undefined, 'notif_deadline_j7',
    ),
    deepLink: (p) => `/agenda${p.date ? `?date=${p.date}` : ''}`,
    payloadSchema: z.object({ count: z.number(), date: z.string(), agendaItemIds: z.array(z.number()).optional(), forecastCount: z.number().optional() }),
  },

  // ── Documents ───────────────────────────────────────────────────────────────
  [T.DOCUMENT_BATCH_COMPLETED]: {
    type: T.DOCUMENT_BATCH_COMPLETED,
    category: 'documents', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: false }, retentionDays: 90,
    // Lot 79C : une notification par lot (fin d'un traitement asynchrone),
    // push facultatif, jamais d'e-mail — même avec une ancienne préférence.
    retiredChannels: { email: RETIRED_ANALYSIS_EMAIL },
    // Le document est nommé ; un seul document s'ouvre directement en tiroir.
    render: (p) => content(
      'Analyse terminée',
      lotNotificationText(p),
      { body: lotNotificationText(p) },
    ),
    deepLink: (p) => (p.assetFileId
      ? drawerHref({ kind: 'document', id: p.assetFileId }, '/documents')
      : '/documents'),
    payloadSchema: z.object({
      lotId: z.number(), analysedCount: z.number(), failedCount: z.number(),
      assetFileId: z.number().optional(),
      documentTitle: z.string().optional(),
      documents: z.array(z.object({ assetFileId: z.number(), title: z.string() })).optional(),
      /** Lot 81E : doublons détectés (analysés, fusion proposée) — jamais des échecs. */
      duplicateCount: z.number().optional(),
    }),
  },
  // ── Lot 32 (décision PO Q18/Q19) : envoi réussi ─────────────────────────
  // Une notification par lot d'envoi (fichiers ou lien web), pour tous les
  // comptes. Cloche toujours ; push et e-mail selon les préférences de la
  // catégorie « Documents » (désactivés par défaut : l'utilisateur vient
  // d'agir, il est dans l'application). Le push reste générique (§4.3).
  [T.DOCUMENT_UPLOAD_COMPLETED]: {
    type: T.DOCUMENT_UPLOAD_COMPLETED,
    category: 'documents', priority: 'low', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: false, email: false }, retentionDays: 90,
    // Lot 79C : confirmation dans l'application seulement (cloche) — e-mail et
    // push supprimés, y compris pour une préférence « Documents » déjà activée.
    retiredChannels: {
      email: 'Supprimé (lot 79) : confirmation d’ajout visible dans l’application.',
      push: 'Supprimé (lot 79) : confirmation d’ajout visible dans l’application.',
    },
    render: (p) => {
      const { title, body } = uploadNotificationText(p);
      return content(title, body, { title, body: p.count > 1 ? `${p.count} documents ajoutés.` : 'Votre document a bien été ajouté.' }, 'notif_document_upload');
    },
    deepLink: (p) => (p.assetFileId
      ? drawerHref({ kind: 'document', id: p.assetFileId }, '/documents')
      : '/documents'),
    payloadSchema: z.object({
      count: z.number().int().min(1),
      assetFileId: z.number().optional(),
      documentTitle: z.string().optional(),
      kind: z.enum(['file', 'web_link']).optional(),
    }),
  },
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ PLUS D'EMAIL SUR UN ÉCHEC D'ANALYSE
  //
  // Les trois événements d'échec (`DOCUMENT_BATCH_PARTIALLY_FAILED`,
  // `DOCUMENT_BATCH_FAILED`, `ANALYSIS_FAILED_PERSISTENT`) partaient par
  // email par défaut, alors que la réussite — `DOCUMENT_BATCH_COMPLETED` —
  // n'y allait pas.
  //
  // Deux conséquences. La première : un utilisateur qui décoche l'email de
  // la catégorie « Documents » n'a pas conscience d'avoir jamais activé
  // celui de l'échec, et le reçoit tant que sa préférence n'est pas
  // enregistrée. La seconde : un même incident peut produire DEUX emails —
  // celui du lot, puis `ANALYSIS_FAILED_PERSISTENT` après dix tentatives.
  //
  // L'information reste dans la cloche et en push. Un échec d'analyse n'est
  // pas une urgence : le document est là, il est réanalysable, et rien
  // n'est perdu. L'email est disproportionné.
  // ══════════════════════════════════════════════════════════════════════════
  [T.DOCUMENT_BATCH_PARTIALLY_FAILED]: {
    type: T.DOCUMENT_BATCH_PARTIALLY_FAILED,
    category: 'documents', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: false }, retentionDays: 90,
    retiredChannels: { email: RETIRED_ANALYSIS_EMAIL },
    // Lot 81E : émis depuis le résultat RÉEL du lot (documents en échec
    // définitif nommés), une seule fois par lot.
    render: (p) => content(
      'Analyse terminée avec une anomalie',
      lotPartialFailureText(p ?? {}),
      { body: 'Certains documents n\'ont pas pu être analysés.' },
      'notif_document_batch_failed',
    ),
    deepLink: (p) => (p?.assetFileId ? drawerHref({ kind: 'document', id: p.assetFileId }, '/documents') : '/documents'),
    payloadSchema: z.object({
      lotId: z.number(), analysedCount: z.number(), failedCount: z.number(),
      documents: z.array(z.object({ assetFileId: z.number(), title: z.string() })).optional(),
      assetFileId: z.number().optional(),
    }),
  },
  [T.DOCUMENT_BATCH_FAILED]: {
    type: T.DOCUMENT_BATCH_FAILED,
    category: 'documents', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    // Pas d'email : cf. le bandeau ci-dessus (lot 79C : canal supprimé).
    defaults: { push: true, email: false }, retentionDays: 90,
    retiredChannels: { email: RETIRED_ANALYSIS_EMAIL },
    render: (p) => content(
      'Analyse impossible',
      lotFailureText(p ?? {}),
      { body: 'Nous n\'avons pas pu analyser vos documents.' },
      'notif_document_batch_failed',
    ),
    deepLink: (p) => (p?.assetFileId ? drawerHref({ kind: 'document', id: p.assetFileId }, '/documents') : '/documents'),
    payloadSchema: z.object({
      lotId: z.number(), analysedCount: z.number(), failedCount: z.number(),
      documents: z.array(z.object({ assetFileId: z.number(), title: z.string() })).optional(),
      assetFileId: z.number().optional(),
    }),
  },
  [T.ANALYSIS_FAILED_PERSISTENT]: {
    type: T.ANALYSIS_FAILED_PERSISTENT,
    category: 'documents', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    // Pas d'email : cf. le bandeau ci-dessus. Cet événement suit déjà un
    // `DOCUMENT_BATCH_*` sur le même incident — deux envois pour un seul fait.
    defaults: { push: true, email: false }, retentionDays: 90,
    // Lot 79C : canal supprimé ; regroupé avec l'alerte du lot du même
    // incident au moment de l'envoi (`incident-grouping.ts`).
    retiredChannels: { email: RETIRED_ANALYSIS_EMAIL },
    render: (p) => content(
      'Analyse impossible',
      `Nous n\'avons pas pu analyser ce document${p.documentTitle ? ` : ${p.documentTitle}` : ''}. ${ANALYSIS_RETRY_ACTION}`,
      { body: 'Un document n\'a pas pu être analysé.' },
      'notif_document_batch_failed',
    ),
    deepLink: (p) => (p.assetFileId ? `/documents/${p.assetFileId}` : '/documents'),
    // Lot 81E : `lotId` = identité de l'incident (document × lot) ; sans lot,
    // l'événement (historique) n'est rapproché d'aucun autre.
    payloadSchema: z.object({ assetFileId: z.number(), lotId: z.number().optional(), documentTitle: z.string().optional(), errorReason: z.string().optional() }),
  },

  // ── À traiter (Lot 4 — jamais dans la cloche) ──────────────────────────────
  [T.TO_PROCESS_ITEM_CREATED]: {
    type: T.TO_PROCESS_ITEM_CREATED,
    category: 'to_process', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: true,
    defaults: { push: false, email: false }, retentionDays: 30,
    // Lot 79C : plus d'alerte immédiate pour un élément ordinaire — il reste
    // sur la page « À traiter » ; le récapitulatif quotidien est facultatif.
    retiredChannels: {
      email: 'Supprimé (lot 79) : les éléments restent sur la page « À traiter ».',
      push: 'Supprimé (lot 79) : les éléments restent sur la page « À traiter ».',
    },
    render: (p) => content(
      'Une action vous attend',
      // CDC V2 §14 : deux natures au lieu des quatre familles. `family` sert
      // de repli pour les notifications déjà en file au moment du déploiement.
      p.actionKind === 'ARBITRATE'
        ? 'Une information est à arbitrer dans Verebona.'
        : p.actionKind === 'COMPLETE'
          ? 'Une information est à compléter dans Verebona.'
          : p.family
            ? `Un élément est ${familyLabel(p.family)} dans Verebona.`
            : 'Une action vous attend dans Verebona.',
      undefined, 'notif_to_process_immediate',
    ),
    deepLink: () => '/accueil/a-traiter',
    payloadSchema: z.object({
      itemKey: z.string(),
      actionKind: z.enum(['ARBITRATE', 'COMPLETE']).optional(),
      priority: z.enum(['DO_FIRST', 'DO_NEXT', 'CAN_WAIT']).optional(),
      family: z.enum(['arbitrate', 'attach', 'confirm', 'complete']).optional(),
    }),
  },
  [T.TO_PROCESS_DAILY_DIGEST]: {
    type: T.TO_PROCESS_DAILY_DIGEST,
    category: 'to_process', priority: 'normal', deliveryMode: 'daily_digest',
    mandatoryBell: false, mandatoryEmail: false, neverBell: true,
    // Lot 79C : désactivé par défaut ; une activation volontaire (préférence
    // enregistrée) est conservée. Jamais renvoyé à contenu inchangé.
    defaults: { push: false, email: false }, retentionDays: 30,
    render: (p) => content(
      `Vous avez ${p.total} élément(s) à traiter`,
      'Retrouvez vos éléments à traiter dans Verebona.',
      undefined, 'notif_to_process_digest',
    ),
    deepLink: () => '/accueil/a-traiter',
    // CDC V2 §14 : `byKind` et `byPriority` remplacent `byFamily`, laissé
    // optionnel le temps que les notifications déjà en file soient envoyées.
    payloadSchema: z.object({
      total: z.number(),
      byKind: z.record(z.string(), z.number()).optional(),
      byPriority: z.record(z.string(), z.number()).optional(),
      byFamily: z.record(z.string(), z.number()).optional(),
    }),
  },

  // ── Partage et Duo — décisions obligatoires (§2.11 / §7.4) ─────────────────
  [T.DUO_INVITATION_RECEIVED]: {
    type: T.DUO_INVITATION_RECEIVED,
    category: 'duo', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: true, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p) => content(
      'Invitation Duo',
      `${p.initiatorName ?? 'Quelqu\'un'} vous invite à rejoindre son compte Duo.`,
      { body: 'Vous avez reçu une invitation Duo.' },
      'notif_duo_invitation',
    ),
    // Lot 74B : `/mon-compte/partage` n'a jamais existé — page d'invitation Duo réelle.
    deepLink: (p) => (p.inviteToken ? `/duo/join/${encodeURIComponent(p.inviteToken)}` : '/mon-compte'),
    payloadSchema: z.object({ duoId: z.number().optional(), inviteToken: z.string().optional(), initiatorName: z.string().optional() }),
  },
  [T.DUO_MOVE_REQUEST]: {
    type: T.DUO_MOVE_REQUEST,
    category: 'duo', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: true, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p) => content(
      'Demande de transfert',
      `${p.initiatorName} souhaite transférer ${p.assetLabel} vers son compte.`,
      { body: 'Une demande nécessite votre décision.' },
      'notif_duo_request',
    ),
    // Lot 72D (Q11) : validations croisées retirées — l'ancien lien ouvre le bien.
    deepLink: (p) => `/assets/${p.assetId}`,
    payloadSchema: z.object({ requestId: z.number(), duoId: z.number(), assetId: z.number(), assetLabel: z.string(), initiatorName: z.string() }),
  },
  [T.DUO_DELETE_REQUEST]: {
    type: T.DUO_DELETE_REQUEST,
    category: 'duo', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: true, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p) => content(
      'Demande de suppression',
      `${p.initiatorName} souhaite supprimer ${p.assetLabel}.`,
      { body: 'Une demande nécessite votre décision.' },
      'notif_duo_request',
    ),
    // Lot 72D (Q11) : validations croisées retirées — l'ancien lien ouvre le bien.
    deepLink: (p) => `/assets/${p.assetId}`,
    payloadSchema: z.object({ requestId: z.number(), duoId: z.number(), assetId: z.number(), assetLabel: z.string(), initiatorName: z.string() }),
  },

  // ── Partage et Duo — résultats configurables ───────────────────────────────
  [T.DUO_MOVE_ACCEPTED]: duoResult(T.DUO_MOVE_ACCEPTED, 'transfert', 'acceptée'),
  [T.DUO_MOVE_REFUSED]: duoResult(T.DUO_MOVE_REFUSED, 'transfert', 'refusée'),
  [T.DUO_DELETE_ACCEPTED]: duoResult(T.DUO_DELETE_ACCEPTED, 'suppression', 'acceptée'),
  [T.DUO_DELETE_REFUSED]: duoResult(T.DUO_DELETE_REFUSED, 'suppression', 'refusée'),

  // ══════════════════════════════════════════════════════════════════════════
  // LOT 73B — LA PERSONNE INVITÉE REFUSE L'INVITATION PREMIUM DUO
  //
  // Information du TITULAIRE (destinataire explicite, jamais l'invité) :
  // cloche obligatoire — c'est aussi le statut affiché dans son panneau
  // d'invitation —, push générique (aucune adresse, §4.3). PAS d'e-mail par
  // ce canal : l'e-mail est le gabarit transactionnel DUO_INVITATION_DECLINED
  // (file durable, éditable et désactivable dans le BO) — jamais deux e-mails.
  // ══════════════════════════════════════════════════════════════════════════
  [T.DUO_INVITATION_DECLINED]: {
    type: T.DUO_INVITATION_DECLINED,
    category: 'duo', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: false }, retentionDays: 180,
    render: (p) => content(
      'Invitation refusée',
      p?.inviteEmail
        ? `${p.inviteEmail} a refusé votre invitation à rejoindre votre espace Premium Duo. Vous pouvez la réinviter ou inviter une autre personne.`
        : 'La personne invitée a refusé votre invitation à rejoindre votre espace Premium Duo. Vous pouvez la réinviter ou inviter une autre personne.',
      { body: 'Une invitation Premium Duo a été refusée.' },
    ),
    deepLink: () => '/mon-compte#duo-invitation',
    payloadSchema: z.object({ duoId: z.number().optional(), inviteEmail: z.string().optional() }),
  },

  [T.ACCOUNT_INVITATION]: {
    type: T.ACCOUNT_INVITATION,
    category: 'duo', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: true, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p) => content(
      'Invitation reçue',
      `${p.inviterName ?? 'Quelqu\'un'} vous a invité(e) à rejoindre ${p.accountName ?? 'un compte'}.`,
      { body: 'Vous avez reçu une invitation.' },
      'notif_account_invitation',
    ),
    // Lot 74B : aucun parcours d'acceptation hors Duo (offre Pro non vendue) —
    // plus de lien mort `/mon-compte/partage` ; plus émise (account-service).
    deepLink: () => '/mon-compte',
    payloadSchema: z.object({ inviteToken: z.string().optional(), inviterName: z.string().optional(), accountName: z.string().optional() }),
  },

  // ── Transmission ─────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  // PAS D'E-MAIL ICI — un seul e-mail par transmission
  //
  // L'invitation part déjà par e-mail à la création de la transmission
  // (`sendTransmissionEmail`, objet « Prénom Nom vous transmet un bien —
  // Verebona »), destinataire inscrit ou non. Cette entrée en envoyait un
  // second (« Vous avez reçu une transmission ») aux destinataires déjà
  // inscrits. Elle reste pour la cloche et le push, sans modèle d'e-mail.
  // ══════════════════════════════════════════════════════════════════════════
  [T.TRANSMISSION_RECEIVED]: {
    type: T.TRANSMISSION_RECEIVED,
    category: 'transmission', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: false }, retentionDays: 180,
    render: (p) => content(
      'Transmission reçue',
      `${p.senderName ?? 'Quelqu\'un'} vous a transmis un bien.`,
      { body: 'Vous avez reçu une transmission.' },
    ),
    deepLink: (p) => (p.transmissionToken ? `/transmission/${p.transmissionToken}` : null),
    payloadSchema: z.object({ transmissionToken: z.string().optional(), senderName: z.string().optional(), assetName: z.string().optional() }),
  },
  [T.TRANSMISSION_ACCEPTED]: {
    type: T.TRANSMISSION_ACCEPTED,
    category: 'transmission', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p) => content(
      'Transmission acceptée',
      `${p.recipientName ?? 'Le destinataire'} a accepté votre transmission.`,
      { body: 'Votre transmission a été acceptée.' },
      'notif_transmission_result',
    ),
    deepLink: () => '/assets',
    payloadSchema: z.object({ assetName: z.string().optional(), recipientName: z.string().optional() }),
  },
  [T.TRANSMISSION_REFUSED]: {
    type: T.TRANSMISSION_REFUSED,
    category: 'transmission', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p) => content(
      'Transmission refusée',
      `${p.recipientName ?? 'Le destinataire'} a refusé votre transmission.`,
      { body: 'Votre transmission a été refusée.' },
      'notif_transmission_result',
    ),
    deepLink: () => '/assets',
    payloadSchema: z.object({ assetName: z.string().optional(), recipientName: z.string().optional() }),
  },
  [T.TRANSMISSION_EXPIRED]: {
    type: T.TRANSMISSION_EXPIRED,
    category: 'transmission', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: () => content(
      'Transmission expirée',
      'Une transmission a expiré sans être acceptée.',
      { body: 'Une transmission a expiré.' },
      'notif_transmission_result',
    ),
    deepLink: () => '/assets',
    payloadSchema: z.object({ assetName: z.string().optional() }),
  },

  // ── Compte et abonnement — configurables ───────────────────────────────────
  // Lot 100G : e-mail (gabarits notif_trial_ending / notif_trial_ended, textes
  // PO E1) envoyé par la séquence de fin d'essai ; cloche et push ici.
  [T.TRIAL_ENDING]: { ...accountConfigurable(T.TRIAL_ENDING, 'Votre essai se termine bientôt', 'Votre période d\'essai se termine bientôt.', 'notif_trial_ending'), emailDeliveredBy: 'trial-lifecycle' },
  [T.TRIAL_ENDED]: { ...accountConfigurable(T.TRIAL_ENDED, 'Votre essai est terminé', 'Votre période d\'essai est terminée.', 'notif_trial_ended'), emailDeliveredBy: 'trial-lifecycle' },
  [T.SUBSCRIPTION_RENEWED]: {
    ...accountConfigurable(T.SUBSCRIPTION_RENEWED, 'Abonnement renouvelé', 'Votre abonnement a été renouvelé.', 'notif_subscription'),
    // Lot 79C : plus de push systématique à chaque échéance.
    retiredChannels: { push: 'Supprimé (lot 79) : un renouvellement n’appelle aucune action.' },
    // Lot 81E : `receipt_number` (reçu Stripe) ne prouve ni l'envoi ni la
    // réception d'un justificatif — il ne supprime plus l'e-mail (y compris
    // pour une ligne déjà en file portant `receiptCovered`). Règle explicite
    // dans `lib/billing/invoice-receipt.ts`.
    render: (p: { planCode?: string; billingPeriod?: string | null; nextRenewalAt?: string | null }) => {
      const corps = subscriptionNotificationText('SUBSCRIPTION_RENEWED', p) ?? 'Votre abonnement a été renouvelé.';
      return content('Abonnement renouvelé', corps, { body: corps }, 'notif_subscription');
    },
  },
  // ══════════════════════════════════════════════════════════════════════════
  // CHANGEMENT DE STATUT DU COMPTE : UN LIBELLÉ QUI DIT CE QUI A CHANGÉ
  //
  // « Offre modifiée » n'apprend rien : ni l'offre obtenue, ni le sens du
  // changement. Le contenu est donc construit à partir du payload, comme
  // pour les autres notifications porteuses d'information.
  //
  // Deux types distincts, parce que ce ne sont pas les mêmes moments :
  // l'activation (le compte n'avait aucune offre — sortie d'essai,
  // réabonnement) et le changement d'offre d'un compte déjà abonné.
  // ══════════════════════════════════════════════════════════════════════════
  // Libellés : `subscription-messages.ts`, partagé avec la cloche.
  // « Votre offre a été modifiée. Nouvelle offre : Premium (formule annuelle) »
  [T.SUBSCRIPTION_ACTIVATED]: {
    ...accountConfigurable(T.SUBSCRIPTION_ACTIVATED, 'Offre activée', 'Votre offre a été activée.', 'notif_subscription'),
    render: (p: { planCode?: string; planLabel?: string; billingPeriod?: string | null; confirmationJobId?: number }) => {
      const corps = subscriptionNotificationText('SUBSCRIPTION_ACTIVATED', p) ?? 'Votre offre a été activée.';
      return contractCovered(content('Offre activée', corps, { body: corps }, 'notif_subscription'), p);
    },
    payloadSchema: z.object({
      planCode: z.string(),
      planLabel: z.string(),
      billingPeriod: z.enum(['monthly', 'yearly']).nullish(),
      confirmationJobId: z.number().optional(),
    }).passthrough(),
  },
  [T.SUBSCRIPTION_CHANGED]: {
    ...accountConfigurable(T.SUBSCRIPTION_CHANGED, 'Offre modifiée', 'Votre offre a été modifiée.', 'notif_subscription'),
    render: (p: { planCode?: string; planLabel?: string; billingPeriod?: string | null; confirmationJobId?: number }) => {
      const corps = subscriptionNotificationText('SUBSCRIPTION_CHANGED', p) ?? 'Votre offre a été modifiée.';
      return contractCovered(content('Offre modifiée', corps, { body: corps }, 'notif_subscription'), p);
    },
    payloadSchema: z.object({
      planCode: z.string(),
      planLabel: z.string(),
      billingPeriod: z.enum(['monthly', 'yearly']).nullish(),
      previousPlanCode: z.string().optional(),
      previousPlanLabel: z.string().optional(),
      direction: z.enum(['upgrade', 'downgrade', 'lateral']),
      confirmationJobId: z.number().optional(),
    }).passthrough(),
  },
  [T.SUBSCRIPTION_CHANGE_SCHEDULED]: {
    ...accountConfigurable(T.SUBSCRIPTION_CHANGE_SCHEDULED, 'Changement d’offre programmé', 'Changement d’offre programmé.', 'notif_subscription'),
    render: (p: { planCode?: string; billingPeriod?: string | null; effectiveAt?: string }) => {
      const corps = subscriptionNotificationText('SUBSCRIPTION_CHANGE_SCHEDULED', p) ?? 'Changement d’offre programmé.';
      return content('Changement d’offre programmé', corps, { body: corps }, 'notif_subscription');
    },
    payloadSchema: z.object({
      planCode: z.string(),
      billingPeriod: z.enum(['monthly', 'yearly']).nullish(),
      effectiveAt: z.string().nullish(),
    }).passthrough(),
  },
  // Lot 81E : résiliation PROGRAMMÉE (demande enregistrée, accès conservé
  // jusqu'à l'échéance) — étape distincte de la prise d'effet, produite une
  // fois par demande (`subscription-communications.service`).
  [T.SUBSCRIPTION_CANCELLATION_SCHEDULED]: {
    ...accountConfigurable(T.SUBSCRIPTION_CANCELLATION_SCHEDULED, 'Résiliation programmée', 'La résiliation de votre abonnement est programmée.', 'notif_subscription'),
    render: (p: { effectiveAt?: string }) => {
      const corps = subscriptionNotificationText('SUBSCRIPTION_CANCELLATION_SCHEDULED', p) ?? 'La résiliation de votre abonnement est programmée.';
      return content('Résiliation programmée', corps, { body: corps }, 'notif_subscription');
    },
  },
  [T.SUBSCRIPTION_CANCELLED]: {
    ...accountConfigurable(T.SUBSCRIPTION_CANCELLED, 'Abonnement résilié', 'Votre abonnement a été résilié.', 'notif_subscription'),
    // Lot 79C / 81E : la prise d'effet d'une résiliation d'offre supérieure
    // enregistre l'e-mail transactionnel DURABLE DOWNGRADE_NOTIFICATION pour
    // la MÊME opération (`endedEmailJobId`) — pas de second e-mail
    // équivalent. Sans demande durable (ou ancienne ligne `downgradeEmailSent`,
    // simple intention), l'e-mail générique part. Cloche et push inchangés.
    render: (p: { endedEmailJobId?: number }) => {
      const base = content('Abonnement résilié', 'Votre abonnement a été résilié.', { body: 'Votre abonnement a été résilié.' }, 'notif_subscription');
      return typeof p?.endedEmailJobId === 'number'
        ? { ...base, emailTemplateCode: undefined, emailSkipReason: `covered_by_end_of_offer_email:${p.endedEmailJobId}` }
        : base;
    },
  },

  [T.REFERRAL_REWARD_GRANTED]: {
    type: T.REFERRAL_REWARD_GRANTED,
    category: 'account', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: false }, retentionDays: 90,
    render: () => content(
      'Récompense de parrainage',
      'Votre récompense de parrainage a été créditée.',
      { body: 'Votre récompense de parrainage a été créditée.' },
      'notif_referral_reward',
    ),
    deepLink: () => '/mon-compte/offres',
    payloadSchema: z.object({ referralEventId: z.number(), referredAccountId: z.number().optional() }),
  },
  // Export « Mes données » prêt (CDC BO GDP-021) : émis seulement lorsque la
  // génération n'a pas pu aboutir pendant la requête. Cloche obligatoire :
  // l'utilisateur a demandé l'archive et doit savoir qu'elle l'attend. Le
  // lien mène à Mon compte (session requise), jamais à l'URL de stockage.
  [T.GDPR_EXPORT_READY]: {
    type: T.GDPR_EXPORT_READY,
    category: 'account', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 30,
    render: () => content(
      'Export de vos données prêt',
      'L’archive de vos données est prête. Téléchargez-la depuis Mon compte avant son expiration.',
      { body: 'L’archive de vos données est prête.' },
      'notif_gdpr_export',
    ),
    deepLink: () => '/mon-compte#mes-donnees',
    payloadSchema: z.object({ exportId: z.number(), expiresAt: z.string().optional() }),
  },

  // ── Compte et abonnement — obligatoires (§2.11) ────────────────────────────
  // Cycle d'impayé de 90 jours (Centre d'aide GAP-06, AID-BILL-008) : J0 et
  // rappels J-7 / J-1. L'échéance figure dans la cloche et l'email ; le push
  // reste générique (§4.3).
  [T.PAYMENT_FAILED]: {
    ...accountMandatory(T.PAYMENT_FAILED, 'Incident de paiement', 'Un paiement a échoué. Merci de régulariser votre moyen de paiement.', 'notif_payment_incident'),
    render: (p) => content(
      'Incident de paiement',
      // Lot 79C : un même incident (échec + authentification demandée sur la
      // même facture) produit UN message : problème, conséquences, action.
      unpaidNotificationText('J0', p?.deadlineAt) + (p?.authenticationRequired ? ` ${PAYMENT_AUTHENTICATION_ACTION}` : ''),
      { body: 'Un paiement a échoué. Merci de régulariser votre moyen de paiement.' },
      'notif_payment_incident',
    ),
  },
  [T.PAYMENT_ACTION_REQUIRED]: accountMandatory(T.PAYMENT_ACTION_REQUIRED, 'Action requise sur votre paiement', 'Une action est requise pour valider votre paiement.', 'notif_payment_incident'),
  [T.SUBSCRIPTION_SUSPENDED]: accountMandatory(T.SUBSCRIPTION_SUSPENDED, 'Abonnement suspendu', 'Votre abonnement est suspendu pour un motif de paiement.', 'notif_payment_incident'),
  [T.ACCOUNT_READ_ONLY]: {
    ...accountMandatory(T.ACCOUNT_READ_ONLY, 'Compte en lecture seule', 'Votre compte est passé en lecture seule pour un motif de paiement.', 'notif_payment_incident'),
    render: (p) => p?.reason === 'unpaid'
      ? content(
          'Suppression prochaine de vos données',
          unpaidNotificationText('REMINDER', p?.deadlineAt),
          { title: 'Paiement à régulariser', body: 'Régularisez votre paiement pour conserver vos données.' },
          'notif_payment_incident',
        )
      : content(
          'Compte en lecture seule',
          'Votre compte est passé en lecture seule pour un motif de paiement.',
          undefined,
          'notif_payment_incident',
        ),
  },

  // Suppression volontaire du compte (décision produit : différée de 30
  // jours). Obligatoires (cloche + e-mail) : l'utilisateur doit savoir
  // jusqu'à quand il peut annuler. Le lien mène à l'écran « Compte en cours
  // de suppression », derrière la connexion (jamais de lien d'annulation
  // sans authentification). Le push reste générique (§4.3).
  [T.ACCOUNT_DELETION_SCHEDULED]: {
    ...accountMandatory(T.ACCOUNT_DELETION_SCHEDULED, 'Suppression de votre compte programmée', 'Votre compte est clôturé.', 'notif_account_deletion'),
    render: (p) => content(
      'Suppression de votre compte programmée',
      accountDeletionNotificationText('SCHEDULED', p?.scheduledAt),
      { title: 'Compte clôturé', body: 'La suppression de votre compte est programmée.' },
      'notif_account_deletion',
    ),
    deepLink: () => '/compte-en-suppression',
    payloadSchema: z.object({ scheduledAt: z.string() }),
  },
  [T.ACCOUNT_DELETION_REMINDER]: {
    ...accountMandatory(T.ACCOUNT_DELETION_REMINDER, 'Suppression de votre compte dans 7 jours', 'Votre compte sera bientôt supprimé.', 'notif_account_deletion'),
    render: (p) => content(
      'Suppression de votre compte dans 7 jours',
      accountDeletionNotificationText('REMINDER', p?.scheduledAt),
      { title: 'Suppression prochaine', body: 'Votre compte sera bientôt supprimé.' },
      'notif_account_deletion',
    ),
    deepLink: () => '/compte-en-suppression',
    payloadSchema: z.object({ scheduledAt: z.string(), daysLeft: z.number() }),
  },

  // ── Sécurité — information obligatoire PAR E-MAIL (§7.7 ; lot 101B) ───────
  // Décision PO du 30/10/2026 : l'e-mail de sécurité obligatoire suffit ;
  // aucune cloche, aucun toast, aucun push pour ces événements
  // (`securityInformation`). Détection, déduplication et contenu inchangés.
  [T.PASSWORD_CHANGED]: securityInformation(T.PASSWORD_CHANGED, 'Mot de passe modifié', 'Votre mot de passe a été modifié.'),
  // EMAIL_CHANGE_REQUESTED / EMAIL_CHANGED : déclarés, sans producteur — le
  // changement d'adresse (lot 96A) envoie ses propres e-mails de sécurité
  // transactionnels (`PRIMARY_EMAIL_CHANGED` aux deux adresses).
  [T.EMAIL_CHANGE_REQUESTED]: securityInformation(T.EMAIL_CHANGE_REQUESTED, 'Changement d\'email demandé', 'Une modification de votre adresse email a été demandée.'),
  [T.EMAIL_CHANGED]: securityInformation(T.EMAIL_CHANGED, 'Email modifié', 'Votre adresse email a été modifiée.'),
  [T.PASSWORD_RESET_COMPLETED]: securityInformation(T.PASSWORD_RESET_COMPLETED, 'Mot de passe réinitialisé', 'Votre mot de passe a été réinitialisé.'),
  // Lot 96B (CDC 18 Q6, SESS-11) : connexion réussie depuis un appareil
  // inconnu pour ce compte (`lib/auth/new-device-alert.ts`). E-mail de
  // sécurité OBLIGATOIRE (non désactivable) ; lot 101B : plus de cloche ni de
  // push (c'était le grand toast de l'accueil mobile). Date, appareil et
  // navigateur / application ; ni IP ni localisation. Lien : Mon compte ›
  // Sécurité › Appareils connectés.
  [T.NEW_DEVICE_LOGIN]: {
    ...securityInformation(T.NEW_DEVICE_LOGIN, 'Connexion depuis un nouvel appareil', 'Une connexion à votre compte depuis un nouvel appareil a eu lieu.'),
    retentionDays: 180,
    render: (p) => newDeviceContent(p),
    deepLink: () => NEW_DEVICE_LOGIN_LINK,
    payloadSchema: z.object({
      at: z.string(), deviceLabel: z.string().max(80), browserLabel: z.string().max(80), clientType: z.string().max(20).optional(),
    }),
  },

  // Lot 100D (décision PO A2 ; CDC 18 §22 « Déconnexion de toutes les autres
  // sessions ») : e-mail de sécurité OBLIGATOIRE, envoyé UNIQUEMENT par
  // « Déconnecter tous les autres appareils » quand au moins une session a
  // réellement été révoquée — jamais pour un appareil seul, ni pour une
  // révocation du BO, un changement de mot de passe ou un rejeu. Lot 101B :
  // plus de cloche (la confirmation de l'action reste le message affiché à
  // l'écran par Mon compte › Sécurité). Aucun lien commercial, aucun secret.
  [T.OTHER_SESSIONS_REVOKED]: {
    ...securityInformation(T.OTHER_SESSIONS_REVOKED, 'Vos autres appareils ont été déconnectés', 'La déconnexion de vos autres appareils a pris effet.'),
    retentionDays: 180,
    render: (p) => otherSessionsRevokedContent(p),
    deepLink: () => NEW_DEVICE_LOGIN_LINK,
    payloadSchema: z.object({
      at: z.string(), count: z.number().int().min(1).max(1000),
      deviceLabel: z.string().max(80).optional(), browserLabel: z.string().max(80).optional(),
    }),
  },

  // Lot 93 (CDC 18 §22, NOTIF-01) : e-mail obligatoire, nom du fournisseur
  // seulement — ni adresse, ni identifiant, ni appareil. Lot 101B : plus de
  // cloche ni de push.
  [T.AUTH_IDENTITY_LINKED]: {
    ...securityInformation(T.AUTH_IDENTITY_LINKED, 'Méthode de connexion ajoutée', 'Un compte Google ou Apple a été associé à votre compte Verebona.'),
    render: (p) => identityContent('linked', p?.provider),
    payloadSchema: z.object({ provider: z.enum(['google', 'apple']) }),
  },
  [T.AUTH_IDENTITY_UNLINKED]: {
    ...securityInformation(T.AUTH_IDENTITY_UNLINKED, 'Méthode de connexion retirée', 'Un compte Google ou Apple a été dissocié de votre compte Verebona.'),
    render: (p) => identityContent('unlinked', p?.provider),
    payloadSchema: z.object({ provider: z.enum(['google', 'apple']) }),
  },

  // ── Actualités Verebona (consentement distinct, jamais dans la cloche) ─────
  [T.NEWS_ANNOUNCEMENT]: {
    type: T.NEWS_ANNOUNCEMENT,
    category: 'news', priority: 'low', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: true,
    defaults: { push: false, email: false }, retentionDays: 90,
    render: () => content(
      'Actualité Verebona',
      'Découvrez les nouveautés Verebona.',
      undefined, 'notif_news',
    ),
    deepLink: (p) => p.url ?? '/',
    payloadSchema: z.object({ announcementId: z.string().optional(), url: z.string().optional() }),
  },
};

// ── Fabriques d'entrées répétitives ──────────────────────────────────────────
function duoResult(type: NotificationType, kind: 'transfert' | 'suppression', outcome: 'acceptée' | 'refusée'): CatalogEntry {
  return {
    type,
    category: 'duo', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p: any) => content(
      `Demande ${outcome}`,
      `Votre demande de ${kind}${p?.assetLabel ? ` de ${p.assetLabel}` : ''} a été ${outcome}.`,
      { body: `Votre demande de ${kind} a été ${outcome}.` },
      'notif_duo_result',
    ),
    // Lot 74B : demandes croisées retirées (72D) — plus de lien mort `/mon-compte/partage`.
    deepLink: () => '/assets',
    payloadSchema: z.object({ requestId: z.number().optional(), assetLabel: z.string().optional() }),
  };
}

function accountConfigurable(type: NotificationType, bellTitle: string, body: string, emailTemplateCode: string): CatalogEntry {
  return {
    type,
    category: 'account', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 90,
    render: () => content(bellTitle, body, { body }, emailTemplateCode),
    deepLink: () => '/mon-compte/offres',
    payloadSchema: z.object({}).passthrough(),
  };
}

/** Texte cloche/email du cycle d'impayé (AID-BILL-008). */
export function unpaidNotificationText(moment: 'J0' | 'REMINDER', deadlineAt?: string | null): string {
  const date = deadlineAt ? formatUnpaidDeadline(deadlineAt) : '';
  if (moment === 'J0') {
    return date
      ? 'Un paiement a échoué : les fonctions de votre compte sont suspendues. Vos biens et documents restent ' +
        `consultables, exportables et transmissibles. Régularisez votre paiement avant le ${date} ; sans ` +
        'régularisation, vos données seront supprimées à cette date.'
      : 'Un paiement a échoué. Merci de régulariser votre moyen de paiement.';
  }
  return date
    ? `Sans régularisation de votre paiement, vos données seront supprimées le ${date}. D'ici là, vous pouvez ` +
      'régulariser, exporter vos données ou transmettre vos biens.'
    : 'Sans régularisation de votre paiement, vos données seront prochainement supprimées.';
}

/** Texte cloche/e-mail de la suppression volontaire du compte (AID-ACCOUNT-006). */
export function accountDeletionNotificationText(moment: 'SCHEDULED' | 'REMINDER', scheduledAt?: string | null): string {
  const date = scheduledAt ? formatUnpaidDeadline(scheduledAt) : '';
  const quand = date ? `le ${date}` : 'dans 30 jours';
  if (moment === 'SCHEDULED') {
    return `Votre compte Verebona est clôturé à votre demande. Il sera définitivement supprimé ${quand}, ` +
      'avec vos biens, documents, fichiers et échéances. D’ici là, vous pouvez annuler la suppression ou ' +
      'exporter vos données en vous reconnectant.';
  }
  return `Votre compte Verebona sera définitivement supprimé ${quand}. C’est la dernière occasion ` +
    'd’annuler la suppression ou d’exporter vos données : reconnectez-vous pour le faire.';
}

function accountMandatory(type: NotificationType, bellTitle: string, body: string, emailTemplateCode: string): CatalogEntry {
  return {
    type,
    category: 'account', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: true, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 365,
    render: () => content(bellTitle, body, { body }, emailTemplateCode),
    deepLink: () => '/mon-compte/offres',
    payloadSchema: z.object({}).passthrough(),
  };
}

/**
 * Information de sécurité (§7.7) — lot 101B, trois notions SÉPARÉES :
 *
 *  1. OBLIGATION D'INFORMER : oui, toujours (non désactivable) ;
 *  2. CANAL OBLIGATOIRE : l'e-mail (`mandatoryEmail`) — préférence, BO et
 *     réémission ne peuvent pas le couper ; gabarit, déduplication, journal
 *     des envois et traçabilité des échecs inchangés ;
 *  3. AFFICHAGE DANS L'APPLICATION : aucun — l'événement n'appelle aucune
 *     action immédiate. Cloche et push sont SUPPRIMÉS (`retiredChannels`),
 *     donc coupés à l'envoi même pour une ligne mise en file avant le lot 101B
 *     (`mandatory_bell` historique), et les cloches déjà persistées ne sont
 *     plus servies (`bellRetiredTypes`). Pas de `mandatoryBell` : c'est lui
 *     qui déclenchait le toast d'arrivée de la cloche.
 *
 * Consommateurs (analysés au lot 101B) : uniquement les 8 entrées de la
 * catégorie « Sécurité » ci-dessus, toutes visées par la décision PO.
 * Les messages FONCTIONNELS liés à une action (erreur d'authentification,
 * session expirée, réauthentification, échec d'une opération sensible,
 * confirmation « Appareil déconnecté »…) ne passent pas par ce catalogue :
 * ils restent affichés par l'écran qui a fait la demande.
 */
function securityInformation(type: NotificationType, bellTitle: string, body: string): CatalogEntry {
  return {
    type,
    category: 'security', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: true, neverBell: false,
    defaults: { push: false, email: true }, retentionDays: 365,
    retiredChannels: { bell: RETIRED_SECURITY_IN_APP, push: RETIRED_SECURITY_IN_APP },
    // `bellTitle` / `bellBody` restent le titre et le texte de l'E-MAIL
    // (variables {{title}} / {{body}} du gabarit, `channels.ts`).
    render: () => content(bellTitle, body, undefined, 'notif_security'),
    deepLink: () => '/mon-compte',
    payloadSchema: z.object({}).passthrough(),
  };
}

/**
 * Lot 96B : Mon compte › Sécurité › Appareils connectés.
 * Lot 101C : ancre du sous-bloc (fermé par défaut) — le lien ouvre la carte
 * Sécurité ET le sous-bloc, puis le fait défiler. Directement `/mon-compte`
 * (lien d'application Android déclaré ; pas de détour par la redirection
 * `/mon-compte/informations`).
 */
export const NEW_DEVICE_LOGIN_LINK = '/mon-compte#appareils-connectes';

/**
 * Lot 96B (Q6) : « Connexion depuis un nouvel appareil » — date et heure
 * (Europe/Paris), appareil, navigateur ou application. Ni IP ni localisation.
 */
export function newDeviceContent(p: unknown): RenderedContent {
  const x = (p ?? {}) as { at?: unknown; deviceLabel?: unknown; browserLabel?: unknown };
  const at = typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) ? new Date(x.at) : null;
  const device = [x.deviceLabel, x.browserLabel].filter((v): v is string => typeof v === 'string' && v.trim() !== '').join(' · ');
  const when = at ? `le ${formatSecurityIncidentDate(at)}` : 'récemment';
  const title = 'Connexion depuis un nouvel appareil';
  const body = `Une connexion à votre compte Verebona a eu lieu ${when}${device ? ` depuis : ${device}` : ''}. `
    + 'Si c’est vous, vous n’avez rien à faire. Sinon, ouvrez Mon compte › Sécurité › Appareils connectés, '
    + 'déconnectez cet appareil, puis modifiez votre mot de passe.';
  // Lot 101B : ni cloche ni push — titre et texte de l'e-mail seulement.
  return content(title, body, undefined, 'notif_new_device_login');
}

/**
 * Lot 100D (A2) : « Vos autres appareils ont été déconnectés » — date et heure
 * (Europe/Paris), nombre d'appareils déconnectés, appareil qui a fait la
 * demande. Ni IP, ni localisation, ni lien commercial, ni jeton.
 */
export function otherSessionsRevokedContent(p: unknown): RenderedContent {
  const x = (p ?? {}) as { at?: unknown; count?: unknown; deviceLabel?: unknown; browserLabel?: unknown };
  const at = typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) ? new Date(x.at) : null;
  const n = typeof x.count === 'number' && Number.isFinite(x.count) && x.count > 0 ? Math.floor(x.count) : null;
  const device = [x.deviceLabel, x.browserLabel].filter((v): v is string => typeof v === 'string' && v.trim() !== '').join(' · ');
  const when = at ? `le ${formatSecurityIncidentDate(at)}` : 'récemment';
  const combien = n === null ? 'Vos autres appareils ont été déconnectés'
    : n === 1 ? '1 autre appareil a été déconnecté' : `${n} autres appareils ont été déconnectés`;
  const title = 'Vos autres appareils ont été déconnectés';
  const body = `${combien} de votre compte Verebona ${when}, à la demande faite depuis Mon compte › Sécurité`
    + `${device ? ` sur : ${device}` : ''}. Seul l’appareil qui a fait la demande est resté connecté. `
    + 'Si c’est vous, vous n’avez rien à faire. Sinon, modifiez dès maintenant votre mot de passe '
    + 'depuis Mon compte › Sécurité : tous les appareils seront alors déconnectés.';
  return content(title, body, undefined, 'notif_other_sessions_revoked');
}

/** Lot 93 : texte « Google / Apple associé ou dissocié » (NOTIF-01). */
function identityContent(kind: 'linked' | 'unlinked', provider: unknown): RenderedContent {
  const name = provider === 'apple' ? 'Apple' : provider === 'google' ? 'Google' : 'Google ou Apple';
  const title = kind === 'linked' ? `Connexion avec ${name} activée` : `Connexion avec ${name} retirée`;
  const body = kind === 'linked'
    ? `Votre compte ${name} a été associé à votre compte Verebona : vous pouvez l’utiliser pour vous connecter. Si ce n’est pas vous, ouvrez Mon compte › Sécurité et changez votre mot de passe.`
    : `Votre compte ${name} a été dissocié de votre compte Verebona : il ne permet plus de vous connecter. Si ce n’est pas vous, ouvrez Mon compte › Sécurité.`;
  return content(title, body, undefined, 'notif_security');
}

function familyLabel(family: string): string {
  switch (family) {
    case 'arbitrate': return 'à arbitrer';
    case 'attach': return 'à rattacher';
    case 'confirm': return 'à confirmer';
    case 'complete': return 'à compléter';
    default: return 'à traiter';
  }
}

// ── Accès ──────────────────────────────────────────────────────────────────
export function getCatalogEntry(type: string): CatalogEntry | undefined {
  return NOTIFICATION_CATALOG[type as NotificationType];
}

/** Toutes les catégories exposées dans l'écran de préférences (§8.2). */
export const CONFIGURABLE_CATEGORIES: NotificationCategory[] = [
  'deadlines', 'documents', 'to_process', 'duo', 'transmission', 'account', 'security', 'news',
];
