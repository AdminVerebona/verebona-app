/**
 * Matrice de préférences de notification (CDC §6 / §8.2 / §13.1).
 *
 * Le réglage utilisateur est au niveau CATÉGORIE (un switch push + un switch
 * email par catégorie, cf. §8.2). Les valeurs par défaut fines par événement
 * restent portées par le catalogue et appliquées par le PolicyResolver tant
 * qu'aucune ligne de préférence n'existe. Dès qu'un utilisateur modifie le
 * switch d'une catégorie, ce choix s'applique à tous les événements de la
 * catégorie.
 *
 * Verrou email obligatoire (§2.11) : une catégorie qui contient au moins un
 * événement à email obligatoire (Duo, Compte et abonnement, Sécurité) a son
 * switch email coché et verrouillé — l'état verrouillé est explicite AVANT
 * interaction (§8.2), jamais une erreur après clic.
 */

import { db } from '@/db';
import { notificationPreferences, pushSubscriptions } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  NOTIFICATION_CATALOG, CATEGORY_LABELS, CONFIGURABLE_CATEGORIES,
  type NotificationCategory, type DeliveryMode,
} from './catalog';
import { getVapidPublicKey } from './web-push-sender';
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
    description: 'Fin d\'analyse de vos documents importés.',
    displayDefault: { push: true, email: false },
  },
  to_process: {
    description: 'Éléments à traiter dans Verebona. Jamais ajoutés dans la cloche : ils restent visibles sur la page À traiter.',
    displayDefault: { push: false, email: false },
    hasDigest: true,
    digestDisplayDefault: { push: false, email: true },
  },
  duo: {
    description: 'Invitations et demandes de votre compte partagé.',
    displayDefault: { push: true, email: true },
  },
  transmission: {
    description: 'Biens transmis, acceptés ou refusés.',
    displayDefault: { push: true, email: true },
  },
  account: {
    description: 'Essai, abonnement, quota et paiement.',
    displayDefault: { push: true, email: true },
  },
  security: {
    description: 'Connexions et modifications de vos identifiants.',
    displayDefault: { push: true, email: true },
  },
  news: {
    description: 'Nouveautés et conseils Verebona. Nécessite votre consentement.',
    displayDefault: { push: false, email: false },
  },
};

/** Une catégorie a l'email verrouillé si un de ses événements est à email obligatoire. */
function isEmailLocked(category: NotificationCategory): boolean {
  return Object.values(NOTIFICATION_CATALOG).some(
    (e) => e && e.category === category && e.mandatoryEmail,
  );
}

export interface ChannelState { enabled: boolean; locked: boolean }
export interface CategoryPreference {
  key: NotificationCategory;
  label: string;
  description: string;
  immediate: { push: ChannelState; email: ChannelState };
  digest?: { push: ChannelState; email: ChannelState };
}
export interface PreferenceMatrix {
  categories: CategoryPreference[];
  push: { supported: boolean; activeDeviceCount: number };
  newsConsent: { consented: boolean; consentedAt: string | null };
}

type PrefRow = { category: string; deliveryMode: string; channel: string; enabled: boolean };

function resolve(
  rows: PrefRow[], category: NotificationCategory, mode: DeliveryMode,
  channel: ConfigurableChannel, fallback: boolean, locked: boolean,
): ChannelState {
  if (locked) return { enabled: true, locked: true };
  const row = rows.find((r) => r.category === category && r.deliveryMode === mode && r.channel === channel);
  return { enabled: row ? row.enabled : fallback, locked: false };
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

  const activeDevices = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.status, 'active')));

  const categories: CategoryPreference[] = CONFIGURABLE_CATEGORIES.map((key) => {
    const ui = CATEGORY_UI[key];
    const emailLocked = isEmailLocked(key);
    const entry: CategoryPreference = {
      key,
      label: CATEGORY_LABELS[key],
      description: ui.description,
      immediate: {
        push: resolve(rows, key, 'immediate', 'push', ui.displayDefault.push, false),
        email: resolve(rows, key, 'immediate', 'email', ui.displayDefault.email, emailLocked),
      },
    };
    if (ui.hasDigest && ui.digestDisplayDefault) {
      entry.digest = {
        push: resolve(rows, key, 'daily_digest', 'push', ui.digestDisplayDefault.push, false),
        email: resolve(rows, key, 'daily_digest', 'email', ui.digestDisplayDefault.email, emailLocked),
      };
    }
    return entry;
  });

  const consent = await getNewsConsent(userId);

  return {
    categories,
    push: { supported: !!getVapidPublicKey(), activeDeviceCount: activeDevices.length },
    newsConsent: { consented: consent.consented, consentedAt: consent.consentedAt },
  };
}

export interface PreferenceChange {
  category: string;
  channel: string;
  deliveryMode?: string;
  enabled: boolean;
}
export interface ApplyResult { ok: boolean; error?: string }

/** Applique des modifications atomiques, avec contrôles (§13.1). */
export async function applyPreferenceChanges(userId: number, changes: PreferenceChange[]): Promise<ApplyResult> {
  if (!Array.isArray(changes) || changes.length === 0) return { ok: false, error: 'NO_CHANGES' };

  for (const c of changes) {
    const category = c.category as NotificationCategory;
    const mode = (c.deliveryMode ?? 'immediate') as DeliveryMode;

    if (!CONFIGURABLE_CATEGORIES.includes(category)) return { ok: false, error: `INVALID_CATEGORY:${c.category}` };
    if (c.channel !== 'push' && c.channel !== 'email') return { ok: false, error: `INVALID_CHANNEL:${c.channel}` };
    if (mode !== 'immediate' && mode !== 'daily_digest') return { ok: false, error: `INVALID_MODE:${mode}` };
    // Refus explicite de désactiver un email obligatoire (§13.1).
    if (c.channel === 'email' && c.enabled === false && isEmailLocked(category)) {
      return { ok: false, error: `EMAIL_MANDATORY:${c.category}` };
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
