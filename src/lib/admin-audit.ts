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
  // Resynchronisation manuelle depuis Stripe (bouton « Synchroniser Stripe ») :
  // peut modifier l'offre et le statut d'abonnement (CDC BO AUD-001, ERR-004).
  | 'ACCOUNT_STRIPE_RESYNC'
  | 'ACCOUNT_DELETE'
  | 'USER_SUSPEND'
  | 'USER_REACTIVATE'
  | 'USER_FORCE_LOGOUT'
  | 'USER_PASSWORD_RESET'
  | 'USER_ADMIN_ROLE_CHANGE'
  // Renvoi d'une invitation réémissible (CDC BO USR-A01).
  | 'USER_INVITATION_RESEND'
  | 'EXPORT_TEMPLATE_TOGGLE'
  // Prévisualisation d'un modèle d'export sur un bien du compte administrateur
  // (BO modèles d'export : dossier, bien, résultat ; colonne texte libre).
  | 'EXPORT_TEMPLATE_PREVIEW'
  | 'COMMUNICATION_CHANNEL_TOGGLE'
  // Résolution manuelle d'une anomalie de supervision (CDC BO AUD-003, SUP-007).
  | 'ANOMALY_RESOLVE'
  // Demandes RGPD manuelles (CDC BO AUD-003 « réouverture RGPD », GDP-010, GDP-014, GDP-016).
  | 'GDPR_REQUEST_CREATE'
  | 'GDPR_REQUEST_UPDATE'
  | 'GDPR_REQUEST_REOPEN'
  // Assistant : seuils et interrupteurs administrés (CDC Assistant §32.6,
  // §32.7, CA-30 ; D-J1). Double validation : demande, accord, refus, annulation.
  | 'ASSISTANT_SETTING_UPDATE'
  | 'ASSISTANT_SETTING_REQUEST'
  | 'ASSISTANT_SETTING_APPROVE'
  | 'ASSISTANT_SETTING_REJECT'
  | 'ASSISTANT_SETTING_CANCEL'
  // Consultation sensible : contenu d'une conversation lu (§32.7, AI_T2_CONTENT_ADMIN_IDS).
  | 'ASSISTANT_CONTENT_READ'
  // Notifications (CDC 3 §20.2, §20.3 ; D-L) : recherche, réémission, renvoi.
  | 'NOTIFICATION_SEARCH'
  | 'NOTIFICATION_REEMIT'
  | 'NOTIFICATION_RESEND'
  // Caches de l'assistant et de l'IA : invalidation (CDC Assistant §32.6 ;
  // lot 23) — auteur, date, cache, motif.
  | 'AI_CACHE_INVALIDATE'
  // Export CSV des métriques agrégées (§32.6, §32.7 consultation tracée ; lot 23).
  | 'AI_METRICS_EXPORT'
  // Page BO « Exploitation » (lot 25, chantier B) : rattrapages de données
  // lancés depuis le BO — auteur, action, motif, identifiants d'exécution.
  | 'OPS_BACKFILL_SIMULATE'
  | 'OPS_BACKFILL_APPLY'
  | 'OPS_BACKFILL_RESTORE'
  // Exécution manuelle d'une tâche planifiée interne (lot 25, chantier A).
  | 'SCHEDULED_TASK_RUN'
  // Lot 33D : consultation de la sortie d'un modèle IA (données issues des
  // documents des utilisateurs) depuis « Exécutions & logs ».
  | 'AI_MODEL_OUTPUT_READ'
  // Lot 35C (CDC lookup_key V4) : opérations d'exploitation du catalogue
  // Stripe depuis le BO (synchronisation, reprise, publication de la grille du
  // code, reprise / abandon / retour arrière, information préalable des
  // abonnés). Aucune ne modifie un montant.
  | 'STRIPE_CATALOG_OPERATION';

export type AdminTargetType = 'ACCOUNT' | 'USER' | 'EXPORT_TEMPLATE' | 'COMMUNICATION_CHANNEL' | 'ANOMALY' | 'GDPR_REQUEST'
  | 'ASSISTANT_SETTING' | 'ASSISTANT_REQUEST' | 'NOTIFICATION' | 'AI_CACHE' | 'AI_METRICS'
  | 'OPS_BACKFILL' | 'SCHEDULED_TASK' | 'AI_EXECUTION' | 'STRIPE_CATALOG';

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
