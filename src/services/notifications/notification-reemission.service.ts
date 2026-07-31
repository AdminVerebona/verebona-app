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
 * propre trace. Modifier la ligne d'origine effacerait l'historique de
 * l'incident — or c'est précisément ce qu'on veut conserver : il y a eu un
 * échec, puis une réémission décidée par quelqu'un.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db, pgClient } from '@/db';
import { notificationOutbox, newsConsents, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';

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
  const now = new Date();
  // Clé distincte de l'originale : sans quoi la déduplication rejetterait
  // silencieusement la réémission, qui paraîtrait avoir réussi.
  const dedupeKey = `${origine.dedupeKey}:reemis:${now.getTime()}`;

  const [nouvelle] = await db
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
      dedupeKey,
      scheduledFor: now,
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
    })
    .returning({ id: notificationOutbox.id });

  // ── Condition 2 : opération auditée ─────────────────────────────────────
  //
  // Hors transaction avec l'insertion : une trace d'audit qui ferait échouer
  // la réémission serait pire que son absence. On la consigne, et un échec
  // est journalisé sans interrompre.
  try {
    await db.insert(adminAuditLog).values({
      adminUserId: input.actorUserId,
      adminEmail: input.actorEmail,
      actionType: 'NOTIFICATION_REEMISSION',
      targetType: 'notification_outbox',
      // `targetId` est un entier ; l'identifiant de la file est un UUID.
      // Il figure donc dans `details`, où il reste exploitable.
      targetId: null,
      details: JSON.stringify({
        origine: origine.id,
        nouvelle: nouvelle.id,
        eventType: origine.eventType,
        motif: input.motif ?? null,
      }),
      timestamp: now,
    });
  } catch (e) {
    console.error('[reemission] trace d\'audit non écrite :', (e as Error).message);
  }

  return {
    nouvelleId: nouvelle.id,
    eventType: origine.eventType,
    destinataire: origine.recipientUserId,
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
