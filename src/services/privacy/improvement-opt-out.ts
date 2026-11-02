/**
 * Opposition à l'utilisation des données pour l'amélioration — stockage,
 * preuve et lecture (lot 102D). Règle et libellés :
 * `improvement-opt-out-rules.ts`.
 *
 * Preuve (journal `account_data_use_preference_events`) : compte, auteur,
 * action, canal (web / mobile / admin), libellé EXACT affiché et son
 * empreinte SHA-256, navigateur abrégé, date. Aucune adresse IP.
 *
 * Effet immédiat : les usages d'amélioration lisent l'état en SQL
 * (`improvementAccountAllowedSql`, `improvementCaptureUsableSql`) à chaque
 * passage — aucun cache à invalider.
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { improvementProofLabel, type ImprovementChannel } from './improvement-opt-out-rules';

export interface ImprovementPreference {
  optOut: boolean;
  optedOutAt: string | null;
  optedOutByUserId: number | null;
  withdrawnAt: string | null;
  /** Captures antérieures exclues de l'amélioration (null : aucune). */
  excludedBefore: string | null;
}

export interface ImprovementEvent {
  action: 'OPT_OUT' | 'OPT_IN';
  channel: ImprovementChannel;
  userId: number | null;
  labelShown: string;
  labelSha256: string;
  occurredAt: string;
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v) === 'infinity' ? 'infinity' : null;
  return d.toISOString();
};

export async function getImprovementPreference(accountId: number): Promise<ImprovementPreference> {
  const [r] = await pgClient.unsafe(
    `SELECT improvement_opt_out, opted_out_at, opted_out_by_user_id, withdrawn_at, excluded_before::text AS excluded_before
       FROM account_data_use_preferences WHERE account_id = $1`,
    [accountId] as never[],
  ) as unknown as Array<Record<string, unknown>>;
  return {
    optOut: Boolean(r?.improvement_opt_out),
    optedOutAt: iso(r?.opted_out_at),
    optedOutByUserId: r?.opted_out_by_user_id == null ? null : Number(r.opted_out_by_user_id),
    withdrawnAt: iso(r?.withdrawn_at),
    excludedBefore: r?.excluded_before == null ? null : String(r.excluded_before) === 'infinity' ? 'infinity' : iso(r.excluded_before),
  };
}

export async function listImprovementEvents(accountId: number, limit = 20): Promise<ImprovementEvent[]> {
  const rows = await pgClient.unsafe(
    `SELECT action, channel, user_id, label_shown, label_sha256, occurred_at
       FROM account_data_use_preference_events WHERE account_id = $1
      ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    [accountId, Math.max(1, Math.min(limit, 200))] as never[],
  ) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    action: r.action as 'OPT_OUT' | 'OPT_IN',
    channel: r.channel as ImprovementChannel,
    userId: r.user_id == null ? null : Number(r.user_id),
    labelShown: String(r.label_shown),
    labelSha256: String(r.label_sha256),
    occurredAt: iso(r.occurred_at) ?? '',
  }));
}

/**
 * Enregistre le choix (idempotent : même état → aucune écriture, aucune
 * preuve en double). Opposition : `excluded_before = infinity`. Retrait :
 * `excluded_before = now` (ce qui précède reste exclu).
 */
export async function setImprovementOptOut(input: {
  accountId: number;
  userId: number | null;
  optOut: boolean;
  channel: ImprovementChannel;
  userAgent?: string | null;
  now?: Date;
}): Promise<{ changed: boolean; preference: ImprovementPreference }> {
  const now = input.now ?? new Date();
  const label = improvementProofLabel(input.optOut);
  const sha = createHash('sha256').update(label, 'utf8').digest('hex');
  const ua = input.userAgent ? input.userAgent.replace(/[\r\n]/g, ' ').slice(0, 200) : null;

  const changed = await pgClient.begin(async (tx) => {
    const [cur] = await tx.unsafe(
      `SELECT improvement_opt_out FROM account_data_use_preferences WHERE account_id = $1 FOR UPDATE`,
      [input.accountId] as never[],
    ) as unknown as Array<{ improvement_opt_out: boolean }>;
    if (Boolean(cur?.improvement_opt_out) === input.optOut) return false;
    if (input.optOut) {
      await tx.unsafe(
        `INSERT INTO account_data_use_preferences (account_id, improvement_opt_out, opted_out_at, opted_out_by_user_id, withdrawn_at, excluded_before, updated_at)
         VALUES ($1, true, $2::timestamptz, $3, NULL, 'infinity', $2::timestamptz)
         ON CONFLICT (account_id) DO UPDATE SET improvement_opt_out = true, opted_out_at = EXCLUDED.opted_out_at,
           opted_out_by_user_id = EXCLUDED.opted_out_by_user_id, withdrawn_at = NULL, excluded_before = 'infinity', updated_at = EXCLUDED.updated_at`,
        [input.accountId, now.toISOString(), input.userId] as never[],
      );
    } else {
      await tx.unsafe(
        `UPDATE account_data_use_preferences
            SET improvement_opt_out = false, withdrawn_at = $2::timestamptz, excluded_before = $2::timestamptz, updated_at = $2::timestamptz
          WHERE account_id = $1`,
        [input.accountId, now.toISOString()] as never[],
      );
    }
    await tx.unsafe(
      `INSERT INTO account_data_use_preference_events (account_id, user_id, action, channel, label_shown, label_sha256, user_agent, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [input.accountId, input.userId, input.optOut ? 'OPT_OUT' : 'OPT_IN', input.channel, label, sha, ua, now.toISOString()] as never[],
    );
    return true;
  });
  if (changed) {
    console.info(`[confidentialite] compte ${input.accountId} : opposition à l’amélioration ${input.optOut ? 'enregistrée' : 'retirée'} (canal ${input.channel}).`);
  }
  return { changed, preference: await getImprovementPreference(input.accountId) };
}

/** BO : nombre de comptes opposés (supervision). */
export async function countImprovementOptOuts(): Promise<number> {
  const [r] = await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM account_data_use_preferences WHERE improvement_opt_out`,
  ) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}
