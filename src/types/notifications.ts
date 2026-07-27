/**
 * Catalogue central des types de notification Verebona.
 *
 * Lot 0 : ce fichier devient la source unique de vérité des *types* réellement
 * produits par l'application, ainsi que la forme typée de leur payload.
 * Les métadonnées complètes (catégorie, priorité, canaux autorisés/obligatoires,
 * valeurs par défaut, libellés, template email, règle de déduplication) seront
 * attachées au Lot 1 dans le catalogue central (cf. CDC §16). Les valeurs de
 * chaîne des types existants sont conservées telles quelles pour ne pas casser
 * les lignes historiques de la table `notifications` (cf. CDC §22.1).
 */

export const NOTIFICATION_TYPES = {
  // ── Échéances et rappels (produit au Lot 4) ──────────────────────────────
  DEADLINE_DUE_IN_7_DAYS: 'DEADLINE_DUE_IN_7_DAYS',

  // ── Documents ────────────────────────────────────────────────────────────
  // Une seule notification par lot (cf. CDC §7.2). DOCUMENT_ANALYZED est
  // conservé uniquement pour le rendu des lignes historiques.
  DOCUMENT_ANALYZED: 'DOCUMENT_ANALYZED', // @deprecated — remplacé par DOCUMENT_BATCH_*
  DOCUMENT_BATCH_COMPLETED: 'DOCUMENT_BATCH_COMPLETED',
  DOCUMENT_BATCH_PARTIALLY_FAILED: 'DOCUMENT_BATCH_PARTIALLY_FAILED',
  DOCUMENT_BATCH_FAILED: 'DOCUMENT_BATCH_FAILED',
  ANALYSIS_FAILED_PERSISTENT: 'ANALYSIS_FAILED_PERSISTENT',

  // ── À traiter (produit au Lot 4, jamais dans la cloche) ──────────────────
  TO_PROCESS_ITEM_CREATED: 'TO_PROCESS_ITEM_CREATED',
  TO_PROCESS_DAILY_DIGEST: 'TO_PROCESS_DAILY_DIGEST',

  // ── Partage et Duo ────────────────────────────────────────────────────────
  DUO_INVITATION_RECEIVED: 'DUO_INVITATION_RECEIVED',
  ACCOUNT_INVITATION: 'ACCOUNT_INVITATION', // conservé (invitation compte partagé historique)
  DUO_MOVE_REQUEST: 'DUO_MOVE_REQUEST',
  DUO_DELETE_REQUEST: 'DUO_DELETE_REQUEST',
  DUO_MOVE_ACCEPTED: 'DUO_MOVE_ACCEPTED',
  DUO_MOVE_REFUSED: 'DUO_MOVE_REFUSED',
  DUO_DELETE_ACCEPTED: 'DUO_DELETE_ACCEPTED',
  DUO_DELETE_REFUSED: 'DUO_DELETE_REFUSED',

  // ── Transmission ──────────────────────────────────────────────────────────
  TRANSMISSION_RECEIVED: 'TRANSMISSION_RECEIVED',
  TRANSMISSION_ACCEPTED: 'TRANSMISSION_ACCEPTED',
  TRANSMISSION_REFUSED: 'TRANSMISSION_REFUSED',
  TRANSMISSION_EXPIRED: 'TRANSMISSION_EXPIRED',

  // ── Compte et abonnement ──────────────────────────────────────────────────
  TRIAL_ENDING: 'TRIAL_ENDING',
  TRIAL_ENDED: 'TRIAL_ENDED',
  SUBSCRIPTION_RENEWED: 'SUBSCRIPTION_RENEWED',
  SUBSCRIPTION_CHANGED: 'SUBSCRIPTION_CHANGED',
  SUBSCRIPTION_CANCELLATION_SCHEDULED: 'SUBSCRIPTION_CANCELLATION_SCHEDULED',
  SUBSCRIPTION_CANCELLED: 'SUBSCRIPTION_CANCELLED',
  ANALYSIS_QUOTA_90: 'ANALYSIS_QUOTA_90',
  ANALYSIS_QUOTA_100: 'ANALYSIS_QUOTA_100',
  REFERRAL_REWARD_GRANTED: 'REFERRAL_REWARD_GRANTED',

  // ── Compte et abonnement — obligatoires (cloche + email) ─────────────────
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_ACTION_REQUIRED: 'PAYMENT_ACTION_REQUIRED',
  SUBSCRIPTION_SUSPENDED: 'SUBSCRIPTION_SUSPENDED',
  ACCOUNT_READ_ONLY: 'ACCOUNT_READ_ONLY',

  // ── Sécurité — obligatoires (cloche + email) ─────────────────────────────
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  EMAIL_CHANGE_REQUESTED: 'EMAIL_CHANGE_REQUESTED',
  EMAIL_CHANGED: 'EMAIL_CHANGED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  NEW_DEVICE_LOGIN: 'NEW_DEVICE_LOGIN', // phase ultérieure (registre d'appareils)

  // ── Actualités Verebona (consentement distinct, jamais dans la cloche) ───
  NEWS_ANNOUNCEMENT: 'NEWS_ANNOUNCEMENT',
} as const;

export type NotificationType = typeof NOTIFICATION_TYPES[keyof typeof NOTIFICATION_TYPES];

/**
 * Payloads typés par type de notification.
 * Objectif Lot 0 : détecter à la compilation un payload incomplet côté
 * producteur (cf. CDC §16 « payload incomplet détecté à la compilation »).
 * La validation Zod à l'exécution sera ajoutée au Lot 1.
 */
export interface NotificationPayloadMap {
  DEADLINE_DUE_IN_7_DAYS: { count: number; date: string; agendaItemIds?: number[] };

  DOCUMENT_ANALYZED: { assetFileId: number; analysedCount: number; failedCount: number; documentTitle?: string };
  DOCUMENT_BATCH_COMPLETED: { lotId: number; analysedCount: number; failedCount: number };
  DOCUMENT_BATCH_PARTIALLY_FAILED: { lotId: number; analysedCount: number; failedCount: number };
  DOCUMENT_BATCH_FAILED: { lotId: number; analysedCount: number; failedCount: number };
  ANALYSIS_FAILED_PERSISTENT: { assetFileId: number; documentTitle?: string; errorReason?: string };

  TO_PROCESS_ITEM_CREATED: { family: 'arbitrate' | 'attach' | 'confirm' | 'complete'; itemKey: string };
  TO_PROCESS_DAILY_DIGEST: { total: number; byFamily: Record<string, number> };

  DUO_INVITATION_RECEIVED: { duoId?: number; inviteToken?: string; initiatorName?: string };
  ACCOUNT_INVITATION: { inviteToken?: string; inviterName?: string; accountName?: string };
  DUO_MOVE_REQUEST: { requestId: number; duoId: number; assetId: number; assetLabel: string; initiatorName: string };
  DUO_DELETE_REQUEST: { requestId: number; duoId: number; assetId: number; assetLabel: string; initiatorName: string };
  DUO_MOVE_ACCEPTED: { requestId: number; assetLabel: string };
  DUO_MOVE_REFUSED: { requestId: number; assetLabel: string };
  DUO_DELETE_ACCEPTED: { requestId: number; assetLabel: string };
  DUO_DELETE_REFUSED: { requestId: number; assetLabel: string };

  TRANSMISSION_RECEIVED: { transmissionToken?: string; senderName?: string; assetName?: string };
  TRANSMISSION_ACCEPTED: { assetName?: string; recipientName?: string };
  TRANSMISSION_REFUSED: { assetName?: string; recipientName?: string };
  TRANSMISSION_EXPIRED: { assetName?: string };

  TRIAL_ENDING: { daysLeft?: number; endsAt?: string };
  TRIAL_ENDED: Record<string, never>;
  SUBSCRIPTION_RENEWED: { planCode?: string };
  SUBSCRIPTION_CHANGED: { planCode?: string };
  SUBSCRIPTION_CANCELLATION_SCHEDULED: { effectiveAt?: string };
  SUBSCRIPTION_CANCELLED: Record<string, never>;
  ANALYSIS_QUOTA_90: { accountId: number; threshold: 90; includedConsumed: number; includedQuota: number; cta?: string; planCode?: string };
  ANALYSIS_QUOTA_100: { accountId: number; threshold: 100; includedConsumed: number; includedQuota: number; cta?: string; planCode?: string };
  REFERRAL_REWARD_GRANTED: { referralEventId: number; referredAccountId?: number };

  PAYMENT_FAILED: { accountId?: number; duoId?: number };
  PAYMENT_ACTION_REQUIRED: { accountId?: number; duoId?: number };
  SUBSCRIPTION_SUSPENDED: { accountId?: number };
  ACCOUNT_READ_ONLY: { accountId?: number; reason?: string };

  PASSWORD_CHANGED: Record<string, never>;
  EMAIL_CHANGE_REQUESTED: { newEmail?: string };
  EMAIL_CHANGED: { newEmail?: string };
  PASSWORD_RESET_COMPLETED: Record<string, never>;
  NEW_DEVICE_LOGIN: { platform?: string };

  NEWS_ANNOUNCEMENT: { announcementId?: string; url?: string };
}

export type NotificationPayloadFor<T extends NotificationType> =
  T extends keyof NotificationPayloadMap ? NotificationPayloadMap[T] : Record<string, unknown>;
