/**
 * Rétention du journal technique des actions administrateur — CDC
 * Back-Office V1 AUD-004.
 *
 * La durée est paramétrable HORS BO (`ADMIN_AUDIT_RETENTION_DAYS`) ; le CDC
 * n'en impose pas la valeur. Sans valeur valide, AUCUNE purge n'a lieu : une
 * variable absente ou mal saisie ne doit jamais effacer le journal. Un
 * plancher de 30 jours protège contre une valeur manifestement erronée.
 * Le journal reste non modifiable depuis le BO (AUD-002) : seule cette tâche
 * planifiée supprime, et uniquement les lignes échues.
 */
import { pgClient } from '@/db';

export const MIN_AUDIT_RETENTION_DAYS = 30;

/** `null` : purge désactivée (valeur absente, invalide ou sous le plancher). */
export function parseAuditRetentionDays(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < MIN_AUDIT_RETENTION_DAYS) return null;
  return n;
}

export function auditRetentionCutoff(retentionDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

const BATCH = 5000;

/** Supprime les lignes plus anciennes que la rétention, par lots. */
export async function purgeAdminAuditLog(retentionDays: number, now: Date = new Date()): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = auditRetentionCutoff(retentionDays, now);
  let deleted = 0;
  for (;;) {
    const rows = await pgClient.unsafe<{ id: number }[]>(
      `DELETE FROM admin_audit_log
        WHERE id IN (SELECT id FROM admin_audit_log WHERE timestamp < $1 ORDER BY id LIMIT ${BATCH})
        RETURNING id`,
      [cutoff.toISOString()],
    );
    deleted += rows.length;
    if (rows.length < BATCH) break;
  }
  return { deleted, cutoff: cutoff.toISOString() };
}
