/**
 * « Refuser l'invitation » Premium Duo — lot 73B (décision PO du 20/10/2026,
 * point 4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI PEUT REFUSER, ET COMMENT
 *
 *   · par le JETON du lien d'invitation (page `/duo/join/[token]`) : invité
 *     non inscrit (aucun compte n'est créé, aucune session n'est exigée) ou
 *     déjà connecté. Le jeton — 256 bits, envoyé à la SEULE adresse invitée —
 *     est la preuve, comme pour l'affichage de l'invitation ;
 *   · depuis l'écran « sans espace » (identité vérifiée, sans espace) : les
 *     invitations EN ATTENTE adressées à l'adresse VÉRIFIÉE de la session,
 *     jamais une adresse ou un identifiant fourni par le client.
 *
 * EFFETS, EN UNE TRANSACTION (ligne du Duo verrouillée `FOR UPDATE`, la même
 * que le rattachement `joinDuoByInvitation` : refus et acceptation
 * simultanés ne peuvent jamais aboutir tous les deux) :
 *   1. jeton INVALIDÉ (retiré de `pending_invite_*`) : il ne permet plus ni
 *      de rejoindre, ni de s'inscrire, ni d'expédier l'e-mail d'invitation
 *      encore en file (la file relit l'invitation : `INVITATION_WITHDRAWN`) ;
 *   2. refus mémorisé : adresse, date, EMPREINTE du jeton (jamais le jeton) —
 *      statut « Refusée » du panneau du titulaire, « invitation refusée » sur
 *      le lien ;
 *   3. titulaire PRÉVENU : notification (service de notifications, outbox
 *      durable dans la transaction : cloche obligatoire, push discret) et
 *      e-mail transactionnel DUO_INVITATION_DECLINED (file durable, envoyé
 *      par la tâche planifiée interne `transactional-emails-retry`) ;
 *   4. trace dans le journal du compte (`account_audit_log`).
 *
 * IDEMPOTENCE : seul un jeton encore EN ATTENTE et non expiré produit un effet ; rejoué
 * (double clic, deux onglets, lien rouvert), le refus ne trouve plus rien.
 * Clés d'idempotence de la notification et de l'e-mail : Duo × empreinte du
 * jeton — une réinvitation (nouveau jeton) puis un nouveau refus prévient de
 * nouveau le titulaire.
 *
 * ANTI-ÉNUMÉRATION : la route répond la MÊME chose que le jeton soit inconnu,
 * expiré, déjà accepté, déjà refusé ou refusé à l'instant ; rien n'indique si
 * l'adresse invitée a un compte, ni qui a invité.
 *
 * Aucun compte, aucune adhésion, aucun essai n'est créé ; une adhésion
 * existante n'est jamais touchée. La réinvitation reste libre (POST
 * /api/duo/invitation : nouveau jeton, même adresse ou une autre).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accountAuditLog, duoAccounts } from '@/db/schema';
import { inviteTokenHash } from '@/lib/duo/invite-token-hash';
import { resolveDuoAccountId } from '@/services/account/membership.service';

export const DUO_INVITATION_DECLINED = 'DUO_INVITATION_DECLINED' as const;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] })?.rows ?? []));

/** Jeton d'invitation plausible (hexadécimal de 64 caractères aujourd'hui ; borne large, jamais de lecture au-delà). */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function isWellFormedInviteToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token.trim());
}

/** Clé d'idempotence d'un refus (notification et e-mail) : Duo × empreinte du jeton refusé. */
export function duoInvitationDeclinedKey(duoId: number, tokenHash: string): string {
  return `duo-invitation-declined:${duoId}:${tokenHash}`;
}

export type DeclineVia = 'link' | 'no_space_screen';

export interface DeclineOutcome {
  /** Vrai seulement si CETTE requête a refusé une invitation en attente (jamais exposé au client). */
  declined: boolean;
  duoId?: number;
}

/**
 * Refuse l'invitation dont `token` est le jeton EN ATTENTE. Sans effet (et
 * sans erreur) si le jeton est inconnu, déjà consommé ou déjà refusé.
 */
export async function declineDuoInvitationByToken(
  rawToken: string,
  p: { byUserId?: number | null; via?: DeclineVia; now?: Date } = {},
): Promise<DeclineOutcome> {
  const token = rawToken.trim();
  if (!isWellFormedInviteToken(token)) return { declined: false };
  const now = p.now ?? new Date();

  return db.transaction(async (tx): Promise<DeclineOutcome> => {
    const [duo] = await tx
      .select({
        id: duoAccounts.id,
        ownerId: duoAccounts.billingOwnerUserId,
        inviteEmail: duoAccounts.pendingInviteEmail,
        expiresAt: duoAccounts.pendingInviteTokenExpiresAt,
      })
      .from(duoAccounts)
      .where(eq(duoAccounts.pendingInviteToken, token))
      .limit(1)
      .for('update');
    if (!duo) return { declined: false };
    // Invitation expirée : déjà sans effet (le titulaire la voit « expirée ») —
    // la page n'offre pas le refus ; même réponse, rien n'est écrit.
    if (duo.expiresAt && new Date(duo.expiresAt).getTime() < now.getTime()) return { declined: false };

    const hash = inviteTokenHash(token);
    const inviteEmail = duo.inviteEmail?.trim() || null;
    await tx.update(duoAccounts).set({
      pendingInviteEmail: null,
      pendingInviteToken: null,
      pendingInviteTokenExpiresAt: null,
      pendingInviteSentAt: null,
      lastDeclinedInviteEmail: inviteEmail,
      lastDeclinedAt: now,
      lastDeclinedInviteTokenHash: hash,
      updatedAt: now,
    }).where(eq(duoAccounts.id, duo.id));

    const accountId = await resolveDuoAccountId(duo.id, tx);
    const key = duoInvitationDeclinedKey(duo.id, hash);

    // Notification au titulaire (outbox durable, dans la transaction du refus).
    const { emit } = await import('@/lib/notifications');
    await emit({
      type: 'DUO_INVITATION_DECLINED',
      recipientUserIds: [duo.ownerId],
      accountId,
      actorUserId: p.byUserId ?? null,
      entityType: 'duo_account',
      entityId: duo.id,
      payload: { duoId: duo.id, ...(inviteEmail ? { inviteEmail } : {}) },
      dedupeKey: key,
      tx,
    });

    // E-mail transactionnel au titulaire (file durable). Le destinataire est
    // relu à l'envoi (adresse actuelle) ; aucune adresse du titulaire ici.
    const [owner] = rowsOf<{ email: string | null }>(await tx.execute(sql`SELECT email FROM users WHERE id = ${duo.ownerId}`));
    if (owner?.email) {
      const context = { duoId: duo.id, inviteEmail, declinedAt: now.toISOString() };
      await tx.execute(sql`
        INSERT INTO transactional_email_jobs
               (kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, dedupe_key, status, attempts,
                max_attempts, next_attempt_at, created_at, updated_at)
        SELECT ${DUO_INVITATION_DECLINED}, ${duo.ownerId}, NULL, ${p.byUserId ?? null}, ${owner.email}, ${JSON.stringify(context)}::jsonb,
               ${key}, 'pending', 0, 6, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
         WHERE NOT EXISTS (SELECT 1 FROM transactional_email_jobs WHERE dedupe_key = ${key})`);
    }

    if (accountId) {
      await tx.insert(accountAuditLog).values({
        accountId,
        userId: p.byUserId ?? null,
        userEmail: inviteEmail ?? '',
        actionType: 'DUO_INVITATION_DECLINED',
        targetUserId: duo.ownerId,
        details: JSON.stringify({ duoId: duo.id, via: p.via ?? 'link' }),
        timestamp: now,
      });
    }
    return { declined: true, duoId: duo.id };
  });
}

/**
 * Écran « sans espace » : refuse les invitations EN ATTENTE adressées à
 * l'adresse VÉRIFIÉE de la session (jamais une adresse fournie par le client).
 */
export async function declineDuoInvitationsForEmail(
  email: string,
  p: { byUserId: number; now?: Date },
): Promise<{ declined: number }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { declined: 0 };
  const rows = await db
    .select({ token: duoAccounts.pendingInviteToken })
    .from(duoAccounts)
    .where(and(isNotNull(duoAccounts.pendingInviteToken), sql`lower(${duoAccounts.pendingInviteEmail}) = ${normalized}`))
    .limit(10);
  let declined = 0;
  for (const r of rows) {
    if (!r.token) continue;
    const o = await declineDuoInvitationByToken(r.token, { byUserId: p.byUserId, via: 'no_space_screen', now: p.now });
    if (o.declined) declined += 1;
  }
  return { declined };
}

/** Jeton déjà refusé (empreinte) : « invitation refusée » plutôt que « lien inconnu ». */
export async function isDeclinedInviteToken(token: string, runner: Pick<typeof db, 'select'> = db): Promise<boolean> {
  if (!isWellFormedInviteToken(token)) return false;
  const [row] = await runner
    .select({ id: duoAccounts.id })
    .from(duoAccounts)
    .where(eq(duoAccounts.lastDeclinedInviteTokenHash, inviteTokenHash(token.trim())))
    .limit(1);
  return !!row;
}
