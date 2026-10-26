/**
 * E-mails au membre quand son accès à un Premium Duo prend fin — lot 64A
 * (fin subie, DUO_MEMBERSHIP_ENDED) et lot 65A (départ volontaire,
 * DUO_MEMBERSHIP_LEFT), décisions PO du 16/10/2026.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL POINT D'ENTRÉE : `endMembership`
 *
 * Toutes les sorties passent par la sortie de Duo existante (`endMembership`) :
 *   · REMOVED → DUO_MEMBERSHIP_ENDED : « Retirer » par le titulaire,
 *     `endDuoSharing` (changement d'offre Stripe / BO, passage Standard),
 *     `closeDuoForWithdrawal` (rétractation, lot 63), suppression du compte
 *     titulaire ;
 *   · LEFT → DUO_MEMBERSHIP_LEFT (lot 65A) : le membre quitte lui-même le Duo
 *     (« Quitter le Duo », `leaveDuo` ; ancienne route `DuoService.leaveDuo`).
 *     GABARIT DÉDIÉ plutôt qu'une variante : le message n'est pas le même
 *     (confirmation de SON action, « si vous n'êtes pas à l'origine… »), le
 *     BO › Communications doit pouvoir les relire et les modifier séparément,
 *     et le journal des envois les distingue sans lire le contexte.
 * La demande d'e-mail est enregistrée DANS la transaction de la sortie, sous
 * un point de sauvegarde :
 *   · sortie validée ⇒ demande enregistrée (rien ne se perd entre les deux) ;
 *   · échec de l'enregistrement (migration absente, erreur base) ⇒ point de
 *     sauvegarde annulé, la sortie se poursuit normalement (jamais bloquée).
 * L'envoi lui-même est fait par la tâche planifiée interne
 * `transactional-emails-retry` (file durable du lot 57A : au plus une minute
 * d'attente, reprises bornées, journal, BO › Communications). Aucun appel au
 * fournisseur n'a lieu pendant la sortie (webhook Stripe, suppression…).
 *
 * PAS D'E-MAIL :
 *   · le membre quitte le Duo en SUPPRIMANT SON PROPRE COMPTE (`notify:
 *     false`, suppression volontaire et balayage des suppressions) : il reçoit
 *     déjà l'e-mail de suppression de compte — pas de doublon ;
 *   · invitation annulée d'une personne non inscrite (pas de membership) ;
 *   · impayé simple : le Duo n'est pas fermé, `endMembership` n'est pas appelé ;
 *   · membership déjà sorti (sortie rejouée : webhook rejoué, reprise) ;
 *   · le titulaire lui-même.
 *
 * IDEMPOTENCE : une sortie = un membership × sa date d'entrée dans le Duo
 * (`joined_at`). Rejouée, la même sortie ne crée pas de seconde demande
 * (verrou consultatif + NOT EXISTS, index unique 0459 en plus) ; une
 * nouvelle adhésion puis une nouvelle sortie donnent un nouvel e-mail. Le
 * membership est lu ACTIF sous verrou de ligne : une sortie n'est jamais à la
 * fois REMOVED et LEFT, donc jamais deux e-mails pour la même sortie.
 *
 * `duo_id` de la demande reste NULL (identifiant du Duo dans le contexte) :
 * la suppression définitive du titulaire, qui efface son Duo en cascade,
 * n'efface pas une demande pas encore aboutie. Le destinataire (`user_id`)
 * est le membre : son propre effacement annule logiquement l'envoi.
 *
 * DISCRÉTION : le contexte ne garde que le PRÉNOM du titulaire (jamais son
 * e-mail) et aucun motif de fermeture.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql } from 'drizzle-orm';

export const DUO_MEMBERSHIP_ENDED = 'DUO_MEMBERSHIP_ENDED' as const;
/** Lot 65A : le membre a quitté lui-même le Duo. */
export const DUO_MEMBERSHIP_LEFT = 'DUO_MEMBERSHIP_LEFT' as const;

/** Clé d'idempotence d'une sortie (membership × date d'entrée). */
export function duoMembershipEndedKey(membershipId: number, since: string): string {
  return `duo-membership-ended:${membershipId}:${since}`;
}

/** Clé d'idempotence d'un départ volontaire (membership × date d'entrée). */
export function duoMembershipLeftKey(membershipId: number, since: string): string {
  return `duo-membership-left:${membershipId}:${since}`;
}

/** Transaction Drizzle (ou point de sauvegarde) : seule `execute` est utilisée. */
interface Tx {
  transaction<T>(cb: (sp: Tx) => Promise<T>): Promise<T>;
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] })?.rows ?? []));

interface DuoMembershipEndedEnqueue {
  jobId: number | null;
  /** Motif d'absence de demande (diagnostic, tests). */
  skipped?: 'SILENT' | 'NOT_ACTIVE' | 'OWNER' | 'NOT_FOUND' | 'DUPLICATE' | 'ERROR';
}

/**
 * Enregistre la demande d'e-mail d'une sortie, dans la transaction de la
 * sortie : REMOVED → DUO_MEMBERSHIP_ENDED, LEFT → DUO_MEMBERSHIP_LEFT.
 * `notify: false` (départ par suppression de son propre compte) : rien.
 * À appeler AVANT la mise à jour du membership (lecture verrouillée de son
 * état d'origine). Ne lève jamais.
 */
export async function enqueueDuoMembershipEndedEmail(
  tx: Tx,
  p: { duoId: number; membershipId: number; memberUserId: number; status: 'REMOVED' | 'LEFT'; notify?: boolean },
): Promise<DuoMembershipEndedEnqueue> {
  if (p.notify === false) return { jobId: null, skipped: 'SILENT' };
  const kind = p.status === 'LEFT' ? DUO_MEMBERSHIP_LEFT : DUO_MEMBERSHIP_ENDED;
  try {
    return await tx.transaction(async (sp) => {
      const [m] = rowsOf<{
        status: string; user_id: number; since: string; owner_id: number | null; owner_first_name: string | null; member_email: string | null;
      }>(await sp.execute(sql`
        SELECT m.status, m.user_id, extract(epoch FROM COALESCE(m.joined_at, m.invited_at, m.created_at))::text AS since,
               d.billing_owner_user_id AS owner_id, o.first_name AS owner_first_name, u.email AS member_email
          FROM duo_memberships m
          JOIN duo_accounts d ON d.id = m.duo_id
          JOIN users u ON u.id = m.user_id
          LEFT JOIN users o ON o.id = d.billing_owner_user_id
         WHERE m.id = ${p.membershipId} AND m.duo_id = ${p.duoId}
         FOR UPDATE OF m`));
      if (!m || Number(m.user_id) !== p.memberUserId || !m.member_email) return { jobId: null, skipped: 'NOT_FOUND' as const };
      if (m.owner_id != null && Number(m.owner_id) === p.memberUserId) return { jobId: null, skipped: 'OWNER' as const };
      if (m.status !== 'ACTIVE') return { jobId: null, skipped: 'NOT_ACTIVE' as const };

      const key = kind === DUO_MEMBERSHIP_LEFT ? duoMembershipLeftKey(p.membershipId, m.since) : duoMembershipEndedKey(p.membershipId, m.since);
      // Émetteur : le titulaire (fin subie) ou le membre lui-même (son départ).
      const triggeredBy = kind === DUO_MEMBERSHIP_LEFT ? p.memberUserId : m.owner_id;
      await sp.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`email-job:${kind}:${key}`}))`);
      const context = { duoId: p.duoId, membershipId: p.membershipId, ownerFirstName: (m.owner_first_name ?? '').trim() };
      const [row] = rowsOf<{ id: number }>(await sp.execute(sql`
        INSERT INTO transactional_email_jobs
               (kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, dedupe_key, status, attempts,
                max_attempts, next_attempt_at, created_at, updated_at)
        SELECT ${kind}, ${p.memberUserId}, NULL, ${triggeredBy}, ${m.member_email}, ${JSON.stringify(context)}::jsonb,
               ${key}, 'pending', 0, 6, now(), now(), now()
         WHERE NOT EXISTS (SELECT 1 FROM transactional_email_jobs WHERE dedupe_key = ${key})
        RETURNING id`));
      return row ? { jobId: Number(row.id) } : { jobId: null, skipped: 'DUPLICATE' as const };
    });
  } catch (e) {
    // Jamais bloquant : la sortie de Duo se poursuit (point de sauvegarde annulé).
    console.error(`[duo] e-mail ${kind} non enregistré :`, (e as Error)?.message ?? e);
    return { jobId: null, skipped: 'ERROR' };
  }
}
