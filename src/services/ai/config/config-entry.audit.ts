/**
 * Trace d'un enregistrement de configuration d'un traitement (BO IA, tickets
 * T4 et T5) : qui, quelle version, quels champs, valeurs avant / après.
 *
 * Écrit dans `ai_admin_audit_log`, le journal des gestes d'administration IA
 * (même table que la restauration d'urgence et Prompt Control). Seuls les
 * champs MODIFIÉS sont journalisés : un retrait de déclencheur incompatible
 * ou le nettoyage d'un ancien texte T5 se lit directement, sans comparer deux
 * instantanés complets.
 *
 * Module séparé pour que le service reste testable sans base. Ne lève jamais :
 * l'enregistrement a déjà eu lieu, une trace manquante est journalisée.
 */
import type { TreatmentConfig } from './config-types';

const CHAMPS = [
  'prompt', 'primaryModel', 'fallback1', 'fallback2',
  'reasoningPrimary', 'reasoningFallback1', 'reasoningFallback2',
  'maxOutputTokens', 'guardrails', 'triggers', 'cascade', 'promptArchitecture', 'masterPrompt',
] as const;

type Champ = (typeof CHAMPS)[number];

/** Champs modifiés entre deux configurations (pur, testé). */
export function changedConfigFields(
  before: Partial<TreatmentConfig> | null | undefined,
  after: Partial<TreatmentConfig>,
): { before: Partial<Record<Champ, unknown>>; after: Partial<Record<Champ, unknown>> } {
  const b: Partial<Record<Champ, unknown>> = {};
  const a: Partial<Record<Champ, unknown>> = {};
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v);
  for (const k of CHAMPS) {
    const x = norm(before?.[k]);
    const y = norm(after[k]);
    if (JSON.stringify(x) !== JSON.stringify(y)) { b[k] = x; a[k] = y; }
  }
  return { before: b, after: a };
}

export async function recordConfigEntrySave(t: {
  adminUserId: number;
  versionId: number;
  treatment: string;
  before: Partial<TreatmentConfig> | null | undefined;
  after: Partial<TreatmentConfig>;
  legacyPromptCleared: boolean;
}): Promise<void> {
  const diff = changedConfigFields(t.before, t.after);
  if (Object.keys(diff.after).length === 0) return; // seconde sauvegarde : rien à tracer
  try {
    const { eq } = await import('drizzle-orm');
    const { db } = await import('@/db');
    const { aiAdminAuditLog, users } = await import('@/db/schema');
    const admin = await db.select({ email: users.email }).from(users).where(eq(users.id, t.adminUserId)).limit(1).then((r) => r[0]);
    await db.insert(aiAdminAuditLog).values({
      adminUserId: t.adminUserId,
      adminEmail: admin?.email ?? `user:${t.adminUserId}`,
      actionType: 'ai_config_entry_save',
      beforeValue: { versionId: t.versionId, treatment: t.treatment, ...diff.before },
      afterValue: { versionId: t.versionId, treatment: t.treatment, ...diff.after },
      reason: t.legacyPromptCleared ? 'Ancien texte non utilisé retiré (prompt non administrable).' : null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[config] trace d’enregistrement impossible (non bloquant) :', (e as Error).message);
  }
}
