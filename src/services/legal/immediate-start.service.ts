/**
 * Demande expresse de démarrage immédiat — preuve (lot 102B).
 *
 * Même structure qu'une preuve d'acceptation (`legal_acceptances`, contexte
 * IMMEDIATE_START_REQUEST) : version des CGUV en vigueur + permalien public +
 * empreinte + date + canal + offre demandée ; rattachée à l'abonnement Stripe
 * à la confirmation du paiement (`linkImmediateStartRequest`, appelé par le
 * crochet du webhook). Aucune déduction en cas de rétractation (décision PO).
 */
import { pgClient } from '@/db';
import type { AcceptanceChannel } from '@/lib/legal/public-legal';
import { recordLegalAudit } from './legal-audit.service';
import { recordAcceptance } from './legal-acceptances.service';
import { getCurrentVersion } from './legal-versions.service';

/** Fenêtre de rattachement d'une demande au paiement confirmé (session Stripe ≤ 24 h). */
export const IMMEDIATE_START_LINK_WINDOW_HOURS = 48;

export type ImmediateStartResult =
  | { ok: true; acceptanceId: string; versionCode: string; permalinkUrl: string; textSha256: string | null; acceptedAt: Date }
  | { ok: false; code: 'NO_CURRENT_VERSION' };

export async function recordImmediateStartRequest(input: {
  userId: number;
  planCode: string;
  billingPeriod: string;
  channel: AcceptanceChannel;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<ImmediateStartResult> {
  const current = await getCurrentVersion();
  if (!current) return { ok: false, code: 'NO_CURRENT_VERSION' };
  const proof = await recordAcceptance({
    userId: input.userId,
    versionCode: current.versionCode,
    context: 'IMMEDIATE_START_REQUEST',
    offerCode: `${input.planCode}:${input.billingPeriod}`.slice(0, 60),
    channel: input.channel,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  if (!proof.alreadyRecorded) {
    await recordLegalAudit({
      action: 'IMMEDIATE_START_REQUESTED', actorUserId: input.userId, versionCode: proof.versionCode, versionId: proof.versionId,
      details: `offre ${input.planCode}:${input.billingPeriod} ; canal ${input.channel}`,
    });
  }
  return { ok: true, acceptanceId: proof.id, versionCode: proof.versionCode, permalinkUrl: proof.permalinkUrl, textSha256: proof.textSha256, acceptedAt: proof.acceptedAt };
}

/**
 * Rattache la dernière demande non rattachée de l'utilisateur (fenêtre
 * `IMMEDIATE_START_LINK_WINDOW_HOURS`) à l'abonnement confirmé. Le
 * déclencheur 0910 n'autorise que ce passage NULL → valeur. L'abonnement est
 * identifié par sa référence Stripe (`subscription_reference`) : la ligne
 * locale `account_subscriptions` est unique par compte et ne distingue pas deux
 * souscriptions successives. `subscriptionId` figure dans la preuve PAID_SUBSCRIPTION. Ne lève jamais.
 */
export async function linkImmediateStartRequest(input: {
  userId: number;
  subscriptionId: number | null;
  stripeSubscriptionId: string;
}): Promise<string | null> {
  try {
    const rows = await pgClient<{ id: string }[]>`
      UPDATE legal_acceptances
         SET subscription_reference = ${input.stripeSubscriptionId}
       WHERE id = (
         SELECT id FROM legal_acceptances
          WHERE user_id = ${input.userId}
            AND acceptance_context = 'IMMEDIATE_START_REQUEST'
            AND subscription_reference IS NULL
            AND accepted_at > now() - make_interval(hours => ${IMMEDIATE_START_LINK_WINDOW_HOURS})
          ORDER BY accepted_at DESC
          LIMIT 1)
      RETURNING id`;
    return rows[0]?.id ?? null;
  } catch (e) {
    console.error('[legal] rattachement de la demande de démarrage immédiat impossible :', (e as Error).message);
    return null;
  }
}
