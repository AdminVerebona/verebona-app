/**
 * Traçabilité des modifications Prompt Control — CDC BO IA T5-014.
 *
 * « Toute modification T5 enregistre instruction, cible, avant/après, version
 * Draft et exécution. » Écrit dans `ai_admin_audit_log`, le journal des gestes
 * d'administration IA, avec la trace de l'appel modèle qui a produit le texte :
 * c'est elle qui relie la modification à son coût et à sa sortie brute dans
 * l'écran Exécutions & logs.
 *
 * Module séparé pour que le service reste testable sans base.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { aiAdminAuditLog, users } from '@/db/schema';

export interface T5ModificationTrace {
  adminUserId: number;
  instruction: string;
  treatment: string;
  versionId: number;
  draftCreated: boolean;
  before: string;
  after: string;
  traceId: string;
  verdict: string;
}

export async function recordT5Modification(t: T5ModificationTrace): Promise<void> {
  const admin = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, t.adminUserId))
    .limit(1)
    .then((r) => r[0]);

  await db.insert(aiAdminAuditLog).values({
    adminUserId: t.adminUserId,
    adminEmail: admin?.email ?? `user:${t.adminUserId}`,
    actionType: 't5_prompt_modify',
    beforeValue: { treatment: t.treatment, versionId: t.versionId, prompt: t.before },
    afterValue: {
      treatment: t.treatment,
      versionId: t.versionId,
      draftCreated: t.draftCreated,
      prompt: t.after,
      verdict: t.verdict,
      traceId: t.traceId,
    },
    reason: t.instruction,
    createdAt: new Date(),
  });
}
