/**
 * Canal « push mobile » du dispatcher — lot 97 (CDC 12 §18 PUSH-01..12,
 * §18.3 catalogue minimal, Annexe C règle Duo).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊME RÉGLAGE « PUSH » QUE LE WEB, PAR UTILISATEUR
 *
 * La préférence « Push » de chaque catégorie (Mon compte › Notifications)
 * est portée par l'UTILISATEUR (`notification_preferences.user_id`) : en Duo,
 * A et B règlent chacun la leur et un événement partagé donne une ligne
 * d'outbox PAR destinataire (Annexe C, PUSH-11, DUO-04). Ce canal est servi
 * quand le dispatcher a retenu « push » pour l'événement ; il envoie alors à
 * CHAQUE installation active de ce seul utilisateur (une livraison par
 * appareil, colonne `mobile_push_installation_id`).
 *
 * Garde-fous propres au mobile, dans l'ordre :
 *   1. catalogue §18.3 (`mobilePushPolicy`) : pas de push mobile pour les
 *      actualités (hors V1) ni pour les messages commerciaux (COM-05) ;
 *   2. interrupteur d'urgence `push` (MOBILE_FEATURES_OFF), par plateforme ;
 *   3. fournisseur configuré (FIREBASE_*), sinon `mobile_push_not_configured` ;
 *   4. réémission BO : seuls les appareils en échec sont visés ;
 *   5. récapitulatif quotidien : au plus UN push par utilisateur et par jour
 *      (PUSH-12), même s'il appartient à plusieurs espaces ;
 *   6. déduplication (PUSH-06) : un appareil déjà servi pour cet événement ne
 *      l'est pas une seconde fois (reprise, double traitement) ; la clé de
 *      regroupement envoyée au système remplace en plus la notification
 *      affichée si un doublon passait malgré tout ;
 *   7. jeton refusé par le fournisseur (PUSH-07) : installation nettoyée,
 *      livraison `expired`, les autres appareils ne sont pas touchés.
 *
 * Contenu (PUSH-05) : titre et texte génériques du catalogue (déjà sans
 * donnée patrimoniale, §4.3), plafonnés ; données = lien HTTPS de l'écran
 * cible (lien universel, PUSH-04), catégorie, type, identifiant de cloche.
 * Aucun jeton, aucune adresse, aucun montant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { getAppBaseUrl } from '@/lib/app-url';
import { withSpaceParam } from '@/lib/shell/space-link';
import { isMobileFeatureEnabled } from '@/lib/mobile/mobile-config';
import { getMobilePushProvider } from '@/lib/mobile/push-provider';
import {
  activeInstallationsForUser, markInstallationFailure, markInstallationInvalid, markInstallationSent,
} from '@/lib/mobile/push-installations';
import type { CatalogEntry, NotificationCategory } from './catalog';
import type { DeliveryContext, DeliveryOutcome } from './channels';
import type { RenderResult } from './content-renderer';

export type MobilePushRule = 'yes' | 'optional' | 'no';

/**
 * Catalogue §18.3 par catégorie. « optional » = envoyé si l'utilisateur l'a
 * demandé (préférence), comme « yes » ; la différence est documentaire.
 */
const CATEGORY_RULES: Readonly<Record<NotificationCategory, MobilePushRule>> = {
  deadlines: 'yes',      // Échéance / rappel
  to_process: 'yes',     // Action nécessitant traitement (+ récapitulatif)
  duo: 'yes',            // Invitation Duo, demandes du Duo
  transmission: 'yes',   // Transmission reçue : action attendue
  documents: 'yes',      // Erreur de traitement nécessitant action ; terminé = optionnel (ci-dessous)
  security: 'no',        // Lot 101B : information de sécurité par e-mail obligatoire seul (push supprimé au catalogue)
  account: 'no',         // Abonnement, paiement, offres : jamais de push commercial dans l'app (COM-05)
  news: 'no',            // Marketing / promotions : hors V1
};

/** Exceptions par type (décision PO possible : un point à changer). */
const TYPE_RULES: Readonly<Partial<Record<string, MobilePushRule>>> = {
  DOCUMENT_BATCH_COMPLETED: 'optional',
  DOCUMENT_UPLOAD_COMPLETED: 'optional',
  GDPR_EXPORT_READY: 'optional',          // « Fin d'export long »
  ACCOUNT_DELETION_SCHEDULED: 'yes',      // sécurité du compte
  ACCOUNT_DELETION_REMINDER: 'yes',
};

export function mobilePushPolicy(entry: Pick<CatalogEntry, 'type' | 'category'>): MobilePushRule {
  return TYPE_RULES[entry.type] ?? CATEGORY_RULES[entry.category] ?? 'no';
}

/** Codes des livraisons ignorées (journal `notification_deliveries.last_error_code`). */
export const MOBILE_PUSH_CODES = {
  notInCatalog: 'mobile_push_not_in_catalog',
  disabled: 'mobile_push_disabled',
  notConfigured: 'mobile_push_not_configured',
  duplicate: 'mobile_push_duplicate_suppressed',
  digestAlreadyPushed: 'digest_already_pushed_today',
  tokenUnreadable: 'token_unreadable',
} as const;

export interface MobilePushDelivery {
  /** Installation visée (null : décision prise pour l'événement entier). */
  installationRowId: string | null;
  outcome: DeliveryOutcome;
}

/** Clé de regroupement : stable pour un événement, réémissions comprises, sans donnée lisible. */
export function mobileCollapseKey(dedupeKey: string): string {
  const base = dedupeKey.replace(/:reemis:\d+$/, '');
  return createHash('sha256').update(base).digest('hex').slice(0, 32);
}

/** Lien HTTPS absolu de l'écran cible (lien universel), ou null. */
export function mobileDeepLink(href: string | null | undefined, accountId: number | null): string | null {
  const chemin = withSpaceParam(href ?? null, accountId);
  if (!chemin || !chemin.startsWith('/') || chemin.startsWith('//')) return null;
  return `${getAppBaseUrl().replace(/\/+$/, '')}${chemin}`;
}

async function alreadySent(outboxId: string): Promise<Set<string>> {
  const rows = await pgClient<{ id: string }[]>`
    SELECT DISTINCT mobile_push_installation_id::text AS id FROM notification_deliveries
     WHERE outbox_id = ${outboxId}::uuid AND channel = 'push' AND status = 'sent' AND mobile_push_installation_id IS NOT NULL`;
  return new Set(rows.map((r) => r.id));
}

async function digestAlreadyPushedToday(userId: number, outboxId: string): Promise<boolean> {
  const [r] = await pgClient<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM notification_deliveries d JOIN notification_outbox o ON o.id = d.outbox_id
     WHERE d.user_id = ${userId} AND d.channel = 'push' AND d.status = 'sent' AND d.mobile_push_installation_id IS NOT NULL
       AND o.event_type = 'TO_PROCESS_DAILY_DIGEST' AND d.outbox_id <> ${outboxId}::uuid
       AND d.sent_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris')`;
  return Number(r?.n ?? 0) > 0;
}

/**
 * Livre l'événement aux appareils mobiles de l'utilisateur. Rend une ligne
 * par appareil (ou une seule si l'événement entier est écarté) ; tableau
 * vide si l'utilisateur n'a aucun appareil mobile actif.
 */
export async function deliverMobilePush(
  ctx: DeliveryContext & { mobileInstallationIds?: string[] },
  entry: CatalogEntry,
  rendered: RenderResult,
  notificationId?: number,
): Promise<MobilePushDelivery[]> {
  let installations;
  try {
    installations = await activeInstallationsForUser(ctx.userId);
  } catch (e) {
    // Table absente (migration 0814 ou 0802 pas encore passée) : les
    // autres canaux continuent, sans bruit.
    if ((e as { code?: string }).code === '42P01') return [];
    throw e;
  }
  if (ctx.mobileInstallationIds) {
    const cibles = new Set(ctx.mobileInstallationIds);
    installations = installations.filter((i) => cibles.has(i.id));
  }
  if (installations.length === 0) return [];

  const skipAll = (code: string): MobilePushDelivery[] =>
    installations.map((i) => ({ installationRowId: i.id, outcome: { status: 'skipped_unavailable', errorCode: code } }));

  if (mobilePushPolicy(entry) === 'no') return skipAll(MOBILE_PUSH_CODES.notInCatalog);
  const provider = getMobilePushProvider();
  if (!provider) return skipAll(MOBILE_PUSH_CODES.notConfigured);
  if (ctx.eventType === 'TO_PROCESS_DAILY_DIGEST' && await digestAlreadyPushedToday(ctx.userId, ctx.outboxId)) {
    return skipAll(MOBILE_PUSH_CODES.digestAlreadyPushed);
  }

  const dejaServis = await alreadySent(ctx.outboxId);
  const href = mobileDeepLink(rendered.href, ctx.accountId ?? null);
  const collapseKey = mobileCollapseKey(ctx.dedupeKey);
  const data: Record<string, string> = {
    type: ctx.eventType,
    category: String(ctx.category ?? entry.category),
    ...(href ? { href } : {}),
    ...(notificationId ? { notificationId: String(notificationId) } : {}),
  };

  const out: MobilePushDelivery[] = [];
  for (const inst of installations) {
    if (!isMobileFeatureEnabled('push', inst.platform)) {
      out.push({ installationRowId: inst.id, outcome: { status: 'skipped_unavailable', errorCode: MOBILE_PUSH_CODES.disabled } });
      continue;
    }
    if (dejaServis.has(inst.id)) {
      out.push({ installationRowId: inst.id, outcome: { status: 'skipped_unavailable', errorCode: MOBILE_PUSH_CODES.duplicate } });
      continue;
    }
    if (!inst.token) {
      await markInstallationInvalid(inst.id, MOBILE_PUSH_CODES.tokenUnreadable);
      out.push({ installationRowId: inst.id, outcome: { status: 'expired', errorCode: MOBILE_PUSH_CODES.tokenUnreadable } });
      continue;
    }
    const res = await provider.send({
      token: inst.token,
      platform: inst.platform,
      title: rendered.pushTitle.slice(0, 120),
      body: rendered.pushBody.slice(0, 180),
      data,
      collapseKey,
      priority: entry.priority === 'high' ? 'high' : 'normal',
    }).catch((e: unknown) => ({ ok: false as const, kind: 'transient' as const, code: ((e as Error)?.message ?? 'send_error').slice(0, 60) }));
    if (res.ok) {
      await markInstallationSent(inst.id);
      out.push({ installationRowId: inst.id, outcome: { status: 'sent', ...(res.messageId ? { providerMessageId: res.messageId } : {}) } });
    } else if (res.kind === 'invalid_token') {
      await markInstallationInvalid(inst.id, res.code);
      out.push({ installationRowId: inst.id, outcome: { status: 'expired', errorCode: `invalid_token:${res.code}` } });
    } else {
      await markInstallationFailure(inst.id, res.code);
      out.push({ installationRowId: inst.id, outcome: { status: 'failed', errorCode: `mobile_push_${res.kind}`, errorMessage: res.code } });
    }
  }
  return out;
}
