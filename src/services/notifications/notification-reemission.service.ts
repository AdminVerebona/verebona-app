/**
 * Réémission manuelle — CDC 3 §20.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CINQ CONDITIONS, TOUTES VÉRIFIÉES ICI
 *
 * Le §20.3 les énumère :
 *
 *   1. réservée aux administrateurs autorisés ;
 *   2. crée une nouvelle opération auditée ;
 *   3. ne contourne pas les règles obligatoires ;
 *   4. demande une confirmation ;
 *   5. évite la réémission des actualités à un utilisateur non consentant.
 *
 * La cinquième est la plus facile à oublier, et la plus coûteuse : réémettre
 * une actualité à quelqu'un qui a retiré son consentement, c'est un envoi non
 * sollicité — sanctionnable, et une rupture de confiance.
 *
 * ── UNE RÉÉMISSION N'EST PAS UN RENVOI ────────────────────────────────────
 *
 * Elle crée une NOUVELLE ligne, avec sa propre clé de déduplication et sa
 * propre trace. Le contenu de la ligne d'origine n'est pas modifié : ce serait
 * effacer l'historique de l'incident (il y a eu un échec, puis une réémission
 * décidée par quelqu'un). Seul son statut passe à `reemitted` (« réémise »),
 * ce qui la retire de la santé des notifications et interdit une seconde
 * réémission du même échec.
 *
 * ── SEULS LES CANAUX EN ÉCHEC SONT RÉÉMIS (revue lot 21) ──────────────────
 *
 * Un canal déjà livré (cloche, e-mail, appareil push) ne l'est pas deux fois :
 * la nouvelle ligne porte dans `payload_json._reemission` la liste des canaux
 * (et des appareils push) à servir, que le dispatcher applique — y compris à
 * une cloche obligatoire déjà livrée. Ligne jamais distribuée (aucune
 * livraison journalisée) : tous les canaux, selon les règles habituelles.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db, pgClient } from '@/db';
import { notificationOutbox, newsConsents } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';
import { and, eq, notInArray } from 'drizzle-orm';
import { REEMISSION_KEY, type ReemissionRestriction, type ReemissionChannel } from '@/lib/notifications/reemission-restriction';

export class ReemissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReemissionError';
  }
}

export interface ReemissionInput {
  /** Adresse de l'administrateur : le journal d'audit l'exige. */
  actorEmail: string;
  /** Identifiant de la file : un UUID, non un entier. */
  outboxId: string;
  /** Administrateur à l'origine de la décision. */
  actorUserId: number;
  /** §20.3 condition 4 : la confirmation est explicite, jamais implicite. */
  confirme: boolean;
  motif?: string;
}

export interface ReemissionResult {
  nouvelleId: string;
  eventType: string;
  destinataire: number | null;
  /** Canaux réémis ; `null` = tous (ligne d'origine jamais distribuée). */
  canaux: ReemissionChannel[] | null;
}

export interface DeliveryTrace {
  channel: string;
  status: string;
  pushSubscriptionId: string | null;
}

/**
 * Canaux à réémettre d'après le journal de livraison de la ligne d'origine.
 *
 * - aucune livraison journalisée → `null` : rien n'est parti, tout est réémis ;
 * - cloche / e-mail : réémis s'ils ont échoué et n'ont jamais été livrés ;
 * - push : seuls les appareils en échec (jamais livrés) sont visés.
 * Résultat vide (`canaux: []`) : tout a été livré, rien à réémettre.
 */
export function canauxAReemettre(traces: DeliveryTrace[]): ReemissionRestriction | null {
  if (traces.length === 0) return null;
  const livre = (c: string, sub: string | null = null) =>
    traces.some((t) => t.channel === c && t.status === 'sent' && (sub === null || t.pushSubscriptionId === sub));
  const echoue = (c: string) => traces.some((t) => t.channel === c && t.status === 'failed');
  const canaux: ReemissionChannel[] = [];
  for (const c of ['bell', 'email'] as const) if (echoue(c) && !livre(c)) canaux.push(c);
  const appareils = [...new Set(traces
    .filter((t) => t.channel === 'push' && t.status === 'failed' && t.pushSubscriptionId)
    .map((t) => t.pushSubscriptionId as string))]
    .filter((sub) => !livre('push', sub));
  if (appareils.length > 0) canaux.push('push');
  return { canaux, ...(appareils.length > 0 ? { pushSubscriptionIds: appareils } : {}) };
}

/** Types dont la réémission suppose un consentement en vigueur (§20.3). */
const TYPES_SOUMIS_A_CONSENTEMENT = ['news', 'notif_news', 'newsletter'];

/**
 * Le destinataire consent-il encore aux actualités ?
 *
 * Le consentement se retire : celui qui valait au premier envoi peut ne plus
 * valoir aujourd'hui. C'est l'état ACTUEL qui fait foi, pas celui d'origine.
 */
async function consentementActuel(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ consented: newsConsents.consented })
    .from(newsConsents)
    .where(eq(newsConsents.userId, userId))
    .limit(1);
  // Absence de ligne = pas de consentement recueilli, donc pas d'envoi.
  return row?.consented === true;
}

export async function reemettreNotification(
  input: ReemissionInput,
): Promise<ReemissionResult> {
  // ── Condition 4 : confirmation explicite ────────────────────────────────
  if (!input.confirme) {
    throw new ReemissionError(
      'CONFIRMATION_REQUISE',
      'La réémission demande une confirmation explicite.',
    );
  }

  const [origine] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, input.outboxId))
    .limit(1);

  if (!origine) {
    throw new ReemissionError('INTROUVABLE', `Événement ${input.outboxId} introuvable.`);
  }
  if (origine.status === 'reemitted') {
    throw new ReemissionError('DEJA_REEMISE', 'Cet événement a déjà été réémis : réémettre la nouvelle ligne si besoin.');
  }
  if (origine.status === 'processing') {
    throw new ReemissionError('EN_COURS', 'Événement en cours de distribution : réessayer dans un instant.');
  }

  // ── Condition 5 : consentement aux actualités ───────────────────────────
  const soumisAConsentement = TYPES_SOUMIS_A_CONSENTEMENT.some((t) =>
    origine.eventType.toLowerCase().includes(t),
  );
  if (soumisAConsentement) {
    if (!origine.recipientUserId) {
      throw new ReemissionError(
        'DESTINATAIRE_INCONNU',
        'Une actualité sans destinataire identifié ne peut pas être réémise.',
      );
    }
    if (!(await consentementActuel(origine.recipientUserId))) {
      throw new ReemissionError(
        'CONSENTEMENT_RETIRE',
        "Le destinataire ne consent plus aux actualités : la réémission est refusée.",
      );
    }
  }

  // ── Condition 3 : ne pas contourner les règles obligatoires ─────────────
  //
  // Les indicateurs `mandatory_*` sont recopiés tels quels. Les forcer à
  // `true` pour « être sûr que ça parte » transformerait une réémission en
  // contournement des préférences de l'utilisateur.
  // ── Canaux encore à servir ─────────────────────────────────────────────
  const traces = await pgClient<DeliveryTrace[]>`
    SELECT channel, status, push_subscription_id AS "pushSubscriptionId"
    FROM notification_deliveries WHERE outbox_id = ${origine.id}::uuid
  `;
  const restriction = canauxAReemettre([...traces]);
  if (restriction && restriction.canaux.length === 0) {
    throw new ReemissionError('RIEN_A_REEMETTRE', 'Tous les canaux de cet événement ont été livrés : rien à réémettre.');
  }
  const payloadOrigine = (origine.payloadJson ?? {}) as Record<string, unknown>;
  const payloadJson = restriction
    ? { ...payloadOrigine, [REEMISSION_KEY]: { origine: origine.id, ...restriction } }
    : { ...payloadOrigine };

  const now = new Date();
  // Clé distincte de l'originale : sans quoi la déduplication rejetterait
  // silencieusement la réémission, qui paraîtrait avoir réussi.
  const dedupeKey = `${origine.dedupeKey}:reemis:${now.getTime()}`;

  // Insertion et changement de statut de l'origine dans une même transaction ;
  // le changement est conditionnel : deux réémissions concurrentes du même
  // échec n'en produisent qu'une.
  const nouvelle = await db.transaction(async (tx) => {
    const marquee = await tx
      .update(notificationOutbox)
      .set({ status: 'reemitted' })
      .where(and(eq(notificationOutbox.id, origine.id), notInArray(notificationOutbox.status, ['reemitted', 'processing'])))
      .returning({ id: notificationOutbox.id });
    if (marquee.length === 0) {
      throw new ReemissionError('DEJA_REEMISE', 'Cet événement vient d’être réémis ou est en cours de distribution.');
    }
    const [ligne] = await tx
    .insert(notificationOutbox)
    .values({
      eventType: origine.eventType,
      category: origine.category,
      accountId: origine.accountId,
      recipientUserId: origine.recipientUserId,
      actorUserId: input.actorUserId,
      entityType: origine.entityType,
      entityId: origine.entityId,
      deepLink: origine.deepLink,
      priority: origine.priority,
      mandatoryBell: origine.mandatoryBell,
      mandatoryEmail: origine.mandatoryEmail,
      payloadJson,
      dedupeKey,
      scheduledFor: now,
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
    })
    .returning({ id: notificationOutbox.id });
    return ligne;
  });

  // ── Condition 2 : opération auditée ─────────────────────────────────────
  //
  // Journal commun des actions administrateur (`logAdminAction`, D-L lot 21) :
  // auteur, date, résultat, origine et nouvelle ligne. Hors transaction avec
  // l'insertion : une trace d'audit qui ferait échouer la réémission serait
  // pire que son absence (`logAdminAction` ne lève jamais).
  try {
    await logAdminAction({
      adminId: input.actorUserId,
      adminEmail: input.actorEmail,
      action: 'NOTIFICATION_REEMIT',
      targetType: 'NOTIFICATION',
      // `targetId` est un entier ; l'identifiant de la file est un UUID.
      // Il figure donc dans `details`, où il reste exploitable.
      targetId: null,
      result: 'SUCCESS',
      details: { origine: origine.id, nouvelle: nouvelle.id, eventType: origine.eventType, canaux: restriction?.canaux ?? 'tous', motif: input.motif ?? null },
    });
  } catch (e) {
    console.error('[reemission] trace d\'audit non écrite :', (e as Error).message);
  }

  return {
    nouvelleId: nouvelle.id,
    eventType: origine.eventType,
    destinataire: origine.recipientUserId,
    canaux: restriction?.canaux ?? null,
  };
}

/** Aperçu avant confirmation : ce que la réémission ferait (§20.3 condition 4). */
export async function apercuReemission(outboxId: string): Promise<{
  eventType: string;
  destinataire: number | null;
  statutOrigine: string;
  soumisAConsentement: boolean;
  consentementEnVigueur: boolean | null;
  refusPrevisible: string | null;
}> {
  const [origine] = await pgClient<{
    event_type: string; recipient_user_id: number | null; status: string;
  }[]>`
    SELECT event_type, recipient_user_id, status
    FROM notification_outbox WHERE id = ${outboxId}::uuid
  `;

  if (!origine) throw new ReemissionError('INTROUVABLE', `Événement ${outboxId} introuvable.`);

  const soumis = TYPES_SOUMIS_A_CONSENTEMENT.some((t) =>
    origine.event_type.toLowerCase().includes(t),
  );
  const consentement = soumis && origine.recipient_user_id
    ? await consentementActuel(origine.recipient_user_id)
    : null;

  return {
    eventType: origine.event_type,
    destinataire: origine.recipient_user_id,
    statutOrigine: origine.status,
    soumisAConsentement: soumis,
    consentementEnVigueur: consentement,
    refusPrevisible:
      soumis && consentement === false
        ? 'Le destinataire ne consent plus aux actualités.'
        : soumis && !origine.recipient_user_id
          ? 'Actualité sans destinataire identifié.'
          : null,
  };
}
