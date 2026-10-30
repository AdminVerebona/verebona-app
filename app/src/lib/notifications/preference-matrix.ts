/**
 * Matrice de préférences de notification (CDC §6 / §8.2 / §13.1).
 *
 * Le réglage utilisateur est au niveau CATÉGORIE (un switch push + un switch
 * email par catégorie, cf. §8.2). Les valeurs par défaut fines par événement
 * restent portées par le catalogue et appliquées par le PolicyResolver tant
 * qu'aucune ligne de préférence n'existe. Dès qu'un utilisateur modifie le
 * switch d'une catégorie, ce choix s'applique à tous les événements
 * FACULTATIFS de la catégorie.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 79C — INDISPENSABLES ET FACULTATIFS SÉPARÉS
 *
 * Avant : une catégorie contenant un seul e-mail obligatoire (Duo, Compte et
 * abonnement, Sécurité) avait TOUT son switch e-mail coché et verrouillé — les
 * e-mails facultatifs de la catégorie (résultats Duo, fin d'essai, nouvel
 * appareil…) étaient imposés sans raison.
 *
 * Désormais, le switch e-mail ne porte que sur les e-mails FACULTATIFS de la
 * catégorie ; les e-mails indispensables (`mandatoryEmail`) sont listés à
 * part (« Toujours envoyés ») et partent quel que soit le switch — c'est
 * exactement la règle du moteur (`policy-resolver.ts`). Un canal sans aucun
 * événement facultatif réel (supprimé au lot 79C, sans gabarit) n'est plus
 * proposé (`available: false`). Le switch n'est verrouillé que si TOUS les
 * e-mails de la catégorie sont indispensables.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { db } from '@/db';
import { notificationPreferences } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  NOTIFICATION_CATALOG, CATEGORY_LABELS, CONFIGURABLE_CATEGORIES,
  type CatalogEntry, type NotificationCategory, type DeliveryMode,
} from './catalog';
import { isChannelRetired } from './retired-channels';
import { getMobilePushProvider } from '@/lib/mobile/push-provider';
import { countActiveInstallations } from '@/lib/mobile/push-installations';
import { getNewsConsent } from './news-consent';

type ConfigurableChannel = 'push' | 'email';

interface CategoryUi {
  description: string;
  /** Valeur affichée par le switch tant qu'aucune préférence n'est enregistrée. */
  displayDefault: { push: boolean; email: boolean };
  /** « À traiter » expose en plus un récapitulatif quotidien. */
  hasDigest?: boolean;
  digestDisplayDefault?: { push: boolean; email: boolean };
}

const CATEGORY_UI: Record<NotificationCategory, CategoryUi> = {
  deadlines: {
    description: 'Rappel 7 jours avant une échéance de votre agenda.',
    displayDefault: { push: true, email: true },
  },
  documents: {
    // Lot 79C : plus d'e-mail sur les documents (ajout, fin et échec
    // d'analyse) ; la confirmation d'ajout reste dans l'application.
    description: 'Fin d\'analyse de vos documents importés, réussie ou non. La confirmation d\'ajout reste visible dans l\'application.',
    displayDefault: { push: true, email: false },
  },
  to_process: {
    description: 'Récapitulatif facultatif des éléments à traiter. Jamais ajouté dans la cloche : vos éléments restent visibles sur la page À traiter.',
    displayDefault: { push: false, email: false },
    hasDigest: true,
    // Lot 79C : récapitulatif désactivé par défaut (activation volontaire).
    digestDisplayDefault: { push: false, email: false },
  },
  duo: {
    description: 'Invitations, demandes et réponses de votre compte partagé.',
    displayDefault: { push: true, email: true },
  },
  transmission: {
    description: 'Biens transmis, acceptés ou refusés.',
    displayDefault: { push: true, email: true },
  },
  account: {
    description: 'Essai, abonnement, paiement et données de votre compte.',
    displayDefault: { push: true, email: true },
  },
  security: {
    // Lot 101B : e-mail obligatoire seul — ni cloche, ni push (supprimés au
    // catalogue : le réglage push n'est plus proposé pour cette catégorie).
    description: 'Connexions et modifications de vos identifiants. Toujours envoyés par e-mail, sans notification dans l\'application.',
    displayDefault: { push: false, email: true },
  },
  news: {
    description: 'Nouveautés et conseils Verebona. Nécessite votre consentement.',
    displayDefault: { push: false, email: false },
  },
};

/**
 * Libellés utilisateur des événements qui peuvent partir par e-mail (lot 79C) :
 * ce que couvre le switch, ce qui part toujours. Un test vérifie que tout
 * événement à e-mail du catalogue y figure.
 */
export const EMAIL_EVENT_USER_LABELS: Partial<Record<string, string>> = {
  DEADLINE_DUE_IN_7_DAYS: 'rappel 7 jours avant une échéance',
  TO_PROCESS_DAILY_DIGEST: 'récapitulatif quotidien',
  DUO_INVITATION_RECEIVED: 'invitation Duo reçue',
  ACCOUNT_INVITATION: 'invitation à rejoindre un compte',
  DUO_MOVE_REQUEST: 'demande de transfert à décider',
  DUO_DELETE_REQUEST: 'demande de suppression à décider',
  DUO_MOVE_ACCEPTED: 'réponses à vos demandes de transfert ou de suppression',
  DUO_MOVE_REFUSED: 'réponses à vos demandes de transfert ou de suppression',
  DUO_DELETE_ACCEPTED: 'réponses à vos demandes de transfert ou de suppression',
  DUO_DELETE_REFUSED: 'réponses à vos demandes de transfert ou de suppression',
  TRANSMISSION_ACCEPTED: 'transmission acceptée',
  TRANSMISSION_REFUSED: 'transmission refusée',
  TRANSMISSION_EXPIRED: 'transmission expirée',
  TRIAL_ENDING: 'fin d’essai proche',
  TRIAL_ENDED: 'fin d’essai',
  SUBSCRIPTION_RENEWED: 'renouvellement (sauf si le reçu de paiement le couvre)',
  SUBSCRIPTION_ACTIVATED: 'activation ou changement d’offre',
  SUBSCRIPTION_CHANGED: 'activation ou changement d’offre',
  SUBSCRIPTION_CHANGE_SCHEDULED: 'changement d’offre programmé',
  SUBSCRIPTION_CANCELLATION_SCHEDULED: 'résiliation programmée',
  SUBSCRIPTION_CANCELLED: 'résiliation',
  REFERRAL_REWARD_GRANTED: 'récompense de parrainage',
  GDPR_EXPORT_READY: 'export de vos données prêt',
  PAYMENT_FAILED: 'incident de paiement',
  PAYMENT_ACTION_REQUIRED: 'action requise sur un paiement',
  SUBSCRIPTION_SUSPENDED: 'abonnement suspendu',
  ACCOUNT_READ_ONLY: 'rappels avant suppression pour impayé',
  ACCOUNT_DELETION_SCHEDULED: 'suppression de votre compte programmée',
  ACCOUNT_DELETION_REMINDER: 'rappel avant suppression de votre compte',
  PASSWORD_CHANGED: 'mot de passe modifié',
  EMAIL_CHANGE_REQUESTED: 'changement d’adresse e-mail demandé',
  EMAIL_CHANGED: 'adresse e-mail modifiée',
  PASSWORD_RESET_COMPLETED: 'mot de passe réinitialisé',
  NEW_DEVICE_LOGIN: 'connexion depuis un nouvel appareil',
  OTHER_SESSIONS_REVOKED: 'autres appareils déconnectés à votre demande',
  AUTH_IDENTITY_LINKED: 'Google ou Apple associé',
  AUTH_IDENTITY_UNLINKED: 'Google ou Apple dissocié',
  NEWS_ANNOUNCEMENT: 'actualités',
};

/** Gabarit e-mail d'une entrée (rendu à vide ; un rendu qui lève est réputé avoir un e-mail). */
function hasEmailTemplate(entry: CatalogEntry): boolean {
  try {
    return !!entry.render({})?.emailTemplateCode;
  } catch {
    return true;
  }
}

/** L'événement peut-il partir par e-mail aujourd'hui (gabarit, canal non supprimé) ? */
export function eventEmailExists(entry: CatalogEntry): boolean {
  return hasEmailTemplate(entry) && !isChannelRetired(entry, 'email');
}

function entriesOf(category: NotificationCategory, mode: DeliveryMode): CatalogEntry[] {
  return Object.values(NOTIFICATION_CATALOG).filter(
    (e): e is CatalogEntry => !!e && e.category === category && e.deliveryMode === mode,
  );
}

const uniq = (xs: string[]) => [...new Set(xs)];

interface CategoryEmailScope {
  /** E-mails toujours envoyés (indispensables), quel que soit le switch. */
  essential: string[];
  /** E-mails que le switch active ou coupe. */
  optional: string[];
}

/** Portée réelle du switch e-mail d'une catégorie et d'un mode (pure). */
export function categoryEmailScope(category: NotificationCategory, mode: DeliveryMode = 'immediate'): CategoryEmailScope {
  const withEmail = entriesOf(category, mode).filter(eventEmailExists);
  const label = (e: CatalogEntry) => EMAIL_EVENT_USER_LABELS[e.type] ?? e.type;
  return {
    essential: uniq(withEmail.filter((e) => e.mandatoryEmail).map(label)),
    optional: uniq(withEmail.filter((e) => !e.mandatoryEmail).map(label)),
  };
}

/** Le push est-il réellement possible pour au moins un événement de la catégorie et du mode ? */
export function categoryPushAvailable(category: NotificationCategory, mode: DeliveryMode = 'immediate'): boolean {
  return entriesOf(category, mode).some((e) => !isChannelRetired(e, 'push'));
}

/**
 * Le switch e-mail est verrouillé seulement si TOUS les e-mails de la catégorie
 * sont indispensables (aucun facultatif à couper). Lot 79C : un seul e-mail
 * obligatoire ne verrouille plus la catégorie.
 */
function isEmailLocked(category: NotificationCategory, mode: DeliveryMode = 'immediate'): boolean {
  const scope = categoryEmailScope(category, mode);
  return scope.essential.length > 0 && scope.optional.length === 0;
}

interface ChannelState {
  enabled: boolean;
  locked: boolean;
  /** Lot 79C : faux si le canal n'existe plus pour ce réglage (non proposé). */
  available: boolean;
}
interface CategoryPreference {
  key: NotificationCategory;
  label: string;
  description: string;
  immediate: { push: ChannelState; email: ChannelState };
  digest?: { push: ChannelState; email: ChannelState };
  /** Lot 79C : ce que contrôle le switch e-mail, et ce qui part toujours. */
  emailScope: CategoryEmailScope;
}
interface PreferenceMatrix {
  categories: CategoryPreference[];
  /**
   * Lot 97 puis lot 94 (décision PO M3 : aucun Web Push) : le push ne part
   * QUE vers les téléphones de l'application mobile. `activeDeviceCount` =
   * `mobileDeviceCount`. `supported` : fournisseur push mobile configuré.
   */
  push: { supported: boolean; activeDeviceCount: number; mobileDeviceCount: number };
  newsConsent: { consented: boolean; consentedAt: string | null };
}

type PrefRow = { category: string; deliveryMode: string; channel: string; enabled: boolean };

function resolve(
  rows: PrefRow[], category: NotificationCategory, mode: DeliveryMode,
  channel: ConfigurableChannel, fallback: boolean, locked: boolean, available = true,
): ChannelState {
  // Canal supprimé : affiché désactivé, jamais proposé (lot 79C).
  if (!available) return { enabled: false, locked: false, available: false };
  if (locked) return { enabled: true, locked: true, available: true };
  const row = rows.find((r) => r.category === category && r.deliveryMode === mode && r.channel === channel);
  return { enabled: row ? row.enabled : fallback, locked: false, available: true };
}

function emailAvailable(category: NotificationCategory, mode: DeliveryMode): boolean {
  const scope = categoryEmailScope(category, mode);
  return scope.optional.length > 0 || scope.essential.length > 0;
}

/** Construit la matrice complète fusionnée (défauts + préférences + verrous). */
export async function buildPreferenceMatrix(userId: number): Promise<PreferenceMatrix> {
  const rows = await db
    .select({
      category: notificationPreferences.category,
      deliveryMode: notificationPreferences.deliveryMode,
      channel: notificationPreferences.channel,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  const mobileDevices = await countActiveInstallations(userId);

  const categories: CategoryPreference[] = CONFIGURABLE_CATEGORIES.map((key) => {
    const ui = CATEGORY_UI[key];
    const news = key === 'news';
    const entry: CategoryPreference = {
      key,
      label: CATEGORY_LABELS[key],
      description: ui.description,
      immediate: {
        push: resolve(rows, key, 'immediate', 'push', ui.displayDefault.push, false, news || categoryPushAvailable(key, 'immediate')),
        email: resolve(rows, key, 'immediate', 'email', ui.displayDefault.email, isEmailLocked(key, 'immediate'), news || emailAvailable(key, 'immediate')),
      },
      emailScope: categoryEmailScope(key, ui.hasDigest ? 'daily_digest' : 'immediate'),
    };
    if (ui.hasDigest && ui.digestDisplayDefault) {
      entry.digest = {
        push: resolve(rows, key, 'daily_digest', 'push', ui.digestDisplayDefault.push, false, categoryPushAvailable(key, 'daily_digest')),
        email: resolve(rows, key, 'daily_digest', 'email', ui.digestDisplayDefault.email, isEmailLocked(key, 'daily_digest'), emailAvailable(key, 'daily_digest')),
      };
    }
    return entry;
  });

  const consent = await getNewsConsent(userId);

  return {
    categories,
    push: {
      supported: !!getMobilePushProvider(),
      activeDeviceCount: mobileDevices,
      mobileDeviceCount: mobileDevices,
    },
    newsConsent: { consented: consent.consented, consentedAt: consent.consentedAt },
  };
}

export interface PreferenceChange {
  category: string;
  channel: string;
  deliveryMode?: string;
  enabled: boolean;
}
interface ApplyResult { ok: boolean; error?: string }

/** Applique des modifications atomiques, avec contrôles (§13.1). */
export async function applyPreferenceChanges(userId: number, changes: PreferenceChange[]): Promise<ApplyResult> {
  if (!Array.isArray(changes) || changes.length === 0) return { ok: false, error: 'NO_CHANGES' };

  for (const c of changes) {
    const category = c.category as NotificationCategory;
    const mode = (c.deliveryMode ?? 'immediate') as DeliveryMode;

    if (!CONFIGURABLE_CATEGORIES.includes(category)) return { ok: false, error: `INVALID_CATEGORY:${c.category}` };
    if (c.channel !== 'push' && c.channel !== 'email') return { ok: false, error: `INVALID_CHANNEL:${c.channel}` };
    if (mode !== 'immediate' && mode !== 'daily_digest') return { ok: false, error: `INVALID_MODE:${mode}` };
    // Refus explicite de désactiver un email obligatoire (§13.1) — seulement
    // si la catégorie n'a AUCUN e-mail facultatif (lot 79C).
    if (c.channel === 'email' && c.enabled === false && category !== 'news' && isEmailLocked(category, mode)) {
      return { ok: false, error: `EMAIL_MANDATORY:${c.category}` };
    }
    // Lot 79C : un canal supprimé n'est plus proposé — on n'enregistre pas
    // une activation qui ne produirait rien.
    if (c.enabled === true && category !== 'news') {
      const available = c.channel === 'push' ? categoryPushAvailable(category, mode) : emailAvailable(category, mode);
      if (!available) return { ok: false, error: `CHANNEL_RETIRED:${c.category}:${c.channel}` };
    }
  }

  const now = new Date();
  for (const c of changes) {
    const mode = c.deliveryMode ?? 'immediate';
    // Préférence strictement au niveau user_id → isolation entre membres Duo (§8.3).
    await db.insert(notificationPreferences).values({
      userId, category: c.category, deliveryMode: mode, channel: c.channel, enabled: c.enabled,
    }).onConflictDoUpdate({
      target: [
        notificationPreferences.userId, notificationPreferences.category,
        notificationPreferences.deliveryMode, notificationPreferences.channel,
      ],
      set: { enabled: c.enabled, updatedAt: now },
    });
  }

  return { ok: true };
}
