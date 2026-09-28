/**
 * Historique consolidé d'un compte — CDC Back-Office V1 §5.2.5
 * (ACC-D09 à ACC-D11).
 *
 * Tableau chronologique simple (ACC-D09) : création, essai, conversion
 * payante, changements d'offre, suspension / réactivation, résiliation, fin
 * effective, rétractation, suppression engagée et événements de membres
 * (ACC-D10). Chaque ligne porte date, événement et origine (ACC-D11).
 *
 * `buildAccountHistory` est pur ; `loadAccountHistory` lit les sources.
 */
import { pgClient } from '@/db';

export type HistoryOrigin = 'user' | 'admin' | 'system' | 'stripe';

export interface HistoryEntry {
  at: string;
  event: string;
  origin: HistoryOrigin;
  detail: string | null;
  /** Date future (fin programmée) : affichée comme prévue. */
  scheduled?: boolean;
}

export const ORIGIN_LABELS: Record<HistoryOrigin, string> = {
  user: 'Utilisateur',
  admin: 'Administrateur',
  system: 'Système',
  stripe: 'Stripe',
};

const PLAN_LABELS: Record<string, string> = {
  standard: 'Standard',
  free: 'Standard',
  premium: 'Premium',
  premium_duo: 'Premium Duo',
  duo: 'Premium Duo',
  pro: 'Premium',
};

export function planLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return PLAN_LABELS[code.toLowerCase()] ?? code;
}

/** Origine d'une ligne `subscription_history.source`. */
export function originFromSource(source: string | null | undefined): HistoryOrigin {
  const s = (source ?? '').toLowerCase();
  if (s.startsWith('admin')) return 'admin';
  if (s.startsWith('webhook') || s.startsWith('stripe') || s === 'checkout-return') return 'stripe';
  if (s.startsWith('user') || s.startsWith('self')) return 'user';
  return 'system';
}

const MEMBER_EVENTS: Record<string, string> = {
  MEMBER_INVITED: 'Invitation d’un utilisateur',
  MEMBER_JOINED: 'Utilisateur rattaché au compte',
  MEMBER_LEFT: 'Utilisateur parti du compte',
  MEMBER_REMOVED: 'Utilisateur retiré du compte',
  OWNER_TRANSFERRED: 'Changement de titulaire',
  ACCOUNT_CREATED: 'Création du compte',
  ACCOUNT_UPDATED: 'Compte modifié',
};

/** Libellé lisible d'un `account_audit_log.action_type` (jamais le code brut seul). */
export function accountAuditLabel(actionType: string): string {
  if (MEMBER_EVENTS[actionType]) return MEMBER_EVENTS[actionType];
  const words = actionType.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DELETION_REASONS: Record<string, string> = {
  WITHDRAWAL: 'suite à une rétractation',
  VOLUNTARY: 'à la demande de l’utilisateur',
  TRIAL_ABANDONED: 'fin d’essai sans souscription',
  ADMIN: 'par un administrateur',
  UNPAID: 'suite à des impayés',
};

export interface HistorySources {
  now: Date;
  account: { createdAt: Date | string | null };
  subscription: {
    trialStartedAt: Date | string | null;
    trialEndsAt: Date | string | null;
    contractConcludedAt: Date | string | null;
    firstBilledAt: Date | string | null;
    cancelAtPeriodEnd: boolean | null;
    currentPeriodEndAt: Date | string | null;
    status: string | null;
  } | null;
  planChanges: { at: Date | string; oldTier: string | null; newTier: string; source: string | null }[];
  adminActions: { at: Date | string; actionType: string; result: string | null }[];
  withdrawals: { requestedAt: Date | string | null; effectiveAt: Date | string | null; status: string; channel: string | null }[];
  deletions: {
    createdAt: Date | string | null;
    origin: string | null;
    reason: string;
    status: string;
    cancelledAt: Date | string | null;
    executedAt: Date | string | null;
    scheduledAt: Date | string | null;
  }[];
  auditLogs: { at: Date | string; actionType: string; userEmail: string | null; targetUserEmail: string | null }[];
}

const toIso = (v: Date | string | null | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function buildAccountHistory(src: HistorySources): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const push = (at: Date | string | null | undefined, event: string, origin: HistoryOrigin, detail: string | null = null) => {
    const iso = toIso(at);
    if (!iso) return;
    out.push({ at: iso, event, origin, detail, ...(new Date(iso) > src.now ? { scheduled: true } : {}) });
  };

  push(src.account.createdAt, 'Création du compte', 'user');

  const sub = src.subscription;
  if (sub) {
    push(sub.trialStartedAt, 'Début de l’essai', 'user');
    push(sub.trialEndsAt, 'Fin de l’essai', 'system');
    push(sub.contractConcludedAt ?? sub.firstBilledAt, 'Conversion payante', 'stripe');
    if (sub.cancelAtPeriodEnd && sub.currentPeriodEndAt) {
      push(sub.currentPeriodEndAt, 'Fin d’abonnement programmée (résiliation)', 'stripe');
    }
  }

  for (const c of src.planChanges) {
    const source = (c.source ?? '').toLowerCase();
    if (source.includes('subscription.deleted')) {
      push(c.at, 'Fin effective de l’abonnement', 'stripe', `${planLabel(c.oldTier)} → ${planLabel(c.newTier)}`);
    } else if ((c.oldTier ?? '').toLowerCase() !== c.newTier.toLowerCase()) {
      push(c.at, 'Changement d’offre', originFromSource(c.source), `${planLabel(c.oldTier)} → ${planLabel(c.newTier)}`);
    }
  }

  for (const a of src.adminActions) {
    if (a.result && a.result !== 'SUCCESS') continue;
    if (a.actionType === 'ACCOUNT_SUSPEND') push(a.at, 'Suspension du compte', 'admin');
    else if (a.actionType === 'ACCOUNT_REACTIVATE') push(a.at, 'Réactivation du compte', 'admin');
  }

  for (const w of src.withdrawals) {
    push(w.requestedAt, 'Demande de rétractation', w.channel === 'support' ? 'admin' : 'user');
    if (w.status === 'completed') push(w.effectiveAt, 'Rétractation effective', 'system');
  }

  for (const d of src.deletions) {
    const origin: HistoryOrigin = d.origin === 'admin' ? 'admin' : d.origin === 'system' ? 'system' : 'user';
    push(d.createdAt, 'Suppression du compte engagée', origin, DELETION_REASONS[d.reason] ?? null);
    if (d.status === 'CANCELLED') push(d.cancelledAt, 'Suppression annulée', 'user');
    if (d.status === 'EXECUTED') push(d.executedAt, 'Suppression exécutée', 'system');
    else if (d.status === 'SCHEDULED') push(d.scheduledAt, 'Suppression définitive programmée', 'system');
  }

  for (const l of src.auditLogs) {
    push(l.at, accountAuditLabel(l.actionType), 'user', l.targetUserEmail ?? null);
  }

  return out.sort((a, b) => b.at.localeCompare(a.at));
}

type Row = Record<string, unknown>;

export async function loadAccountHistory(accountId: number, now = new Date()): Promise<HistoryEntry[]> {
  const [account] = await pgClient.unsafe<Row[]>(`SELECT created_at FROM accounts WHERE id = $1`, [accountId]);
  if (!account) return [];
  const [sub] = await pgClient.unsafe<Row[]>(
    `SELECT trial_started_at, trial_ends_at, contract_concluded_at, first_billed_at, cancel_at_period_end,
            current_period_end_at, status
       FROM account_subscriptions WHERE account_id = $1 LIMIT 1`,
    [accountId],
  );
  const [planChanges, adminActions, withdrawals, deletions, auditLogs] = await Promise.all([
    pgClient.unsafe<Row[]>(
      `SELECT created_at, old_tier, new_tier, source FROM subscription_history WHERE account_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [accountId],
    ),
    pgClient.unsafe<Row[]>(
      `SELECT timestamp, action_type, result FROM admin_audit_log
        WHERE target_type = 'ACCOUNT' AND target_id = $1 AND action_type IN ('ACCOUNT_SUSPEND', 'ACCOUNT_REACTIVATE')
        ORDER BY timestamp DESC LIMIT 100`,
      [accountId],
    ),
    pgClient.unsafe<Row[]>(
      `SELECT requested_at, effective_at, status, channel FROM withdrawal_requests WHERE account_id = $1`,
      [accountId],
    ),
    pgClient.unsafe<Row[]>(
      `SELECT created_at, origin, reason, status, cancelled_at, executed_at, scheduled_at
         FROM scheduled_account_deletions WHERE account_id = $1`,
      [accountId],
    ),
    pgClient.unsafe<Row[]>(
      `SELECT timestamp, action_type, user_email, target_user_email FROM account_audit_log
        WHERE account_id = $1 ORDER BY timestamp DESC LIMIT 100`,
      [accountId],
    ),
  ]);

  return buildAccountHistory({
    now,
    account: { createdAt: account.created_at as string },
    subscription: sub
      ? {
          trialStartedAt: sub.trial_started_at as string | null,
          trialEndsAt: sub.trial_ends_at as string | null,
          contractConcludedAt: sub.contract_concluded_at as string | null,
          firstBilledAt: sub.first_billed_at as string | null,
          cancelAtPeriodEnd: sub.cancel_at_period_end as boolean | null,
          currentPeriodEndAt: sub.current_period_end_at as string | null,
          status: sub.status as string | null,
        }
      : null,
    planChanges: planChanges.map((r) => ({
      at: r.created_at as string,
      oldTier: r.old_tier as string | null,
      newTier: String(r.new_tier),
      source: r.source as string | null,
    })),
    adminActions: adminActions.map((r) => ({ at: r.timestamp as string, actionType: String(r.action_type), result: r.result as string | null })),
    withdrawals: withdrawals.map((r) => ({
      requestedAt: r.requested_at as string | null,
      effectiveAt: r.effective_at as string | null,
      status: String(r.status),
      channel: r.channel as string | null,
    })),
    deletions: deletions.map((r) => ({
      createdAt: r.created_at as string | null,
      origin: r.origin as string | null,
      reason: String(r.reason),
      status: String(r.status),
      cancelledAt: r.cancelled_at as string | null,
      executedAt: r.executed_at as string | null,
      scheduledAt: r.scheduled_at as string | null,
    })),
    auditLogs: auditLogs.map((r) => ({
      at: r.timestamp as string,
      actionType: String(r.action_type),
      userEmail: r.user_email as string | null,
      targetUserEmail: r.target_user_email as string | null,
    })),
  });
}
