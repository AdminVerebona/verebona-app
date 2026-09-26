/**
 * Journal technique des actions administrateur — CDC Back-Office V1 §2.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL POINT D'ÉCRITURE
 *
 * AUD-001 exige, pour toute action sensible : administrateur, action, cible,
 * date/heure, résultat et, lorsque pertinent, ancienne et nouvelle valeur.
 * Chaque route écrivait jusqu'ici sa propre ligne `admin_audit_log`, avec un
 * `details` libre et sans résultat : une action refusée ou échouée était
 * indiscernable d'une action réussie, et certaines actions (suspension de
 * compte, suppression, changement d'offre) n'étaient pas tracées du tout
 * (AUD-003).
 *
 * `logAdminAction` est appelé par chaque action sensible, y compris en cas
 * d'échec (résultat FAILURE), afin que le journal dise ce qui a été TENTÉ et
 * pas seulement ce qui a réussi.
 *
 * ÉCHEC D'ÉCRITURE DU JOURNAL : il est consigné dans les logs serveur mais ne
 * fait pas échouer l'action. L'action a déjà produit son effet (sessions
 * révoquées, abonnement Stripe modifié…) ; répondre « échec » à l'admin le
 * pousserait à la rejouer. Exception : un appelant qui passe `executor` (une
 * transaction) veut au contraire que le journal et l'action soient atomiques —
 * l'erreur est alors propagée pour annuler la transaction.
 *
 * AUD-002 : aucune route de modification ni de suppression du journal.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { adminAuditLog, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/** Résultat d'une action administrateur (colonne `result`, migration 0170). */
export type AdminActionResult = 'SUCCESS' | 'FAILURE' | 'DENIED';

/**
 * Actions sensibles journalisées (AUD-003). Liste fermée : un libellé libre
 * finirait par produire plusieurs noms pour la même action et rendrait le
 * journal inexploitable.
 */
export type AdminActionType =
  | 'ACCOUNT_SUSPEND'
  | 'ACCOUNT_REACTIVATE'
  | 'ACCOUNT_PLAN_CHANGE'
  | 'ACCOUNT_DELETE'
  | 'USER_SUSPEND'
  | 'USER_REACTIVATE'
  | 'USER_FORCE_LOGOUT'
  | 'USER_PASSWORD_RESET'
  | 'USER_ADMIN_ROLE_CHANGE'
  | 'EXPORT_TEMPLATE_TOGGLE'
  | 'COMMUNICATION_CHANNEL_TOGGLE'
  // Résolution manuelle d'une anomalie de supervision (CDC BO AUD-003, SUP-007).
  | 'ANOMALY_RESOLVE'
  // Demandes RGPD manuelles (CDC BO AUD-003 « réouverture RGPD », GDP-010, GDP-014, GDP-016).
  | 'GDPR_REQUEST_CREATE'
  | 'GDPR_REQUEST_UPDATE'
  | 'GDPR_REQUEST_REOPEN';

export type AdminTargetType = 'ACCOUNT' | 'USER' | 'EXPORT_TEMPLATE' | 'COMMUNICATION_CHANNEL' | 'ANOMALY' | 'GDPR_REQUEST';

type Executor = Pick<typeof db, 'insert' | 'select'>;

export interface AdminActionEntry {
  adminId: number;
  /** Évite une lecture en base si l'appelant la connaît déjà (session). */
  adminEmail?: string;
  action: AdminActionType;
  targetType: AdminTargetType;
  targetId: number | null;
  result: AdminActionResult;
  /** Valeur avant l'action, lorsque pertinent. */
  before?: Record<string, unknown> | null;
  /** Valeur après l'action (ou demandée, en cas d'échec). */
  after?: Record<string, unknown> | null;
  /** Contexte complémentaire (code d'erreur, nombre de sessions…). */
  details?: Record<string, unknown> | null;
  /** Transaction en cours : le journal devient alors atomique avec l'action. */
  executor?: Executor;
}

/** E-mail de l'administrateur, colonne NOT NULL du journal. */
async function resolveAdminEmail(executor: Executor, adminId: number): Promise<string> {
  const [row] = await executor
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, adminId))
    .limit(1);
  return row?.email ?? `user:${adminId}`;
}

/**
 * Construit la ligne à insérer. Pure : testable sans base.
 */
export function buildAdminAuditRow(entry: AdminActionEntry, adminEmail: string, now: Date = new Date()) {
  return {
    timestamp: now,
    adminUserId: entry.adminId,
    adminEmail,
    actionType: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    result: entry.result,
    oldValue: entry.before ?? null,
    newValue: entry.after ?? null,
    details: entry.details ? JSON.stringify(entry.details) : null,
  };
}

/**
 * Écrit une ligne dans `admin_audit_log`.
 *
 * Sans `executor` : ne lève jamais (voir en-tête). Avec `executor` : propage
 * l'erreur pour que la transaction appelante soit annulée.
 */
export async function logAdminAction(entry: AdminActionEntry): Promise<void> {
  const executor = entry.executor ?? db;
  try {
    const email = entry.adminEmail ?? (await resolveAdminEmail(executor, entry.adminId));
    await executor.insert(adminAuditLog).values(buildAdminAuditRow(entry, email));
  } catch (error) {
    if (entry.executor) throw error;
    console.error(
      `[admin-audit] écriture du journal impossible (${entry.action} ${entry.targetType}#${entry.targetId}, ${entry.result}) :`,
      (error as Error).message,
    );
  }
}
