/**
 * Regroupement des communications d'un MÊME incident — lot 79C.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN INCIDENT, UN MESSAGE
 *
 * Décidé AU MOMENT DE L'ENVOI (dispatcher), à partir des autres lignes de
 * l'outbox du même destinataire : la règle s'applique donc aussi aux
 * événements déjà en file, aux reprises et aux réémissions.
 *
 *   · échec d'analyse : `ANALYSIS_FAILED_PERSISTENT` d'un document est
 *     absorbé par l'alerte de LOT (`DOCUMENT_BATCH_PARTIALLY_FAILED` /
 *     `DOCUMENT_BATCH_FAILED`) dont le lot contient ce document — une seule
 *     alerte, au niveau du lot, qui liste les documents et l'action ; une
 *     seconde alerte de lot du même lot (autre clé) est absorbée aussi ;
 *   · paiement : Stripe émet `invoice.payment_action_required` ET
 *     `invoice.payment_failed` pour une même facture qui exige une
 *     authentification (3D Secure). `PAYMENT_ACTION_REQUIRED` est absorbé
 *     par `PAYMENT_FAILED` de la même facture, dont le message porte alors
 *     le problème, les conséquences ET l'action (`authenticationRequired`).
 *
 * Volontairement ÉTROIT : même destinataire, même facture ou même lot /
 * document. Jamais une déduplication globale des incidents d'un utilisateur :
 * un nouvel échec (autre facture), un rappel du cycle d'impayé
 * (`ACCOUNT_READ_ONLY`, J−7 / J−1) ou un autre lot restent envoyés.
 *
 * Un événement absorbé est clos `cancelled` (`grouped_with:<id>`) avec une
 * livraison `skipped_unavailable` / `grouped_incident` par canal prévu :
 * l'historique reste lisible, rien n'est compté « envoyé ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

export const GROUPED_INCIDENT_ERROR_CODE = 'grouped_incident';

/** Délai de l'envoi de `PAYMENT_ACTION_REQUIRED` : laisse `payment_failed` (même facture) arriver. */
export const PAYMENT_ACTION_GROUPING_DELAY_MS = 2 * 60_000;

const BATCH_FAILURES_SQL = `('DOCUMENT_BATCH_PARTIALLY_FAILED', 'DOCUMENT_BATCH_FAILED')`;

export interface GroupingInput {
  id: string;
  event_type: string;
  recipient_user_id: number;
  entity_type?: string | null;
  entity_id?: string | null;
}

export interface GroupingDecision {
  /** Ligne d'outbox qui porte déjà l'incident : celle-ci n'est pas envoyée. */
  absorbedBy: string | null;
  /** Complément de contenu (message unique de l'incident). */
  payloadPatch?: Record<string, unknown>;
}

const NONE: GroupingDecision = { absorbedBy: null };

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function resolveIncidentGrouping(row: GroupingInput, payload: Record<string, unknown>): Promise<GroupingDecision> {
  try {
    switch (row.event_type) {
      case 'ANALYSIS_FAILED_PERSISTENT': {
        const assetFileId = num(payload.assetFileId);
        if (assetFileId == null) return NONE;
        const [lot] = await pgClient.unsafe<{ id: string }[]>(
          `SELECT o.id FROM notification_outbox o
            WHERE o.recipient_user_id = $1 AND o.id <> $2 AND o.status <> 'cancelled'
              AND o.event_type IN ${BATCH_FAILURES_SQL}
              AND EXISTS (SELECT 1 FROM document_lot_items li
                           WHERE li.lot_id = (o.payload_json->>'lotId')::int AND li.asset_file_id = $3)
            ORDER BY o.created_at LIMIT 1`,
          [row.recipient_user_id, row.id, assetFileId] as never[],
        );
        if (lot) return { absorbedBy: lot.id };
        // Même document déjà signalé (autre clé) : une seule alerte.
        const [doc] = await pgClient.unsafe<{ id: string }[]>(
          `SELECT o.id FROM notification_outbox o
            WHERE o.recipient_user_id = $1 AND o.id <> $2 AND o.event_type = 'ANALYSIS_FAILED_PERSISTENT'
              AND o.status IN ('sent', 'partial') AND (o.payload_json->>'assetFileId')::int = $3
            ORDER BY o.created_at LIMIT 1`,
          [row.recipient_user_id, row.id, assetFileId] as never[],
        );
        return doc ? { absorbedBy: doc.id } : NONE;
      }
      case 'DOCUMENT_BATCH_PARTIALLY_FAILED':
      case 'DOCUMENT_BATCH_FAILED': {
        const lotId = num(payload.lotId);
        if (lotId == null) return NONE;
        const [other] = await pgClient.unsafe<{ id: string }[]>(
          `SELECT o.id FROM notification_outbox o
            WHERE o.recipient_user_id = $1 AND o.id <> $2 AND o.status IN ('sent', 'partial')
              AND o.event_type IN ${BATCH_FAILURES_SQL} AND (o.payload_json->>'lotId')::int = $3
            ORDER BY o.created_at LIMIT 1`,
          [row.recipient_user_id, row.id, lotId] as never[],
        );
        return other ? { absorbedBy: other.id } : NONE;
      }
      case 'PAYMENT_ACTION_REQUIRED': {
        if (row.entity_type !== 'invoice' || !row.entity_id) return NONE;
        const [failed] = await pgClient.unsafe<{ id: string }[]>(
          `SELECT id FROM notification_outbox
            WHERE recipient_user_id = $1 AND id <> $2 AND event_type = 'PAYMENT_FAILED'
              AND entity_type = 'invoice' AND entity_id = $3 AND status <> 'cancelled'
            ORDER BY created_at LIMIT 1`,
          [row.recipient_user_id, row.id, row.entity_id] as never[],
        );
        return failed ? { absorbedBy: failed.id } : NONE;
      }
      case 'PAYMENT_FAILED': {
        if (row.entity_type !== 'invoice' || !row.entity_id || payload.authenticationRequired) return NONE;
        const [action] = await pgClient.unsafe<{ id: string }[]>(
          `SELECT id FROM notification_outbox
            WHERE recipient_user_id = $1 AND id <> $2 AND event_type = 'PAYMENT_ACTION_REQUIRED'
              AND entity_type = 'invoice' AND entity_id = $3
            LIMIT 1`,
          [row.recipient_user_id, row.id, row.entity_id] as never[],
        );
        return action ? { absorbedBy: null, payloadPatch: { authenticationRequired: true } } : NONE;
      }
      default:
        return NONE;
    }
  } catch (e) {
    // Lecture impossible : on envoie (un doublon vaut mieux qu'un incident tu).
    console.warn(`[notifications] regroupement non évalué pour ${row.event_type} :`, (e as Error).message);
    return NONE;
  }
}
