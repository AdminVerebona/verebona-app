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
 *  - « À traiter » et « Actualités » ne sont jamais ajoutés dans la cloche
 *    (`neverBell`).
 */

import { z } from 'zod';
import { NOTIFICATION_TYPES, type NotificationType } from '@/types/notifications';

export type NotificationCategory =
  | 'deadlines'
  | 'documents'
  | 'to_process'
  | 'duo'
  | 'transmission'
  | 'account'
  | 'security'
  | 'news';

export type NotificationChannel = 'bell' | 'push' | 'email';
export type DeliveryMode = 'immediate' | 'daily_digest';
export type NotificationPriority = 'low' | 'normal' | 'high';

export interface RenderedContent {
  bellTitle: string;
  bellBody: string;
  pushTitle: string;
  pushBody: string;
  emailTemplateCode?: string;
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
      p.count > 1 ? `${p.count} échéances dans 7 jours` : 'Échéance dans 7 jours',
      'Une action est à prévoir dans Verebona.',
      undefined, 'notif_deadline_j7',
    ),
    deepLink: (p) => `/agenda${p.date ? `?date=${p.date}` : ''}`,
    payloadSchema: z.object({ count: z.number(), date: z.string(), agendaItemIds: z.array(z.number()).optional() }),
  },

  // ── Documents ───────────────────────────────────────────────────────────────
  [T.DOCUMENT_BATCH_COMPLETED]: {
    type: T.DOCUMENT_BATCH_COMPLETED,
    category: 'documents', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: false }, retentionDays: 90,
    render: (p) => content(
      'Analyse terminée',
      `${p.analysedCount} document(s) analysé(s)`,
      { body: 'Votre analyse de documents est terminée.' },
    ),
    deepLink: () => '/documents',
    payloadSchema: z.object({ lotId: z.number(), analysedCount: z.number(), failedCount: z.number() }),
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
    render: (p) => content(
      'Analyse terminée avec une anomalie',
      `${p.analysedCount} document(s) analysé(s), ${p.failedCount} à vérifier`,
      { body: 'Certains documents n\'ont pas pu être analysés.' },
      'notif_document_batch_failed',
    ),
    deepLink: () => '/documents',
    payloadSchema: z.object({ lotId: z.number(), analysedCount: z.number(), failedCount: z.number() }),
  },
  [T.DOCUMENT_BATCH_FAILED]: {
    type: T.DOCUMENT_BATCH_FAILED,
    category: 'documents', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    // Pas d'email : cf. le bandeau ci-dessus.
    defaults: { push: true, email: false }, retentionDays: 90,
    render: () => content(
      'Analyse impossible',
      'Nous n\'avons pas pu analyser vos documents. Notre équipe en est informée.',
      { body: 'Nous n\'avons pas pu analyser vos documents.' },
      'notif_document_batch_failed',
    ),
    deepLink: () => '/documents',
    payloadSchema: z.object({ lotId: z.number(), analysedCount: z.number(), failedCount: z.number() }),
  },
  [T.ANALYSIS_FAILED_PERSISTENT]: {
    type: T.ANALYSIS_FAILED_PERSISTENT,
    category: 'documents', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    // Pas d'email : cf. le bandeau ci-dessus. Cet événement suit déjà un
    // `DOCUMENT_BATCH_*` sur le même incident — deux envois pour un seul fait.
    defaults: { push: true, email: false }, retentionDays: 90,
    render: (p) => content(
      'Analyse impossible',
      `Nous n\'avons pas pu analyser ce document${p.documentTitle ? ` : ${p.documentTitle}` : ''}. Notre équipe en est informée.`,
      { body: 'Un document n\'a pas pu être analysé.' },
      'notif_document_batch_failed',
    ),
    deepLink: (p) => (p.assetFileId ? `/documents/${p.assetFileId}` : '/documents'),
    payloadSchema: z.object({ assetFileId: z.number(), documentTitle: z.string().optional(), errorReason: z.string().optional() }),
  },

  // ── À traiter (Lot 4 — jamais dans la cloche) ──────────────────────────────
  [T.TO_PROCESS_ITEM_CREATED]: {
    type: T.TO_PROCESS_ITEM_CREATED,
    category: 'to_process', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: true,
    defaults: { push: false, email: false }, retentionDays: 30,
    render: (p) => content(
      'Un élément est à traiter',
      `Un élément est ${familyLabel(p.family)} dans Verebona.`,
      undefined, 'notif_to_process_immediate',
    ),
    deepLink: () => '/accueil/a-traiter',
    payloadSchema: z.object({ family: z.enum(['arbitrate', 'attach', 'confirm', 'complete']), itemKey: z.string() }),
  },
  [T.TO_PROCESS_DAILY_DIGEST]: {
    type: T.TO_PROCESS_DAILY_DIGEST,
    category: 'to_process', priority: 'normal', deliveryMode: 'daily_digest',
    mandatoryBell: false, mandatoryEmail: false, neverBell: true,
    defaults: { push: false, email: true }, retentionDays: 30,
    render: (p) => content(
      `Vous avez ${p.total} élément(s) à traiter`,
      'Retrouvez vos éléments à traiter dans Verebona.',
      undefined, 'notif_to_process_digest',
    ),
    deepLink: () => '/accueil/a-traiter',
    payloadSchema: z.object({ total: z.number(), byFamily: z.record(z.string(), z.number()) }),
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
    deepLink: (p) => (p.inviteToken ? `/mon-compte/partage?inviteToken=${p.inviteToken}` : '/mon-compte/partage'),
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
    deepLink: (p) => `/duos/${p.duoId}/requests?request=${p.requestId}`,
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
    deepLink: (p) => `/duos/${p.duoId}/requests?request=${p.requestId}`,
    payloadSchema: z.object({ requestId: z.number(), duoId: z.number(), assetId: z.number(), assetLabel: z.string(), initiatorName: z.string() }),
  },

  // ── Partage et Duo — résultats configurables ───────────────────────────────
  [T.DUO_MOVE_ACCEPTED]: duoResult(T.DUO_MOVE_ACCEPTED, 'transfert', 'acceptée'),
  [T.DUO_MOVE_REFUSED]: duoResult(T.DUO_MOVE_REFUSED, 'transfert', 'refusée'),
  [T.DUO_DELETE_ACCEPTED]: duoResult(T.DUO_DELETE_ACCEPTED, 'suppression', 'acceptée'),
  [T.DUO_DELETE_REFUSED]: duoResult(T.DUO_DELETE_REFUSED, 'suppression', 'refusée'),

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
    deepLink: (p) => (p.inviteToken ? `/mon-compte/partage?inviteToken=${p.inviteToken}` : '/mon-compte/partage'),
    payloadSchema: z.object({ inviteToken: z.string().optional(), inviterName: z.string().optional(), accountName: z.string().optional() }),
  },

  // ── Transmission ─────────────────────────────────────────────────────────────
  [T.TRANSMISSION_RECEIVED]: {
    type: T.TRANSMISSION_RECEIVED,
    category: 'transmission', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: (p) => content(
      'Transmission reçue',
      `${p.senderName ?? 'Quelqu\'un'} vous a transmis un bien.`,
      { body: 'Vous avez reçu une transmission.' },
      'notif_transmission_received',
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
  [T.TRIAL_ENDING]: accountConfigurable(T.TRIAL_ENDING, 'Votre essai se termine bientôt', 'Votre période d\'essai se termine bientôt.', 'notif_trial_ending'),
  [T.TRIAL_ENDED]: accountConfigurable(T.TRIAL_ENDED, 'Votre essai est terminé', 'Votre période d\'essai est terminée.', 'notif_trial_ended'),
  [T.SUBSCRIPTION_RENEWED]: accountConfigurable(T.SUBSCRIPTION_RENEWED, 'Abonnement renouvelé', 'Votre abonnement a été renouvelé.', 'notif_subscription'),
  [T.SUBSCRIPTION_CHANGED]: accountConfigurable(T.SUBSCRIPTION_CHANGED, 'Offre modifiée', 'Votre offre a été modifiée.', 'notif_subscription'),
  [T.SUBSCRIPTION_CANCELLATION_SCHEDULED]: accountConfigurable(T.SUBSCRIPTION_CANCELLATION_SCHEDULED, 'Résiliation programmée', 'La résiliation de votre abonnement est programmée.', 'notif_subscription'),
  [T.SUBSCRIPTION_CANCELLED]: accountConfigurable(T.SUBSCRIPTION_CANCELLED, 'Abonnement résilié', 'Votre abonnement a été résilié.', 'notif_subscription'),

  [T.ANALYSIS_QUOTA_90]: {
    type: T.ANALYSIS_QUOTA_90,
    category: 'account', priority: 'normal', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: false }, retentionDays: 90, // §6 : email Non à 90 %
    render: () => content(
      'Quota d\'analyses à 90 %',
      'Vous avez utilisé 90 % de votre quota d\'analyses ce mois-ci.',
      { body: 'Vous approchez de votre quota d\'analyses.' },
      'notif_quota',
    ),
    deepLink: () => '/mon-compte/offres',
    payloadSchema: z.object({ accountId: z.number(), threshold: z.literal(90), includedConsumed: z.number(), includedQuota: z.number(), cta: z.string().optional(), planCode: z.string().optional() }),
  },
  [T.ANALYSIS_QUOTA_100]: {
    type: T.ANALYSIS_QUOTA_100,
    category: 'account', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 90, // §6 : email Oui à 100 %
    render: () => content(
      'Quota d\'analyses atteint',
      'Vous avez atteint votre quota d\'analyses ce mois-ci.',
      { body: 'Vous avez atteint votre quota d\'analyses.' },
      'notif_quota',
    ),
    deepLink: () => '/mon-compte/offres',
    payloadSchema: z.object({ accountId: z.number(), threshold: z.literal(100), includedConsumed: z.number(), includedQuota: z.number(), cta: z.string().optional(), planCode: z.string().optional() }),
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

  // ── Compte et abonnement — obligatoires (§2.11) ────────────────────────────
  [T.PAYMENT_FAILED]: accountMandatory(T.PAYMENT_FAILED, 'Incident de paiement', 'Un paiement a échoué. Merci de régulariser votre moyen de paiement.', 'notif_payment_incident'),
  [T.PAYMENT_ACTION_REQUIRED]: accountMandatory(T.PAYMENT_ACTION_REQUIRED, 'Action requise sur votre paiement', 'Une action est requise pour valider votre paiement.', 'notif_payment_incident'),
  [T.SUBSCRIPTION_SUSPENDED]: accountMandatory(T.SUBSCRIPTION_SUSPENDED, 'Abonnement suspendu', 'Votre abonnement est suspendu pour un motif de paiement.', 'notif_payment_incident'),
  [T.ACCOUNT_READ_ONLY]: accountMandatory(T.ACCOUNT_READ_ONLY, 'Compte en lecture seule', 'Votre compte est passé en lecture seule pour un motif de paiement.', 'notif_payment_incident'),

  // ── Sécurité — obligatoires (§7.7) ─────────────────────────────────────────
  [T.PASSWORD_CHANGED]: security(T.PASSWORD_CHANGED, 'Mot de passe modifié', 'Votre mot de passe a été modifié.'),
  [T.EMAIL_CHANGE_REQUESTED]: security(T.EMAIL_CHANGE_REQUESTED, 'Changement d\'email demandé', 'Une modification de votre adresse email a été demandée.'),
  [T.EMAIL_CHANGED]: security(T.EMAIL_CHANGED, 'Email modifié', 'Votre adresse email a été modifiée.'),
  [T.PASSWORD_RESET_COMPLETED]: security(T.PASSWORD_RESET_COMPLETED, 'Mot de passe réinitialisé', 'Votre mot de passe a été réinitialisé.'),
  [T.NEW_DEVICE_LOGIN]: {
    type: T.NEW_DEVICE_LOGIN,
    category: 'security', priority: 'high', deliveryMode: 'immediate',
    // Non obligatoire tant que le registre d'appareils n'existe pas (§7.7).
    mandatoryBell: false, mandatoryEmail: false, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 180,
    render: () => content(
      'Nouvelle connexion',
      'Une connexion depuis un nouvel appareil a été détectée.',
      { body: 'Nouvelle connexion détectée.' },
      'notif_security',
    ),
    deepLink: () => '/mon-compte',
    payloadSchema: z.object({ platform: z.string().optional() }),
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
    deepLink: () => '/mon-compte/partage',
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

function security(type: NotificationType, bellTitle: string, body: string): CatalogEntry {
  return {
    type,
    category: 'security', priority: 'high', deliveryMode: 'immediate',
    mandatoryBell: true, mandatoryEmail: true, neverBell: false,
    defaults: { push: true, email: true }, retentionDays: 365,
    render: () => content(bellTitle, body, { body }, 'notif_security'),
    deepLink: () => '/mon-compte',
    payloadSchema: z.object({}).passthrough(),
  };
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
