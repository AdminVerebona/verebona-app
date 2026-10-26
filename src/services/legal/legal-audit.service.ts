/**
 * Journal d'audit des documents légaux — CDC 7 §19.
 *
 * Neuf actions sont journalisées, dont trois relèvent d'autres lots
 * (`USER_ACCEPTED`, `CONFIRMATION_EMAIL_SENT`, `FILE_RESTORED`) : le contrat
 * est posé ici pour qu'elles s'y branchent sans redéveloppement.
 */
import { db } from '@/db';
import { legalAuditLog } from '@/db/schema';

type LegalAuditAction =
  | 'DRAFT_CREATED'
  | 'DRAFT_UPDATED'
  | 'PUBLISHED'
  | 'CURRENT_CHANGED'
  | 'ADMIN_DOWNLOAD'
  | 'INTEGRITY_FAILED'
  | 'FILE_RESTORED'
  | 'USER_ACCEPTED'
  | 'CONFIRMATION_EMAIL_SENT';

interface LegalAuditEntry {
  action: LegalAuditAction;
  actorUserId?: number | null;
  /** Libellé lisible de l'acteur. `system` pour une action automatique. */
  actorLabel?: string;
  versionCode?: string | null;
  versionId?: string | null;
  result?: 'success' | 'failure';
  details?: string | null;
  occurredAt?: Date;
}

/**
 * Écrit une entrée de journal.
 *
 * NE LÈVE JAMAIS. Un journal indisponible ne doit pas faire échouer une
 * publication ni, surtout, une acceptation : perdre une trace est fâcheux,
 * perdre une preuve contractuelle l'est infiniment plus. L'échec d'écriture
 * est lui-même journalisé en console.
 */
export async function recordLegalAudit(entry: LegalAuditEntry): Promise<void> {
  try {
    await db.insert(legalAuditLog).values({
      occurredAt: entry.occurredAt ?? new Date(),
      actorUserId: entry.actorUserId ?? null,
      actorLabel: entry.actorLabel ?? (entry.actorUserId ? `user:${entry.actorUserId}` : 'system'),
      action: entry.action,
      versionCode: entry.versionCode ?? null,
      versionId: entry.versionId ?? null,
      result: entry.result ?? 'success',
      details: entry.details ?? null,
    });
  } catch (e) {
    console.error(
      `[legal-audit] écriture impossible (${entry.action}) : ${(e as Error).message}`,
    );
  }
}

