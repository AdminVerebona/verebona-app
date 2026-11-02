/**
 * Lot 102A — registre minimal des suppressions exécutées et REJEU après
 * restauration d'une sauvegarde (ticket « Conformité légale », P1
 * « Suppression volontaire » : « sauvegardes à rotation courte et suppression
 * rejouée après restauration »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Une sauvegarde prise AVANT une suppression contient encore le compte. Si
 * elle est restaurée, le compte réapparaît : la suppression doit être
 * rejouée. Le registre `account_deletion_registry` (écrit par le moteur de
 * purge dans la même transaction que la suppression) conserve le strict
 * minimum pour cela : les IDENTIFIANTS INTERNES des utilisateurs et comptes
 * supprimés, le motif, la portée et la date — aucune adresse, aucun nom,
 * aucun contenu.
 *
 *   · restauration depuis le BO (Exploitation › Sauvegardes et recette) : la
 *     table est conservée dans son état courant (RESTORE_KEEP_CURRENT_TABLES)
 *     et le rejeu s'exécute AUTOMATIQUEMENT à la fin de la restauration ;
 *   · restauration par l'hébergeur (hors application) : télécharger le
 *     registre AVANT (BO › Exploitation › Cycle de vie des comptes), puis le
 *     rejouer depuis le fichier après la restauration.
 *   Procédure : docs/exploitation/procedure-restauration-suppressions.md.
 *
 * Le rejeu passe par le MÊME moteur (`executeScheduledDeletion`, portée et
 * motif d'origine) : mêmes conservations légales, même contrôle d'orphelins,
 * mêmes objets du stockage mis en file de purge. Idempotent : un identifiant
 * absent de la base n'appelle aucune action.
 *
 * Conservation du registre : rotation des sauvegardes (BACKUP_RETENTION_DAYS,
 * 30 jours par défaut) + marge (`deletionRegistryMarginDays`) — au-delà,
 * aucune sauvegarde plus ancienne ne peut être restaurée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db, pgClient } from '@/db';
import { accountDeletionRegistry, scheduledAccountDeletions, users } from '@/db/schema';
import { and, eq, lt } from 'drizzle-orm';
import { LIFECYCLE_DURATIONS } from '@/lib/account-lifecycle/retention-policy';
import { executeScheduledDeletion, type DeletionReason } from './scheduled-deletion.service';

const DAY_MS = 86_400_000;

export interface RegistryEntry {
  scheduleId: number | null;
  reason: string;
  scope: 'account' | 'user';
  userIds: number[];
  accountIds: number[];
  executedAt: string;
}

const isIdList = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && (n as number) > 0);
const KNOWN_REASONS: readonly DeletionReason[] = ['WITHDRAWAL', 'VOLUNTARY', 'TRIAL_ABANDONED', 'ADMIN', 'UNPAID', 'SUBSCRIPTION_ENDED'];

/** Valide une entrée venue d'un fichier téléchargé (jamais d'autre champ accepté). */
export function parseRegistryEntries(raw: unknown): RegistryEntry[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : null);
  if (!list) throw new Error('Fichier de registre illisible : liste « entries » attendue.');
  return list.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const scope = o.scope === 'user' ? 'user' : o.scope === 'account' ? 'account' : null;
    const reason = typeof o.reason === 'string' && (KNOWN_REASONS as readonly string[]).includes(o.reason) ? o.reason : null;
    const at = typeof o.executedAt === 'string' && !Number.isNaN(Date.parse(o.executedAt)) ? o.executedAt : null;
    if (!scope || !reason || !at || !isIdList(o.userIds) || !isIdList(o.accountIds)) {
      throw new Error(`Entrée ${i + 1} du registre invalide.`);
    }
    return {
      scheduleId: Number.isSafeInteger(o.scheduleId) ? (o.scheduleId as number) : null,
      reason, scope, userIds: o.userIds, accountIds: o.accountIds, executedAt: new Date(at).toISOString(),
    };
  });
}

/** Registre complet (export JSON pour une restauration hors application). */
export async function exportDeletionRegistry(): Promise<{ generatedAt: string; entries: RegistryEntry[] }> {
  const rows = await db.select().from(accountDeletionRegistry).orderBy(accountDeletionRegistry.id);
  return {
    generatedAt: new Date().toISOString(),
    entries: rows.map((r) => ({
      scheduleId: r.scheduleId ?? null,
      reason: r.reason,
      scope: r.scope === 'user' ? 'user' : 'account',
      userIds: r.userIds ?? [],
      accountIds: r.accountIds ?? [],
      executedAt: r.executedAt.toISOString(),
    })),
  };
}

export interface ReplayReport {
  examined: number;
  /** Entrées dont un identifiant existait de nouveau, supprimées à nouveau. */
  replayed: number;
  /** Entrées sans rien à faire (aucun identifiant présent). */
  nothingToDo: number;
  failures: Array<{ scheduleId: number | null; reason: string }>;
  /** Entrées importées depuis un fichier (absentes du registre en base). */
  imported: number;
}

async function present(entry: RegistryEntry): Promise<{ userIds: number[]; accountIds: number[] }> {
  const u = entry.userIds.length
    ? await pgClient<{ id: number }[]>`SELECT id FROM users WHERE id IN ${pgClient(entry.userIds)}`
    : [];
  const a = entry.accountIds.length
    ? await pgClient<{ id: number }[]>`SELECT id FROM accounts WHERE id IN ${pgClient(entry.accountIds)}`
    : [];
  return { userIds: u.map((r) => Number(r.id)), accountIds: a.map((r) => Number(r.id)) };
}

/**
 * Compte à rebours de rejeu (échéance immédiate, origine système), sans
 * passer par le registre RGPD : la demande d'origine y est déjà traitée.
 * Réutilise un compte à rebours actif restauré par la sauvegarde.
 */
async function replaySchedule(input: { scope: 'account' | 'user'; accountId: number; userId: number | null; reason: string; now: Date }): Promise<number | null> {
  const activeFilter = input.scope === 'user'
    ? and(eq(scheduledAccountDeletions.userId, input.userId ?? -1), eq(scheduledAccountDeletions.scope, 'user'))
    : and(eq(scheduledAccountDeletions.accountId, input.accountId), eq(scheduledAccountDeletions.scope, 'account'));
  const [inserted] = await db
    .insert(scheduledAccountDeletions)
    .values({
      accountId: input.accountId, userId: input.userId, reason: input.reason, origin: 'system', scope: input.scope,
      confirmedAt: input.now, scheduledAt: input.now, status: 'SCHEDULED', createdAt: input.now, updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: scheduledAccountDeletions.id });
  if (inserted) return inserted.id;
  const [active] = await db
    .select({ id: scheduledAccountDeletions.id })
    .from(scheduledAccountDeletions)
    .where(and(activeFilter, eq(scheduledAccountDeletions.status, 'SCHEDULED')))
    .limit(1);
  if (!active) return null;
  await db.update(scheduledAccountDeletions)
    .set({ scheduledAt: input.now, processingStartedAt: null, nextAttemptAt: null, updatedAt: input.now })
    .where(eq(scheduledAccountDeletions.id, active.id));
  return active.id;
}

/**
 * Rejoue les suppressions du registre (en base, complété par `entries` d'un
 * fichier le cas échéant). Ne lève jamais pour une entrée : chaque échec est
 * rapporté et n'interrompt pas les suivantes.
 */
export async function replayDeletionRegistry(opts: { now?: Date; entries?: RegistryEntry[] } = {}): Promise<ReplayReport> {
  const now = opts.now ?? new Date();
  const report: ReplayReport = { examined: 0, replayed: 0, nothingToDo: 0, failures: [], imported: 0 };

  // Entrées d'un fichier : ajoutées au registre si absentes (même suppression,
  // même date) — elles survivront ainsi à une prochaine restauration.
  for (const e of opts.entries ?? []) {
    const [dup] = await pgClient<{ id: number }[]>`
      SELECT id FROM account_deletion_registry
       WHERE executed_at = ${e.executedAt} AND user_ids = ${e.userIds}::int[] AND account_ids = ${e.accountIds}::int[] LIMIT 1`;
    if (dup) continue;
    await db.insert(accountDeletionRegistry).values({
      scheduleId: e.scheduleId, reason: e.reason, scope: e.scope, userIds: e.userIds, accountIds: e.accountIds,
      executedAt: new Date(e.executedAt), source: 'execution', createdAt: now,
    });
    report.imported += 1;
  }

  const rows = await db.select().from(accountDeletionRegistry).orderBy(accountDeletionRegistry.executedAt);
  for (const r of rows) {
    report.examined += 1;
    const entry: RegistryEntry = {
      scheduleId: r.scheduleId ?? null, reason: r.reason, scope: r.scope === 'user' ? 'user' : 'account',
      userIds: r.userIds ?? [], accountIds: r.accountIds ?? [], executedAt: r.executedAt.toISOString(),
    };
    try {
      const back = await present(entry);
      if (back.userIds.length === 0 && back.accountIds.length === 0) { report.nothingToDo += 1; continue; }

      const ids: number[] = [];
      if (entry.scope === 'account' && back.accountIds.length > 0) {
        const id = await replaySchedule({ scope: 'account', accountId: back.accountIds[0], userId: back.userIds[0] ?? null, reason: entry.reason, now });
        if (id) ids.push(id);
      } else {
        // Portée utilisateur (ou compte déjà absent mais utilisateur revenu) :
        // chaque utilisateur revenu est clôturé puis supprimé (portée user).
        for (const userId of back.userIds) {
          await db.update(users).set({ status: 'PENDING_DELETION', updatedAt: now }).where(eq(users.id, userId));
          const id = await replaySchedule({ scope: 'user', accountId: back.accountIds[0] ?? entry.accountIds[0] ?? 0, userId, reason: entry.reason, now });
          if (id) ids.push(id);
        }
      }
      const outcomes = [];
      for (const id of ids) outcomes.push(await executeScheduledDeletion(id, { now, replay: true }));
      const failed = outcomes.find((o) => o.status === 'failed');
      if (failed || ids.length === 0) {
        report.failures.push({ scheduleId: entry.scheduleId, reason: failed?.reason ?? 'REPLAY_SCHEDULE_UNAVAILABLE' });
        continue;
      }
      await db.update(accountDeletionRegistry)
        .set({ replayCount: (r.replayCount ?? 0) + 1, lastReplayedAt: now })
        .where(eq(accountDeletionRegistry.id, r.id));
      report.replayed += 1;
    } catch (e) {
      report.failures.push({ scheduleId: entry.scheduleId, reason: (e as Error).message.slice(0, 300) });
    }
  }
  if (report.replayed > 0 || report.failures.length > 0) {
    console.info(`[deletion-registry] rejeu : ${report.replayed} suppression(s) rejouée(s), ${report.failures.length} échec(s), ${report.examined} entrée(s).`);
  }
  if (report.failures.length > 0) {
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'backups', fingerprint: buildFingerprint('backups', 'deletion-replay', now.toISOString().slice(0, 10)),
      title: 'Suppression non rejouée après restauration',
      detail: { failures: report.failures.slice(0, 20) },
    }).catch(() => undefined);
  }
  return report;
}

/** Rotation : entrées plus anciennes que toute sauvegarde restaurable. */
export function registryRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const backup = Math.max(1, Number(env.BACKUP_RETENTION_DAYS) || 30);
  return backup + LIFECYCLE_DURATIONS.deletionRegistryMarginDays;
}

export async function purgeDeletionRegistry(now: Date = new Date()): Promise<number> {
  const limit = new Date(now.getTime() - registryRetentionDays() * DAY_MS);
  const gone = await db.delete(accountDeletionRegistry).where(lt(accountDeletionRegistry.executedAt, limit)).returning({ id: accountDeletionRegistry.id });
  return gone.length;
}

/** Dernières entrées (BO) : identifiants et motifs seulement. */
export async function latestRegistryEntries(limit = 20): Promise<RegistryEntry[]> {
  const rows = await pgClient<{ schedule_id: number | null; reason: string; scope: string; user_ids: number[]; account_ids: number[]; executed_at: Date }[]>`
    SELECT schedule_id, reason, scope, user_ids, account_ids, executed_at
      FROM account_deletion_registry ORDER BY executed_at DESC, id DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    scheduleId: r.schedule_id, reason: r.reason, scope: r.scope === 'user' ? 'user' : 'account',
    userIds: r.user_ids ?? [], accountIds: r.account_ids ?? [], executedAt: new Date(r.executed_at).toISOString(),
  }));
}
