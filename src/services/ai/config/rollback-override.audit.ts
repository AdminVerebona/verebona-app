/**
 * Restauration d'urgence malgré un corpus des masters non vert — CDC 15 §30,
 * D-17 (arbitrage lot 16 : le rollback d'incident n'est jamais bloqué, mais
 * il est justifié et tracé).
 *
 * Écrit dans `ai_admin_audit_log` : qui (administrateur), quand, pourquoi
 * (justification obligatoire), et l'état du corpus au moment du geste.
 * Module séparé pour que le service reste testable sans base.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { aiAdminAuditLog, users } from '@/db/schema';

export interface RollbackOverrideTrace {
  adminUserId: number;
  versionId: number;
  justification: string;
  corpus: unknown;
}

export async function recordRollbackOverride(t: RollbackOverrideTrace): Promise<void> {
  const admin = await db.select({ email: users.email }).from(users).where(eq(users.id, t.adminUserId)).limit(1).then((r) => r[0]);
  await db.insert(aiAdminAuditLog).values({
    adminUserId: t.adminUserId,
    adminEmail: admin?.email ?? `user:${t.adminUserId}`,
    actionType: 'ai_config_rollback_corpus_override',
    beforeValue: { versionId: t.versionId, corpus: t.corpus },
    afterValue: { versionId: t.versionId, restored: true },
    reason: t.justification,
    createdAt: new Date(),
  });
}
