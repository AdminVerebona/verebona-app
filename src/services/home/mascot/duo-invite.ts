/**
 * Mascotte — « Inviter quelqu'un » pour un nouvel abonné Premium Duo
 * (lot 49A, ticket 13).
 *
 * Lot 54F : limité au PREMIER MOIS de l'abonnement Duo et trace durable du
 * premier envoi (voir plus bas).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Le titulaire (payeur) d'un abonnement Premium Duo actif qui n'a encore
 * invité personne se voit proposer EN PREMIER « Inviter quelqu'un ».
 *
 *   condition   le Duo du compte dont le titulaire est le payeur, statut
 *               d'abonnement ACTIVE (ou TRIALING hérité), AUCUNE invitation
 *               envoyée pour cette souscription (`duo_first_invite_sent_at`,
 *               trace durable que l'annulation ou l'expiration du lien
 *               n'effacent pas ; `pending_invite_email` en filet), AUCUN autre
 *               membre de cette souscription (invité ou actif, ou parti /
 *               retiré depuis son début) et maintenant STRICTEMENT avant
 *               `duo_subscription_started_at` + 1 mois calendaire (lot 54F) ;
 *               sans date de début fiable : jamais proposée ;
 *   disparition au premier de ces événements : invitation envoyée, membre
 *               présent, mois écoulé, offre perdue — relu à chaque calcul
 *               de la prise de parole, aucun état propre à la mascotte ni
 *               traitement planifié ;
 *   date        `duo_subscription_started_at` est posée par la base
 *               (déclencheur 0385) au passage effectif de l'abonnement Duo
 *               à ACTIVE/TRIALING depuis un état hors offre : Checkout,
 *               Premium → Duo, synchronisation Stripe, webhooks, BO. Les
 *               renouvellements, rejeux, resynchronisations, impayés
 *               régularisés et changements de périodicité ne la décalent pas ;
 *   hiérarchie  compte comme une action « À faire en premier » : avec elle,
 *               au plus UNE action DO_FIRST de la file (MASC3 : deux au
 *               plus au total) ;
 *   clic        parcours d'invitation EXISTANT (« Mon compte » › « 2e
 *               utilisateur Duo », `DuoInvitationPanel`), rien n'est écrit.
 *
 * Lu À CÔTÉ du collecteur (`collector.ts` inchangé) ; une lecture en échec
 * vaut « rien à proposer » (jamais une panne de la mascotte).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { MascotDuoInvite } from './types';

/** Ancre du panneau d'invitation existant (page « Mon compte »). */
export const DUO_INVITE_ANCHOR = 'duo-invitation';
export const DUO_INVITE_HREF = `/mon-compte#${DUO_INVITE_ANCHOR}`;

/** Statuts d'abonnement Duo qui permettent d'inviter. */
const INVITABLE_STATUSES = new Set(['ACTIVE', 'TRIALING']);

/** Fuseau des « mois calendaires » de Verebona. */
const TZ = 'Europe/Paris';

export interface DuoInviteRow {
  subscriptionStatus: string;
  pendingInviteEmail: string | null;
  /** Adhésions d'un AUTRE utilisateur que le payeur, pour cette souscription. */
  memberships: number;
  /** Début effectif de l'abonnement Duo (lot 54F) ; `null` : inconnu. */
  startedAt: Date | string | null;
  /** Premier envoi d'invitation de cette souscription (lot 54F). */
  firstInviteSentAt: Date | string | null;
}

function parisParts(d: Date): number[] {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return [v('year'), v('month'), v('day'), v('hour'), v('minute'), v('second')];
}

/** Décalage (ms) de l'heure de Paris sur UTC à l'instant `ms`. */
function parisOffset(ms: number): number {
  const [y, mo, d, h, mi, s] = parisParts(new Date(ms));
  return Date.UTC(y, mo - 1, d, h, mi, s) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * Début + 1 mois calendaire (heure de Paris) : même jour et même heure du
 * mois suivant, ramené au dernier jour du mois s'il n'existe pas (31 janvier
 * → 28/29 février). Pure.
 */
export function addOneCalendarMonth(start: Date): Date {
  const [y, mo, d, h, mi, s] = parisParts(start);
  const ms = start.getTime() - Math.floor(start.getTime() / 1000) * 1000;
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const wall = Date.UTC(y, mo, Math.min(d, lastDay), h, mi, s, ms);
  // Heure murale de Paris → instant UTC (deux passes : changement d'heure).
  let utc = wall - parisOffset(wall);
  utc = wall - parisOffset(utc);
  return new Date(utc);
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** L'action à proposer à l'instant `now`, ou `null` (pure). */
export function duoInviteFrom(row: DuoInviteRow | null | undefined, now: Date = new Date()): MascotDuoInvite | null {
  if (!row) return null;
  if (!INVITABLE_STATUSES.has(String(row.subscriptionStatus ?? '').toUpperCase())) return null;
  if (row.pendingInviteEmail && row.pendingInviteEmail.trim() !== '') return null;
  if (toDate(row.firstInviteSentAt)) return null;
  if (row.memberships > 0) return null;
  // Lot 54F : premier mois de l'abonnement Duo seulement ; sans date fiable,
  // rien (aucune période d'invitation relancée artificiellement).
  const startedAt = toDate(row.startedAt);
  if (!startedAt) return null;
  if (!(now.getTime() < addOneCalendarMonth(startedAt).getTime())) return null;
  return {
    href: DUO_INVITE_HREF,
    title: 'Inviter quelqu’un',
    subtitle: 'Partagez votre espace Premium Duo',
    cta: 'Inviter',
  };
}

/** Lecture (serveur) : le Duo du compte, dont le titulaire du compte est le payeur. */
export async function readDuoInvite(accountId: number, now: Date = new Date()): Promise<MascotDuoInvite | null> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    // Le Duo du compte (`accounts.duo_account_id`) dont le titulaire du compte
    // est le payeur ; le payeur a lui-même une adhésion (slot 0) : seules
    // comptent celles d'un AUTRE utilisateur — invité ou actif, ou sorti
    // pendant la souscription en cours (un membre d'un Duo précédent, sorti
    // avant son début, ne compte plus).
    `SELECT d.subscription_status AS "subscriptionStatus", d.pending_invite_email AS "pendingInviteEmail",
            d.duo_subscription_started_at AS "startedAt", d.duo_first_invite_sent_at AS "firstInviteSentAt",
            (SELECT COUNT(*) FROM duo_memberships m
              WHERE m.duo_id = d.id AND m.user_id <> d.billing_owner_user_id
                AND (m.status IN ('INVITED', 'ACTIVE') OR m.left_at IS NULL
                     OR d.duo_subscription_started_at IS NULL OR m.left_at >= d.duo_subscription_started_at))::int AS memberships
       FROM accounts a
       JOIN duo_accounts d ON d.id = a.duo_account_id AND d.billing_owner_user_id = a.owner_user_id
      WHERE a.id = $1
      LIMIT 1`,
    [accountId],
  )) as unknown as Array<{ subscriptionStatus: string; pendingInviteEmail: string | null; memberships: number; startedAt: Date | string | null; firstInviteSentAt: Date | string | null }>;
  const r = rows[0];
  return duoInviteFrom(r ? {
    subscriptionStatus: r.subscriptionStatus,
    pendingInviteEmail: r.pendingInviteEmail,
    memberships: Number(r.memberships ?? 0),
    startedAt: r.startedAt ?? null,
    firstInviteSentAt: r.firstInviteSentAt ?? null,
  } : null, now);
}
