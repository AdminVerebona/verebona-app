/**
 * Fiche utilisateur : données de support — CDC Back-Office V1 §6.2
 * (rôle titulaire / second, rattachement, désactivations, préférences,
 * invitations, historique des communications COM-014, historique de
 * connexions USR-D01 / USR-D02 / REC-USR-05) et USR-A01 (renvoi
 * d'invitation).
 *
 * Lecture seule sauf `resendInvitation`. Les sessions actives ne sont jamais
 * listées (USR-D03).
 */
import crypto from 'crypto';
import { pgClient } from '@/db';

/** USR-D01 / REC-USR-05 : fenêtre de l'historique de connexion. */
export const LOGIN_HISTORY_DAYS = 90;
export const COMMUNICATION_HISTORY_LIMIT = 100;
/** Même durée de validité que l'invitation Duo émise par l'utilisateur. */
export const DUO_INVITE_TTL_DAYS = 7;

// ── Fonctions pures ─────────────────────────────────────────────────────────

/**
 * USR-D02 : IP tronquée. IPv4 → trois premiers octets (« 192.168.1.x ») ;
 * IPv6 → trois premiers groupes. Les en-têtes multi-valeurs (proxy) ne
 * gardent que la première adresse.
 */
export function truncateIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ip = raw.split(',')[0].trim();
  if (!ip || ip === 'unknown') return null;
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    return `${v4.split('.').slice(0, 3).join('.')}.x`;
  }
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean).slice(0, 3);
    return `${groups.join(':')}:…`;
  }
  return null;
}

/** USR-D02 : appareil / navigateur lisible depuis un User-Agent. */
export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (!browser && !os) return 'Autre';
  return [browser, os].filter(Boolean).join(' · ');
}

export type MemberRole = 'holder' | 'second' | 'member';

/** Rôle dans le compte : titulaire, second utilisateur (Duo) ou membre. */
export function memberRole(input: { isAccountOwner: boolean; membershipRole: string | null; isDuoSecond: boolean }): MemberRole {
  if (input.isAccountOwner || input.membershipRole === 'owner') return 'holder';
  if (input.isDuoSecond || input.membershipRole === 'member' || input.membershipRole === 'admin') return 'second';
  return 'member';
}

export type CommunicationStatus = 'sent' | 'failed' | 'pending' | 'skipped';

/** Statut normalisé d'un envoi (e-mail ou notification). */
export function normalizeCommunicationStatus(raw: string | null | undefined): CommunicationStatus {
  const s = (raw ?? '').toLowerCase();
  if (['sent', 'delivered', 'success', 'ok'].includes(s)) return 'sent';
  if (['failed', 'error', 'bounced', 'expired'].includes(s)) return 'failed';
  if (s.startsWith('skipped') || s === 'disabled' || s === 'suppressed') return 'skipped';
  return 'pending';
}

export interface DuoInvitationState {
  pendingInviteEmail: string | null;
  pendingInviteToken: string | null;
  hasActiveSecond: boolean;
  duoStatus: string | null;
}

/**
 * USR-A01 : une invitation Duo est réémissible si elle est en attente (e-mail
 * et jeton présents, expirée ou non), qu'aucun second utilisateur n'est actif
 * et que le Duo n'est pas terminé. `null` si réémissible, sinon le motif.
 */
export function duoInvitationBlockReason(state: DuoInvitationState): string | null {
  if (!state.pendingInviteEmail || !state.pendingInviteToken) return 'Aucune invitation en attente.';
  if (state.hasActiveSecond) return 'Le second utilisateur a déjà rejoint le compte.';
  const st = (state.duoStatus ?? '').toUpperCase();
  if (st === 'CANCELED' || st === 'CANCELLED' || st === 'ENDED' || st === 'TERMINATED') {
    return 'L’abonnement Premium Duo n’est plus actif.';
  }
  return null;
}

// ── Chargement ──────────────────────────────────────────────────────────────

export interface UserMembershipInfo {
  accountId: number;
  accountName: string;
  role: MemberRole;
  joinedAt: string | null;
}

export interface StatusChange {
  at: string;
  action: 'deactivated' | 'reactivated';
  adminEmail: string | null;
}

export interface UserInvitation {
  kind: 'duo' | 'account';
  direction: 'sent' | 'received';
  email: string;
  sentAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  status: 'pending' | 'accepted' | 'declined' | 'removed';
  reissuable: boolean;
  blockReason: string | null;
  duoId: number | null;
}

export interface CommunicationEntry {
  at: string;
  channel: 'email' | 'push' | 'in_app';
  type: string;
  status: CommunicationStatus;
}

export interface LoginEntry {
  at: string;
  device: string | null;
  ip: string | null;
  /**
   * Lot 53A (retour PO D1, traçabilité) : connexion réussie, échec (mot de
   * passe faux…) ou pause anti-force brute déclenchée.
   */
  result: LoginResult;
  /** Libellé du motif (échec, règle de la pause), sans donnée technique. */
  detail: string | null;
}

/** Lot 79C : `session_revoked` — sessions révoquées par précaution (jeton de renouvellement réutilisé). */
export type LoginResult = 'success' | 'failure' | 'throttled' | 'session_revoked';

const FAILURE_LABELS: Record<string, string> = {
  invalid_password: 'Mot de passe incorrect',
  account_suspended: 'Utilisateur suspendu',
  account_suspended_by_admin: 'Compte suspendu',
  account_deleted: 'Compte supprimé',
  email_not_verified: 'Adresse non vérifiée',
};

const THROTTLE_LABELS: Record<string, string> = {
  trusted_device: 'Pause sur un appareil reconnu',
  origin: 'Pause de l’adresse IP (tous comptes)',
  origin_identifier: 'Ralentissement (cette IP, cette adresse)',
  identifier_untrusted: 'Pause des appareils non reconnus (attaque possible)',
};

/** Libellé lisible d'une ligne du journal de connexion (pur, testé). */
/** « 45 s », « 3 min », « 2 h 05 » (pure). */
export function formatRotationAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export function describeLoginActivity(activityType: string, rawDetails: string | null | undefined): { result: LoginResult; detail: string | null } {
  let d: Record<string, unknown> = {};
  try { d = rawDetails ? JSON.parse(rawDetails) : {}; } catch { d = {}; }
  const trusted = d.trustedDevice === true ? ' · appareil reconnu' : '';
  if (activityType === 'AUTH_LOGIN_THROTTLED') {
    const minutes = typeof d.retryAfterSeconds === 'number' ? Math.max(1, Math.ceil(d.retryAfterSeconds / 60)) : null;
    const label = THROTTLE_LABELS[String(d.rule)] ?? 'Pause anti-force brute';
    return { result: 'throttled', detail: `${label}${minutes ? ` — ${minutes} min` : ''}` };
  }
  if (activityType === 'LOGIN_FAILED') {
    return { result: 'failure', detail: `${FAILURE_LABELS[String(d.reason)] ?? 'Échec'}${trusted}` };
  }
  // Lot 79C (diagnostic des déconnexions, sans SQL) : l'âge de la rotation
  // distingue une réponse perdue (quelques dizaines de secondes à minutes)
  // d'un jeton rejoué longtemps après — sans rien conclure à lui seul.
  if (activityType === 'AUTH_TOKEN_REUSE_DETECTED') {
    const age = typeof d.rotationAgeMs === 'number' ? formatRotationAge(d.rotationAgeMs) : null;
    return {
      result: 'session_revoked',
      detail: `Sessions révoquées par précaution : ancien jeton présenté${age ? ` ${age} après son renouvellement` : ''}${d.sessionsRevoked === false ? ' (révocation non confirmée)' : ''}`,
    };
  }
  return { result: 'success', detail: d.trustedDevice === false ? 'Premier succès sur cet appareil' : null };
}

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/**
 * Comptes actifs de l'utilisateur, rôle lu dans `account_memberships`.
 *
 * Lot 74B (point 6) : le rôle « second utilisateur » venait de
 * `duo_memberships` (slot 1) et s'appliquait à TOUS les comptes de
 * l'utilisateur, y compris son espace personnel. Depuis le lot 72D,
 * `account_memberships` est la source de vérité (double écriture
 * `duo_memberships` inchangée) : titulaire = rôle `owner` (ou titulaire
 * historique `owner_user_id`), sinon membre.
 */
export async function loadUserMemberships(userId: number): Promise<UserMembershipInfo[]> {
  const rows = await pgClient.unsafe<Row[]>(
    `SELECT a.id AS account_id, a.name AS account_name, a.owner_user_id, m.role, m.joined_at, m.created_at
       FROM account_memberships m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY (m.role = 'owner') DESC, m.joined_at ASC NULLS LAST`,
    [userId],
  );
  return rows.map((r) => ({
    accountId: Number(r.account_id),
    accountName: String(r.account_name ?? ''),
    role: memberRole({
      isAccountOwner: Number(r.owner_user_id) === userId,
      membershipRole: (r.role as string) ?? null,
      isDuoSecond: false,
    }),
    joinedAt: iso(r.joined_at ?? r.created_at),
  }));
}

/** Lot 74B : adhésion à un Premium Duo, lue dans `account_memberships`. */
export interface UserDuoMembership {
  accountId: number;
  accountName: string;
  role: 'owner' | 'member';
  /** « Titulaire » / « Membre ». */
  roleLabel: string;
  /** Statut de l'adhésion : active | pending | left | removed | declined. */
  status: string;
  statusLabel: string;
  /** Statut de l'abonnement Duo du compte (`duo_accounts`), s'il existe. */
  duoStatus: string | null;
  duoStatusLabel: string | null;
  since: string | null;
  endedAt: string | null;
}

const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  active: 'Actif',
  pending: 'Invitation en attente',
  left: 'Parti',
  removed: 'Retiré',
  declined: 'Invitation refusée',
};

const DUO_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Abonnement actif',
  UNPAID_RECOVERY: 'Impayé (régularisation en cours)',
  INACTIVE: 'Abonnement inactif',
  PENDING: 'Abonnement en attente',
  CANCELED: 'Abonnement résilié',
  CANCELLED: 'Abonnement résilié',
  WITHDRAWN: 'Rétractation',
};

/** Libellés lisibles d'une adhésion Duo (pur, testé). */
export function duoMembershipLabels(role: string, status: string, duoStatus: string | null): { roleLabel: string; statusLabel: string; duoStatusLabel: string | null } {
  const st = status.toLowerCase();
  const ds = duoStatus ? duoStatus.toUpperCase() : null;
  return {
    roleLabel: role === 'owner' ? 'Titulaire' : 'Membre',
    statusLabel: MEMBERSHIP_STATUS_LABELS[st] ?? status,
    duoStatusLabel: ds ? (DUO_STATUS_LABELS[ds] ?? ds) : null,
  };
}

/**
 * Lot 74B (point 6) : adhésions de l'utilisateur aux comptes Premium Duo
 * (rôle titulaire / membre, statut — y compris départ ou retrait), lues
 * dans `account_memberships`. Un compte est « Duo » s'il porte l'offre
 * PREMIUM_DUO ou un Duo (lien 0520 `duo_accounts.account_id`, ou
 * `accounts.duo_account_id`). Lecture seule.
 */
export async function loadUserDuoMemberships(userId: number): Promise<UserDuoMembership[]> {
  const rows = await pgClient.unsafe<Row[]>(
    `SELECT a.id AS account_id, a.name AS account_name, m.role, m.status, m.joined_at, m.invited_at, m.removed_at,
            (SELECT d.subscription_status FROM duo_accounts d
              WHERE d.account_id = a.id OR d.id = a.duo_account_id
              ORDER BY (d.account_id = a.id) DESC NULLS LAST, d.id DESC LIMIT 1) AS duo_status
       FROM account_memberships m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.user_id = $1
        AND m.role IN ('owner', 'member', 'admin')
        AND m.status IN ('active', 'pending', 'left', 'removed')
        AND (upper(coalesce(a.plan_type, '')) = 'PREMIUM_DUO'
          OR a.duo_account_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM duo_accounts d WHERE d.account_id = a.id))
      ORDER BY (m.status = 'active') DESC, coalesce(m.joined_at, m.invited_at) DESC NULLS LAST`,
    [userId],
  );
  return rows.map((r) => {
    const role = r.role === 'owner' ? 'owner' : 'member';
    const status = String(r.status);
    const duoStatus = (r.duo_status as string) ?? null;
    return {
      accountId: Number(r.account_id),
      accountName: String(r.account_name ?? ''),
      role,
      ...duoMembershipLabels(role, status, duoStatus),
      status,
      duoStatus,
      since: iso(r.joined_at ?? r.invited_at),
      endedAt: iso(r.removed_at),
    };
  });
}

/**
 * Lot 74B — diagnostic de transition : l'utilisateur est membre ACTIF d'un
 * Duo dans l'ancienne table (`duo_memberships`, slot 1) SANS adhésion active
 * au compte de ce Duo. Cas d'un Duo antérieur au lot 72D tant que le
 * rattrapage BO « duo-shared-account » n'est pas appliqué : la fiche le
 * signale au lieu de n'afficher aucun Duo.
 */
export async function hasLegacyDuoWithoutMembership(userId: number): Promise<boolean> {
  const [r] = await pgClient.unsafe<Row[]>(
    `SELECT EXISTS (
       SELECT 1 FROM duo_memberships dm JOIN duo_accounts d ON d.id = dm.duo_id
        WHERE dm.user_id = $1 AND dm.status = 'ACTIVE' AND d.billing_owner_user_id <> $1
          AND NOT EXISTS (SELECT 1 FROM account_memberships am JOIN accounts a ON a.id = am.account_id
                           WHERE am.user_id = $1 AND am.status = 'active'
                             AND (a.id = d.account_id OR a.duo_account_id = d.id))) AS anomaly`,
    [userId],
  );
  return Boolean(r?.anomaly);
}

/** Dates de désactivation / réactivation (journal technique AUD-003). */
export async function loadStatusChanges(userId: number): Promise<StatusChange[]> {
  const rows = await pgClient.unsafe<Row[]>(
    `SELECT timestamp, action_type, admin_email FROM admin_audit_log
      WHERE target_type = 'USER' AND target_id = $1
        AND action_type IN ('USER_SUSPEND', 'USER_REACTIVATE')
        AND (result IS NULL OR result = 'SUCCESS')
      ORDER BY timestamp DESC LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({
    at: iso(r.timestamp)!,
    action: r.action_type === 'USER_SUSPEND' ? 'deactivated' : 'reactivated',
    adminEmail: (r.admin_email as string) ?? null,
  }));
}

export async function loadInvitations(userId: number, email: string, now = new Date()): Promise<UserInvitation[]> {
  const out: UserInvitation[] = [];
  const duoRows = await pgClient.unsafe<Row[]>(
    `SELECT d.id, d.billing_owner_user_id, d.subscription_status, d.pending_invite_email, d.pending_invite_token,
            d.pending_invite_sent_at, d.pending_invite_token_expires_at,
            -- Lot 74B : second utilisateur actif lu dans account_memberships (compte
            -- du Duo) ; l'ancienne table reste consultée tant que le rattrapage
            -- duo-shared-account n'est pas appliqué (jamais de réémission indue).
            (EXISTS (SELECT 1 FROM account_memberships am JOIN accounts a2 ON a2.id = am.account_id
                      WHERE (a2.id = d.account_id OR a2.duo_account_id = d.id)
                        AND am.role <> 'owner' AND am.status = 'active')
             OR EXISTS (SELECT 1 FROM duo_memberships dm WHERE dm.duo_id = d.id AND dm.slot = 1 AND dm.status = 'ACTIVE')) AS has_second
       FROM duo_accounts d
      WHERE d.pending_invite_email IS NOT NULL
        AND (d.billing_owner_user_id = $1 OR lower(d.pending_invite_email) = lower($2))`,
    [userId, email],
  );
  for (const r of duoRows) {
    const expiresAt = iso(r.pending_invite_token_expires_at);
    const blockReason = duoInvitationBlockReason({
      pendingInviteEmail: (r.pending_invite_email as string) ?? null,
      pendingInviteToken: (r.pending_invite_token as string) ?? null,
      hasActiveSecond: Boolean(r.has_second),
      duoStatus: (r.subscription_status as string) ?? null,
    });
    out.push({
      kind: 'duo',
      direction: Number(r.billing_owner_user_id) === userId ? 'sent' : 'received',
      email: String(r.pending_invite_email),
      sentAt: iso(r.pending_invite_sent_at),
      expiresAt,
      expired: !!expiresAt && new Date(expiresAt) < now,
      status: 'pending',
      reissuable: blockReason === null,
      blockReason,
      duoId: Number(r.id),
    });
  }
  // Invitations de compte (parcours historique) : consultables, non
  // réémissibles depuis le BO — le parcours d'acceptation n'existe plus en V1.
  const accRows = await pgClient.unsafe<Row[]>(
    `SELECT m.invited_email, m.invited_by, m.status, m.invited_at, m.invite_token_expires_at, u.email AS user_email
       FROM account_memberships m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.invited_by IS NOT NULL
        AND (m.invited_by = $1 OR m.user_id = $1 OR lower(m.invited_email) = lower($2))
        AND NOT (m.role = 'owner')
      ORDER BY m.invited_at DESC NULLS LAST LIMIT 20`,
    [userId, email],
  );
  for (const r of accRows) {
    const expiresAt = iso(r.invite_token_expires_at);
    const rawStatus = String(r.status);
    const status: UserInvitation['status'] =
      rawStatus === 'active' ? 'accepted' : rawStatus === 'declined' ? 'declined' : rawStatus === 'removed' ? 'removed' : 'pending';
    out.push({
      kind: 'account',
      direction: Number(r.invited_by) === userId ? 'sent' : 'received',
      email: String(r.invited_email ?? r.user_email ?? ''),
      sentAt: iso(r.invited_at),
      expiresAt,
      expired: !!expiresAt && new Date(expiresAt) < now,
      status,
      reissuable: false,
      blockReason: 'Invitation de l’ancien parcours de partage : non réémissible.',
      duoId: null,
    });
  }
  return out;
}

/** Ligne brute de l'historique, avant dédoublonnage (COM-014). */
export interface RawCommunicationRow {
  source: 'email_log' | 'delivery';
  at: Date | string | null;
  channel: string;
  /** Code de gabarit (`email_logs`) ou type d'événement (`notification_outbox`). */
  type: string | null;
  status: string | null;
}

/** Écart maximal entre la ligne `email_logs` et la livraison e-mail du même envoi. */
export const EMAIL_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Un e-mail envoyé par le moteur de notifications laisse DEUX traces : une
 * livraison `notification_deliveries` (canal `email`) et la ligne
 * `email_logs` écrite par le service d'e-mail, avec un gabarit `notif_*`.
 * On garde la livraison (type d'événement métier, statuts « ignoré ») et on
 * retire la ligne `email_logs` appariée : même utilisateur (déjà filtré),
 * gabarit `notif_*`, horodatage à moins de 10 min. Chaque livraison n'absorbe
 * qu'une ligne (appariement un pour un), pour ne pas masquer un second envoi
 * réel. Pur.
 */
export function dedupeCommunicationRows(rows: RawCommunicationRow[]): RawCommunicationRow[] {
  const time = (r: RawCommunicationRow) => (r.at ? new Date(r.at).getTime() : NaN);
  const deliveries = rows
    .filter((r) => r.source === 'delivery' && r.channel === 'email' && Number.isFinite(time(r)))
    .map((r) => ({ t: time(r), used: false }));
  const out: RawCommunicationRow[] = [];
  for (const r of rows) {
    if (r.source === 'email_log' && /^notif_/i.test(r.type ?? '') && Number.isFinite(time(r))) {
      const t = time(r);
      let best: { t: number; used: boolean } | null = null;
      for (const d of deliveries) {
        if (d.used || Math.abs(d.t - t) > EMAIL_DEDUP_WINDOW_MS) continue;
        if (!best || Math.abs(d.t - t) < Math.abs(best.t - t)) best = d;
      }
      if (best) {
        best.used = true;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

/** COM-014 : historique individuel (date, canal, type, statut), sans motif technique (COM-015). */
export async function loadCommunications(userId: number, labelOf: (code: string) => string): Promise<CommunicationEntry[]> {
  const rows = await pgClient.unsafe<RawCommunicationRow[]>(
    `(SELECT 'email_log' AS source, e.sent_at AS at, 'email' AS channel, e.template_code AS type, e.status
        FROM email_logs e WHERE e.recipient_user_id = $1
       ORDER BY e.sent_at DESC NULLS LAST LIMIT ${COMMUNICATION_HISTORY_LIMIT * 2})
     UNION ALL
     (SELECT 'delivery' AS source, coalesce(d.sent_at, d.attempted_at, d.created_at) AS at,
             CASE d.channel WHEN 'bell' THEN 'in_app' ELSE d.channel END AS channel,
             o.event_type AS type, d.status
        FROM notification_deliveries d
        JOIN notification_outbox o ON o.id = d.outbox_id
       WHERE d.user_id = $1
       ORDER BY coalesce(d.sent_at, d.attempted_at, d.created_at) DESC NULLS LAST
       LIMIT ${COMMUNICATION_HISTORY_LIMIT * 2})`,
    [userId],
  );
  // Dédoublonnage avant tri et limite : un doublon ne doit pas évincer une
  // communication distincte de la fenêtre affichée.
  return dedupeCommunicationRows(rows)
    .filter((r) => r.at)
    .sort((x, y) => new Date(y.at!).getTime() - new Date(x.at!).getTime())
    .slice(0, COMMUNICATION_HISTORY_LIMIT)
    .map((r) => ({
      at: iso(r.at)!,
      channel: r.channel as CommunicationEntry['channel'],
      type: labelOf(String(r.type ?? '')),
      status: normalizeCommunicationStatus(r.status as string),
    }));
}

/**
 * USR-D01 : connexions réussies sur 90 jours ; USR-D02 : appareil, IP
 * tronquée. Lot 53A (retour PO D1) : s'y ajoutent les ÉCHECS et les PAUSES
 * anti-force brute visant ce compte (traçabilité, sans requête SQL).
 */
export async function loadLoginHistory(userId: number, now = new Date()): Promise<LoginEntry[]> {
  const since = new Date(now.getTime() - LOGIN_HISTORY_DAYS * 24 * 3600 * 1000);
  const rows = await pgClient.unsafe<Row[]>(
    `SELECT timestamp, ip_address, user_agent, activity_type, details FROM user_activity_log
      WHERE user_id = $1 AND timestamp >= $2
        AND (activity_type IN ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'AUTH_LOGIN_THROTTLED')
             -- Lot 79C : révocations globales seulement (pas les refus simples).
             OR (activity_type = 'AUTH_TOKEN_REUSE_DETECTED' AND details LIKE '%"severity":"security_incident"%'))
      ORDER BY timestamp DESC LIMIT 500`,
    [userId, since.toISOString()],
  );
  return rows.map((r) => ({
    at: iso(r.timestamp)!,
    device: describeUserAgent(r.user_agent as string),
    ip: truncateIp(r.ip_address as string),
    ...describeLoginActivity(String(r.activity_type ?? 'LOGIN_SUCCESS'), r.details as string | null),
  }));
}

// ── USR-A01 : renvoi d'invitation ───────────────────────────────────────────

export type ResendResult =
  | { ok: true; email: string; renewed: boolean; duoId: number; emailStatus: 'accepted' | 'queued' | 'failed'; emailError: string | null }
  | { ok: false; code: 'NO_INVITATION' | 'NOT_REISSUABLE'; message: string };

/**
 * Renvoie l'invitation Duo liée à l'utilisateur (émise par lui, ou reçue à
 * son adresse). Même e-mail `DUO_INVITATION` que le parcours utilisateur ; un
 * jeton expiré est renouvelé (nouveau jeton, nouvelle échéance), un jeton
 * valide est conservé. Le destinataire n'est jamais modifié.
 */
export async function resendInvitation(userId: number, appUrl: string, now = new Date()): Promise<ResendResult> {
  const [user] = await pgClient.unsafe<{ email: string }[]>(`SELECT email FROM users WHERE id = $1`, [userId]);
  if (!user) return { ok: false, code: 'NO_INVITATION', message: 'Utilisateur introuvable.' };
  const invitations = (await loadInvitations(userId, user.email, now)).filter((i) => i.kind === 'duo');
  if (invitations.length === 0) {
    return { ok: false, code: 'NO_INVITATION', message: 'Aucune invitation liée à cet utilisateur.' };
  }
  const target = invitations.find((i) => i.reissuable);
  if (!target || target.duoId == null) {
    return { ok: false, code: 'NOT_REISSUABLE', message: invitations[0].blockReason ?? 'Invitation non réémissible.' };
  }

  const expiresAt = new Date(now.getTime() + DUO_INVITE_TTL_DAYS * 24 * 3600 * 1000);
  const [duo] = await pgClient.unsafe<{ billing_owner_user_id: number; pending_invite_token: string; pending_invite_email: string }[]>(
    `UPDATE duo_accounts
        SET pending_invite_token = CASE
              WHEN pending_invite_token_expires_at IS NULL OR pending_invite_token_expires_at < $2 THEN $3
              ELSE pending_invite_token END,
            pending_invite_token_expires_at = CASE
              WHEN pending_invite_token_expires_at IS NULL OR pending_invite_token_expires_at < $2 THEN $4
              ELSE pending_invite_token_expires_at END,
            updated_at = $2
      WHERE id = $1 AND pending_invite_email IS NOT NULL AND pending_invite_token IS NOT NULL
      RETURNING billing_owner_user_id, pending_invite_token, pending_invite_email`,
    [target.duoId, now.toISOString(), crypto.randomBytes(32).toString('hex'), expiresAt.toISOString()],
  );
  if (!duo) return { ok: false, code: 'NOT_REISSUABLE', message: 'L’invitation a été retirée entre-temps.' };

  // Lot 57A (P1-E) : même demande DURABLE que le parcours du titulaire —
  // e-mail DUO_INVITATION (destinataire : l'invité, émetteur : le titulaire),
  // date d'envoi posée seulement à l'acceptation par Resend ; le résultat
  // (`success: false` compris) est rendu au BO au lieu d'être ignoré.
  const { enqueueDuoInvitationEmail, processEmailJob } = await import('@/services/email/transactional-email-jobs.service');
  const job = await enqueueDuoInvitationEmail({
    duoId: target.duoId, recipientEmail: duo.pending_invite_email, triggeredByUserId: duo.billing_owner_user_id, baseUrl: appUrl,
  });
  const outcome = await processEmailJob(job.jobId);
  const emailStatus = outcome.status === 'accepted' ? 'accepted' : outcome.status === 'failed' || outcome.status === 'cancelled' ? 'failed' : 'queued';
  return { ok: true, email: duo.pending_invite_email, renewed: target.expired, duoId: target.duoId, emailStatus, emailError: outcome.error ?? null };
}
