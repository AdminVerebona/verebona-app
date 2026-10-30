/**
 * NotificationDispatcher (CDC §11.1 / §11.3 / §18).
 *
 * Réclame les événements dus dans l'outbox, résout les canaux (préférences +
 * obligatoire), rend le contenu, crée une livraison par canal (et par appareil
 * pour le push) puis envoie. Journalise chaque tentative dans
 * `notification_deliveries` et agrège le statut de l'outbox (lot 81E) :
 *   - au moins un canal ENVOYÉ (accepté par le canal), aucun échec → `sent` ;
 *   - au moins un canal envoyé et au moins un en échec → `partial` ;
 *   - au moins un canal en échec, aucun envoyé → `failed` ;
 *   - aucun canal envoyé, sans échec (supprimé, désactivé, sans destinataire,
 *     sans appareil, préférences) → `skipped`, cause dans `outcome_reason` —
 *     jamais compté « envoyé » (auparavant : `sent`) ;
 *   - incident déjà porté par un autre événement → `grouped`
 *     (`grouped_with_id`) ; si ce porteur n'est finalement envoyé par aucun
 *     canal, les événements regroupés sont remis en file.
 *
 * Le traitement d'un événement en échec n'interrompt pas les autres (§13.4).
 */

import { db } from '@/db';
import { notificationDeliveries } from '@/db/schema';
import { getCatalogEntry, isContentNotificationCategory, ACCOUNT_INELIGIBLE_SKIP_REASON } from './catalog';
import { renderContent } from './content-renderer';
import { resolveChannels } from './policy-resolver';
import { applyChannelActivation, loadDisabledChannels, CHANNEL_DISABLED_ERROR_CODE } from './channel-activation';
import { deliverBell, deliverEmail, type DeliveryOutcome, type DeliveryContext } from './channels';
import { lireRestrictionReemission, appliquerRestrictionReemission } from './reemission-restriction';
import { claimByIds, claimPending, markGrouped, markProcessed, releaseOrFail, reopenGroupedBy, type OutboxRow } from './outbox';
import { applyRetiredChannels, CHANNEL_RETIRED_ERROR_CODE } from './retired-channels';
import { resolveIncidentGrouping, GROUPED_INCIDENT_ERROR_CODE } from './incident-grouping';
import { deliverMobilePush } from './mobile-push';

/** Lot 100G : e-mail de l'événement envoyé par la séquence de fin d'essai (cause tracée). */
export const EMAIL_DELIVERED_ELSEWHERE_ERROR_CODE = 'email_sent_by_trial_sequence';

export interface DispatchSummary {
  claimed: number;
  sent: number;
  partial: number;
  failed: number;
  skipped: number;
}

async function recordDelivery(
  outboxId: string, userId: number, channel: 'bell' | 'push' | 'email', outcome: DeliveryOutcome,
  mobilePushInstallationId?: string | null,
): Promise<void> {
  const now = new Date();
  const terminal = outcome.status === 'sent';
  await db.insert(notificationDeliveries).values({
    outboxId,
    userId,
    channel,
    // Lot 97 : appareil mobile natif (une livraison par appareil).
    ...(mobilePushInstallationId ? { mobilePushInstallationId } : {}),
    status: outcome.status,
    providerMessageId: outcome.providerMessageId ?? null,
    lastErrorCode: outcome.errorCode ?? null,
    lastErrorMessage: outcome.errorMessage ? outcome.errorMessage.slice(0, 500) : null,
    attemptCount: 1,
    attemptedAt: now,
    sentAt: terminal ? now : null,
    createdAt: now,
  });
}

async function processRow(row: OutboxRow): Promise<'sent' | 'partial' | 'failed' | 'skipped'> {
  const entry = getCatalogEntry(row.event_type);
  if (!entry) {
    // Type hors catalogue : ne devrait pas arriver (emit valide). On échoue proprement.
    await releaseOrFail(row.id, row.attempt_count ?? 0, `unknown_event_type:${row.event_type}`);
    return 'failed';
  }

  // Lot 82A (C-Q10, §3.3) : notification de CONTENU d'un compte devenu non
  // éligible (fin d'essai, suspension, lecture seule) depuis sa mise en file —
  // ignorée, cause tracée, jamais un incident. Lecture impossible : l'erreur
  // remonte (reprise normale), rien n'est envoyé à l'aveugle.
  if (row.account_id != null && isContentNotificationCategory(entry.category)) {
    const { checkAccountProcessingEligibility } = await import('@/services/account/processing-eligibility');
    const e = await checkAccountProcessingEligibility(Number(row.account_id), { maxAgeMs: 5_000 });
    if (!e.eligible) {
      await markProcessed(row.id, 'skipped', { reason: `${ACCOUNT_INELIGIBLE_SKIP_REASON}:${e.reason ?? 'READ_ONLY'}` });
      await afterProcessed(row, 'skipped');
      return 'skipped';
    }
  }

  // Réémission (§20.3) : seuls les canaux en échec de la ligne d'origine sont
  // servis — une cloche, même obligatoire, déjà livrée ne l'est pas deux fois.
  // La clé technique est retirée avant le rendu.
  const { payload: payloadBrut, restriction } = lireRestrictionReemission(row.payload_json ?? {});
  const restricted = appliquerRestrictionReemission(await resolveChannels(row.recipient_user_id, entry), restriction);

  // Lot 79C : un incident déjà porté par une autre ligne (même facture, même
  // lot / document) n'est pas envoyé une seconde fois — file existante,
  // reprise et réémission comprises.
  const grouping = await resolveIncidentGrouping(row as never, payloadBrut);
  if (grouping.absorbedBy) {
    for (const channel of (['bell', 'email', 'push'] as const).filter((c) => restricted[c])) {
      await recordDelivery(row.id, row.recipient_user_id, channel, {
        status: 'skipped_unavailable', errorCode: GROUPED_INCIDENT_ERROR_CODE, errorMessage: `regroupé avec ${grouping.absorbedBy}`,
      });
    }
    await markGrouped(row.id, grouping.absorbedBy);
    return 'skipped';
  }
  // Lot 81E : incident sans objet au moment de l'envoi (facture réglée ou
  // annulée entre-temps) — ignoré, cause tracée, jamais une anomalie.
  if (grouping.skipReason) {
    for (const channel of (['bell', 'email', 'push'] as const).filter((c) => restricted[c])) {
      await recordDelivery(row.id, row.recipient_user_id, channel, { status: 'skipped_unavailable', errorCode: grouping.skipReason });
    }
    await markProcessed(row.id, 'skipped', { reason: grouping.skipReason });
    await afterProcessed(row, 'skipped');
    return 'skipped';
  }
  const payload = grouping.payloadPatch ? { ...payloadBrut, ...grouping.payloadPatch } : payloadBrut;

  // Lot 79C : canaux SUPPRIMÉS — coupés quelles que soient les anciennes
  // préférences, la file, la reprise ou la réémission (`retired-channels.ts`).
  // Lot 101B : y compris la CLOCHE des informations de sécurité, même pour une
  // ligne mise en file avant le déploiement avec `mandatory_bell` (aucune
  // ligne `notifications`, donc aucun toast) ; l'e-mail obligatoire part.
  const { channels: resolved, retired } = applyRetiredChannels(restricted, entry);
  const rendered = renderContent(entry, payload, row.deep_link);

  // CDC BO COM-011 / REC-MOD-01 : un canal désactivé depuis le BO n'est pas
  // livré ; les autres canaux de l'événement le sont. Canaux obligatoires
  // du catalogue (§2.11) jamais bloqués.
  const { channels, blocked } = applyChannelActivation(
    resolved,
    await loadDisabledChannels(row.event_type),
    {
      bell: !!row.mandatory_bell || entry.mandatoryBell,
      email: !!row.mandatory_email || entry.mandatoryEmail,
    },
  );

  const ctx: DeliveryContext = {
    outboxId: row.id,
    userId: row.recipient_user_id,
    eventType: row.event_type,
    category: row.category ?? entry.category,
    payload,
    dedupeKey: row.dedupe_key,
    mustDeliverBell: !!row.mandatory_bell || entry.mandatoryBell,
    accountId: typeof row.account_id === 'number' ? row.account_id : null,
    // Lot 97 : réémission — seuls les appareils mobiles en échec ; aucun si la restriction n'en cite pas.
    ...(restriction ? { mobileInstallationIds: restriction.mobileInstallationIds ?? [] } : {}),
  };

  const outcomes: DeliveryOutcome['status'][] = [];
  /** Lot 81E : causes des canaux ignorés (motif d'un événement `skipped`). */
  const skipCodes: string[] = [];
  const noter = (o: DeliveryOutcome) => {
    outcomes.push(o.status);
    if (o.status !== 'sent' && o.status !== 'failed') skipCodes.push(o.errorCode ?? o.status);
  };

  // Trace : canal supprimé (lot 79C ; cloche : lot 101B) — ni envoi, ni échec.
  for (const channel of retired) {
    const o: DeliveryOutcome = { status: 'skipped_unavailable', errorCode: CHANNEL_RETIRED_ERROR_CODE };
    await recordDelivery(row.id, ctx.userId, channel, o);
    noter(o);
  }

  // Trace de diagnostic : le canal était prévu mais a été coupé par l'admin.
  // « skipped_* » n'est pas un échec (§18.4) et n'est pas compté comme envoi.
  for (const channel of blocked) {
    const o: DeliveryOutcome = { status: 'skipped_unavailable', errorCode: CHANNEL_DISABLED_ERROR_CODE };
    await recordDelivery(row.id, ctx.userId, channel, o);
    noter(o);
  }

  let bellNotificationId: number | undefined;
  if (channels.bell) {
    const o = await deliverBell(ctx, entry, rendered);
    bellNotificationId = o.notificationId;
    await recordDelivery(row.id, ctx.userId, 'bell', o);
    noter(o);
  }
  // Lot 100G (E2) : e-mail porté par la séquence de fin d'essai (même gabarit,
  // contrôles juste avant l'envoi, journal propre) — jamais deux circuits.
  if (channels.email && entry.emailDeliveredBy) {
    const o: DeliveryOutcome = { status: 'skipped_unavailable', errorCode: EMAIL_DELIVERED_ELSEWHERE_ERROR_CODE };
    await recordDelivery(row.id, ctx.userId, 'email', o);
    noter(o);
  } else if (channels.email) {
    const o = await deliverEmail(ctx, entry, rendered);
    await recordDelivery(row.id, ctx.userId, 'email', o);
    noter(o);
  }
  if (channels.push) {
    // Une livraison par appareil (§12.4), applications mobiles natives
    // UNIQUEMENT (lot 97). Lot 94 (décision PO M3) : aucun Web Push, aucun
    // envoi à un navigateur. Aucun appareil → une ligne skipped.
    const mobileResults = await deliverMobilePush(ctx, entry, rendered, bellNotificationId);
    if (mobileResults.length === 0) {
      const o: DeliveryOutcome = { status: 'skipped_unavailable', errorCode: 'no_active_subscription' };
      await recordDelivery(row.id, ctx.userId, 'push', o);
      noter(o);
    } else {
      for (const r of mobileResults) {
        await recordDelivery(row.id, ctx.userId, 'push', r.outcome, r.installationRowId);
        noter(r.outcome);
      }
    }
  }

  // Agrégation (lot 81E) : « envoyé » exige au moins un canal ENVOYÉ ; un
  // « skipped_* » n'est ni un envoi ni un échec (§18.4).
  const finalStatus = aggregateOutboxStatus(outcomes);
  const reason = finalStatus === 'skipped' ? skippedReason(skipCodes, outcomes.length) : null;

  await markProcessed(row.id, finalStatus, { reason });
  await afterProcessed(row, finalStatus);
  return finalStatus;
}

/** Statut agrégé d'un événement à partir des livraisons de ses canaux (pur, lot 81E). */
export function aggregateOutboxStatus(outcomes: readonly DeliveryOutcome['status'][]): 'sent' | 'partial' | 'failed' | 'skipped' {
  const anySent = outcomes.includes('sent');
  const anyFailed = outcomes.includes('failed');
  if (anySent && anyFailed) return 'partial';
  if (anySent) return 'sent';
  if (anyFailed) return 'failed';
  return 'skipped';
}

/** Cause d'un événement ignoré : codes des livraisons, ou aucun canal retenu. */
function skippedReason(codes: readonly string[], attempted: number): string {
  const uniques = [...new Set(codes)].sort();
  if (uniques.length) return uniques.join(',');
  return attempted === 0 ? 'no_channel_selected' : 'not_delivered';
}

/** Suites d'un traitement : reprise des événements regroupés, état du récapitulatif. */
async function afterProcessed(row: OutboxRow, status: 'sent' | 'partial' | 'failed' | 'skipped'): Promise<void> {
  if (status === 'failed' || status === 'skipped') {
    try {
      const rouverts = await reopenGroupedBy(row.id);
      if (rouverts.length) await processOutboxIds(rouverts);
    } catch (e) {
      console.error(`[notifications] reprise des événements regroupés avec ${row.id} :`, (e as Error).message);
    }
  }
  if (row.event_type === 'TO_PROCESS_DAILY_DIGEST') {
    try {
      const { recordDigestOutcome } = await import('./scheduled/to-process-digest');
      await recordDigestOutcome(row.id);
    } catch (e) {
      console.error(`[notifications] état du récapitulatif ${row.id} :`, (e as Error).message);
    }
  }
}

async function processRows(rows: OutboxRow[]): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: rows.length, sent: 0, partial: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    try {
      const r = await processRow(row);
      summary[r] += 1;
    } catch (err) {
      // Ne pas interrompre les autres événements.
      await releaseOrFail(row.id, row.attempt_count ?? 0, (err as Error).message).catch(() => {});
      summary.failed += 1;
    }
  }
  return summary;
}

/** Traite un lot d'événements dus (appelé par le cron `/api/cron/notifications/dispatch`). */
export async function processPending(limit = 50): Promise<DispatchSummary> {
  const rows = await claimPending(limit);
  return processRows(rows);
}

/** Traitement immédiat (best-effort) d'événements précis après enqueue (§11.3). */
export async function processOutboxIds(ids: string[]): Promise<DispatchSummary> {
  const rows = await claimByIds(ids);
  return processRows(rows);
}
