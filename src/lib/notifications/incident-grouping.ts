/**
 * Regroupement des communications d'un MÊME incident — lot 79C, identité des
 * incidents et ordre des webhooks corrigés au lot 81E.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN INCIDENT, UN MESSAGE — DEUX INCIDENTS, DEUX MESSAGES
 *
 * Décidé AU MOMENT DE L'ENVOI (dispatcher), à partir des autres lignes de
 * l'outbox du même destinataire : la règle s'applique donc aussi aux
 * événements déjà en file, aux reprises et aux réémissions.
 *
 * ── ANALYSE (lot 81E) ─────────────────────────────────────────────────────
 * Un incident d'analyse est identifié par le destinataire, le document ET
 * le lot (exécution / cycle de traitement) : `analysisIncidentKey`.
 *   · `ANALYSIS_FAILED_PERSISTENT` est absorbé par l'alerte de LOT
 *     (`DOCUMENT_BATCH_PARTIALLY_FAILED` / `DOCUMENT_BATCH_FAILED`) du MÊME
 *     lot qui nomme ce document, ou par une répétition technique de la même
 *     identité ;
 *   · une nouvelle analyse échouée du même document (autre lot) n'est JAMAIS
 *     absorbée au motif que ce document a déjà échoué (défaut du lot 79C :
 *     l'ancienne requête rapprochait tout échec antérieur du document) ;
 *   · un événement historique sans identité complète (pas de lot) n'est
 *     rapproché de rien : il part tel quel (un doublon vaut mieux qu'un
 *     incident tu).
 *
 * ── PAIEMENT (lot 81E) ────────────────────────────────────────────────────
 * Consolidé par FACTURE Stripe et par état réel, sous verrou consultatif
 * (facture × destinataire) — l'ordre, la simultanéité, le retard et la
 * répétition des webhooks ne changent pas le résultat :
 *   · facture réglée ou annulée depuis (registre `invoices`) : incident sans
 *     objet, ignoré avec sa cause (`incident_resolved:invoice_paid`) ;
 *   · `PAYMENT_FAILED` porte l'incident ; s'il existe une demande
 *     d'authentification pour la même facture, le message porte aussi
 *     l'action (`authenticationRequired`, persistée dans la ligne : c'est ce
 *     qui a été communiqué) ;
 *   · `PAYMENT_ACTION_REQUIRED` est absorbé par le `PAYMENT_FAILED` de la
 *     même facture seulement si ce dernier PORTE l'action (déjà communiquée)
 *     ou n'est pas encore parti (il la portera). Sinon — échec déjà envoyé
 *     sans l'action (webhook tardif) — l'authentification est une évolution
 *     significative : elle est envoyée ;
 *   · jamais absorbé par un porteur en échec : si le porteur n'est envoyé par
 *     aucun canal, les événements regroupés sont remis en file (dispatcher).
 * Le délai d'envoi de `PAYMENT_ACTION_REQUIRED` (2 min) ne fait que lisser
 * l'ordre habituel des webhooks : la décision n'en dépend pas.
 *
 * Lot 97B (test L79C-E2E-08 instable) : quand l'échec et la demande
 * d'authentification sont réclamés dans le MÊME lot du dispatcher, l'échec
 * est déjà `processing` sans avoir encore décidé ; si la demande passait en
 * premier, elle partait (« échec en cours sans l'action ») puis l'échec, la
 * voyant, ajoutait l'action → deux messages. La décision de l'échec est
 * désormais ENREGISTRÉE sous le verrou (`authenticationRequired` true OU
 * false) : un échec `processing` encore indécis portera l'action (il verra
 * cette demande, déjà en base) ; seul un échec qui a décidé « sans action »
 * laisse partir la demande. Aucune horloge n'intervient (ni fenêtre, ni
 * fuseau, ni heure calme) : seul l'état des lignes compte. Le dispatcher
 * traite en outre chaque lot réclamé dans l'ordre de création.
 *
 * Volontairement ÉTROIT : jamais une déduplication globale des incidents d'un
 * utilisateur — un autre lot, une autre facture, un rappel du cycle
 * d'impayé (`ACCOUNT_READ_ONLY`, J−7 / J−1) restent envoyés.
 *
 * Un événement absorbé passe `grouped` (`grouped_with_id`) avec une livraison
 * `skipped_unavailable` / `grouped_incident` par canal prévu : l'historique
 * reste lisible, rien n'est compté « envoyé ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

export const GROUPED_INCIDENT_ERROR_CODE = 'grouped_incident';

/** Délai de l'envoi de `PAYMENT_ACTION_REQUIRED` : laisse `payment_failed` (même facture) arriver (lissage, pas une règle). */
export const PAYMENT_ACTION_GROUPING_DELAY_MS = 2 * 60_000;

const BATCH_FAILURES_SQL = `('DOCUMENT_BATCH_PARTIALLY_FAILED', 'DOCUMENT_BATCH_FAILED')`;
/** Porteurs possibles : en file, en cours, ou envoyés par au moins un canal. */
const CARRIER_STATUSES_SQL = `('pending', 'processing', 'sent', 'partial')`;

interface GroupingInput {
  id: string;
  event_type: string;
  recipient_user_id: number;
  entity_type?: string | null;
  entity_id?: string | null;
  created_at?: string | Date | null;
}

interface GroupingDecision {
  /** Ligne d'outbox qui porte déjà l'incident : celle-ci n'est pas envoyée. */
  absorbedBy: string | null;
  /** Complément de contenu (message unique de l'incident). */
  payloadPatch?: Record<string, unknown>;
  /** Lot 81E : incident sans objet au moment de l'envoi (cause tracée). */
  skipReason?: string;
}

const NONE: GroupingDecision = { absorbedBy: null };

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Identité d'un incident d'analyse d'UN document : document × lot (pure).
 * `null` : identité incomplète (événement historique) — jamais rapproché.
 */
export function analysisIncidentKey(payload: Record<string, unknown> | null | undefined): string | null {
  const fileId = num(payload?.assetFileId);
  const lotId = num(payload?.lotId);
  return fileId != null && lotId != null ? `doc:${fileId}:lot:${lotId}` : null;
}

/**
 * Décision pour `PAYMENT_ACTION_REQUIRED` face au `PAYMENT_FAILED` de la même
 * facture (pure) : absorbé seulement si l'échec porte l'action ou n'est pas
 * encore parti.
 *
 * `authenticationRequired` : décision ENREGISTRÉE par l'échec — `true` (porte
 * l'action), `false` (a décidé sans l'action), `null` (pas encore décidé).
 *   · `pending` : pas encore parti → il portera l'action ;
 *   · `processing` : réclamé ; indécis (`null`) → il verra cette demande et la
 *     portera ; décidé `false` → la demande part (lot 97B) ;
 *   · `sent` / `partial` : seulement s'il a porté l'action (`true`) — une
 *     ligne historique sans décision enregistrée est traitée comme « sans » ;
 *   · autre statut (échec, ignoré, regroupé…) : jamais.
 */
export function actionRequiredCoveredBy(failed: { status: string; authenticationRequired: boolean | null } | null): boolean {
  if (!failed) return false;
  if (failed.status === 'pending') return true;
  if (failed.status === 'processing') return failed.authenticationRequired !== false;
  return (failed.status === 'sent' || failed.status === 'partial') && failed.authenticationRequired === true;
}

/**
 * Décision de `PAYMENT_FAILED` (pure, lot 97B) : porte l'action si le
 * producteur l'a déjà indiquée ou si une demande d'authentification de la
 * même facture existe. La valeur est TOUJOURS enregistrée (true / false).
 */
export function paymentFailedCarriesAction(input: { producerFlag: unknown; actionRequestExists: boolean }): boolean {
  return input.producerFlag === true || input.actionRequestExists;
}

/** Facture réglée ou annulée : un incident de paiement n'a plus d'objet (pure). */
export function invoiceResolvedReason(status: string | null | undefined): string | null {
  return status === 'paid' || status === 'void' ? `incident_resolved:invoice_${status}` : null;
}

/** Ordre de création (ligne antérieure à celle-ci) — repli sur l'identifiant seul. */
function earlierThan(row: GroupingInput): { sql: string; params: unknown[] } {
  if (row.created_at) {
    const at = new Date(row.created_at).toISOString();
    return { sql: `(o.created_at, o.id) < ($A::timestamptz, $B::uuid)`, params: [at, row.id] };
  }
  return { sql: `o.status IN ('sent', 'partial')`, params: [] };
}

function withEarlier(base: string, baseParams: unknown[], row: GroupingInput): { text: string; params: unknown[] } {
  const e = earlierThan(row);
  let text = base.replace('$EARLIER', e.sql);
  const params = [...baseParams];
  if (e.params.length) {
    text = text.replace('$A', `$${params.length + 1}`).replace('$B', `$${params.length + 2}`);
    params.push(...e.params);
  }
  return { text, params };
}

export async function resolveIncidentGrouping(row: GroupingInput, payload: Record<string, unknown>): Promise<GroupingDecision> {
  try {
    switch (row.event_type) {
      case 'ANALYSIS_FAILED_PERSISTENT': {
        const assetFileId = num(payload.assetFileId);
        const lotId = num(payload.lotId);
        // Identité incomplète (historique) : rien n'est rapproché arbitrairement.
        if (assetFileId == null || lotId == null) return NONE;
        const [lot] = await pgClient.unsafe<{ id: string }[]>(
          `SELECT o.id FROM notification_outbox o
            WHERE o.recipient_user_id = $1 AND o.id <> $2 AND o.status IN ${CARRIER_STATUSES_SQL}
              AND o.event_type IN ${BATCH_FAILURES_SQL}
              AND (o.payload_json->>'lotId') = $3::text
              AND o.payload_json->'documents' @> jsonb_build_array(jsonb_build_object('assetFileId', $4::int))
            ORDER BY o.created_at LIMIT 1`,
          [row.recipient_user_id, row.id, String(lotId), assetFileId] as never[],
        );
        if (lot) return { absorbedBy: lot.id };
        // Répétition technique de la MÊME identité (document × lot) déjà portée.
        const q = withEarlier(
          `SELECT o.id FROM notification_outbox o
            WHERE o.recipient_user_id = $1 AND o.id <> $2 AND o.event_type = 'ANALYSIS_FAILED_PERSISTENT'
              AND o.status IN ${CARRIER_STATUSES_SQL}
              AND (o.payload_json->>'assetFileId') = $3::text AND (o.payload_json->>'lotId') = $4::text
              AND $EARLIER
            ORDER BY o.created_at LIMIT 1`,
          [row.recipient_user_id, row.id, String(assetFileId), String(lotId)], row,
        );
        const [doc] = await pgClient.unsafe<{ id: string }[]>(q.text, q.params as never[]);
        return doc ? { absorbedBy: doc.id } : NONE;
      }
      case 'DOCUMENT_BATCH_PARTIALLY_FAILED':
      case 'DOCUMENT_BATCH_FAILED': {
        const lotId = num(payload.lotId);
        if (lotId == null) return NONE;
        // Même lot = même incident : seule une répétition antérieure le porte.
        const q = withEarlier(
          `SELECT o.id FROM notification_outbox o
            WHERE o.recipient_user_id = $1 AND o.id <> $2 AND o.status IN ${CARRIER_STATUSES_SQL}
              AND o.event_type IN ${BATCH_FAILURES_SQL} AND (o.payload_json->>'lotId') = $3::text
              AND $EARLIER
            ORDER BY o.created_at LIMIT 1`,
          [row.recipient_user_id, row.id, String(lotId)], row,
        );
        const [other] = await pgClient.unsafe<{ id: string }[]>(q.text, q.params as never[]);
        return other ? { absorbedBy: other.id } : NONE;
      }
      case 'PAYMENT_ACTION_REQUIRED':
      case 'PAYMENT_FAILED':
        return await resolvePaymentIncident(row, payload);
      default:
        return NONE;
    }
  } catch (e) {
    // Lecture impossible : on envoie (un doublon vaut mieux qu'un incident tu).
    console.warn(`[notifications] regroupement non évalué pour ${row.event_type} :`, (e as Error).message);
    return NONE;
  }
}

async function resolvePaymentIncident(row: GroupingInput, payload: Record<string, unknown>): Promise<GroupingDecision> {
  if (row.entity_type !== 'invoice' || !row.entity_id) return NONE;
  const invoiceId = row.entity_id;
  return pgClient.begin(async (tx) => {
    // Une décision à la fois par facture × destinataire (webhooks simultanés).
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payment-incident:${invoiceId}:${row.recipient_user_id}`] as never[]);

    const [inv] = await tx.unsafe<{ status: string }[]>(
      `SELECT status FROM invoices WHERE stripe_invoice_id = $1`, [invoiceId] as never[]);
    const resolved = invoiceResolvedReason(inv?.status);
    if (resolved) return { absorbedBy: null, skipReason: resolved };

    if (row.event_type === 'PAYMENT_FAILED') {
      if (payload.authenticationRequired === true) return NONE;
      const [action] = await tx.unsafe<{ id: string }[]>(
        `SELECT id FROM notification_outbox
          WHERE recipient_user_id = $1 AND id <> $2 AND event_type = 'PAYMENT_ACTION_REQUIRED'
            AND entity_type = 'invoice' AND entity_id = $3 AND status <> 'cancelled'
          LIMIT 1`,
        [row.recipient_user_id, row.id, invoiceId] as never[],
      );
      const carries = paymentFailedCarriesAction({ producerFlag: payload.authenticationRequired, actionRequestExists: !!action });
      // Ce qui est communiqué est enregistré, AVEC OU SANS l'action (lot 97B) :
      // la demande d'authentification (même facture) sait si elle est couverte,
      // même quand les deux sont réclamées dans le même lot.
      await tx.unsafe(
        `UPDATE notification_outbox SET payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object('authenticationRequired', $2::boolean)
          WHERE id = $1`, [row.id, carries] as never[]);
      return carries ? { absorbedBy: null, payloadPatch: { authenticationRequired: true } } : NONE;
    }

    // PAYMENT_ACTION_REQUIRED
    const [failed] = await tx.unsafe<{ id: string; status: string; auth: boolean | null }[]>(
      `SELECT id, status, (payload_json->>'authenticationRequired')::boolean AS auth FROM notification_outbox
        WHERE recipient_user_id = $1 AND id <> $2 AND event_type = 'PAYMENT_FAILED'
          AND entity_type = 'invoice' AND entity_id = $3 AND status IN ${CARRIER_STATUSES_SQL}
        ORDER BY (payload_json->>'authenticationRequired')::boolean IS TRUE DESC, created_at
        LIMIT 1`,
      [row.recipient_user_id, row.id, invoiceId] as never[],
    );
    if (failed && actionRequiredCoveredBy({ status: failed.status, authenticationRequired: failed.auth })) {
      return { absorbedBy: failed.id };
    }
    return NONE;
  });
}
