/**
 * Copies de données réelles (production) hors production — lot 102C.
 * Ticket conformité légale, P1 « Garantir suppression/expiration des copies
 * de production en préproduction ». Règles pures : `./rules.ts` (inventaire
 * des mécanismes en tête de fichier).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GARANTIES
 *
 *   (a) TRACÉE — `production_data_copies` : origine (point de restauration
 *       d'un autre environnement / copie de base détectée), environnements
 *       source et cible, date d'autorisation et d'import, responsable
 *       (administrateur nominatif ou « détection automatique »), motif ;
 *   (b) EXPIRATION AUTOMATIQUE — échéance = import + PRODUCTION_COPY_RETENTION_DAYS
 *       (défaut 30 j) ; tâche quotidienne `daily-production-copies` : les
 *       comptes présents dans la copie sont supprimés par le workflow de
 *       suppression EXISTANT (`scheduleDeletion` motif ADMIN, origine
 *       système, délai 0, puis `executeScheduledDeletion` — même périmètre
 *       que la suppression BO : base, fichiers en file de purge) ;
 *   (c) VISIBLE — anomalie de Supervision « Copie de données réelles
 *       présente » tant qu'une copie est active (ou en purge), résolue seule
 *       après la purge ;
 *   IMPORT REFUSÉ PAR DÉFAUT — un point de restauration d'un autre
 *       environnement n'est restaurable qu'après une autorisation BO
 *       explicite pour CE point (motif, administrateur, journal d'audit
 *       `PRODUCTION_COPY_AUTHORIZE`), valable PRODUCTION_COPY_AUTHORIZATION_HOURS.
 *   (d) LOT 104A — SUPPRESSIONS DE PRODUCTION PROPAGÉES : chaque copie
 *       inventorie ses comptes et utilisateurs (empreintes des identifiants
 *       source, `production_copy_subjects`) ; une suppression en production
 *       les purge sans attendre l'échéance (`deletion-propagation.service`).
 *       Politique prudente : AUCUNE autorisation ni restauration d'un point
 *       d'un autre environnement tant que la propagation n'est pas
 *       configurée ET vérifiée (`deletionPropagationReadiness`).
 *
 * En PRODUCTION, rien de tout cela ne s'applique (aucune purge possible).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import { pgClient } from '@/db';
import {
  addDays, authorizationValidityHours, classifyRestoreOrigin, copyRetentionDays, currentEnvironmentName,
  decideRestoreOrigin, detectDatabaseCopy, isProductionEnvironment, type RestoreOriginDecision,
} from './rules';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

export const PRODUCTION_COPY_FINGERPRINT_PARTS = ['production-copy', 'present'] as const;

export interface ProductionCopy {
  id: number;
  origin: 'restore_point' | 'database_copy';
  sourceEnvironment: string;
  targetEnvironment: string;
  backupId: string | null;
  status: 'authorized' | 'active' | 'purging' | 'purged' | 'closed' | 'expired_unused';
  reason: string;
  responsibleEmail: string | null;
  authorizedAt: string;
  importedAt: string | null;
  expiresAt: string;
  accounts: number;
  purgedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  lastError: string | null;
  /** Lot 104A : instant de l'état source copié (point de restauration). */
  sourceSnapshotAt: string | null;
  /** Lot 104A : inventaire des comptes copiés établi (propagation des suppressions). */
  subjectsCapturedAt: string | null;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function toCopy(r: Row): ProductionCopy {
  return {
    id: Number(r.id),
    origin: r.origin as ProductionCopy['origin'],
    sourceEnvironment: String(r.source_environment),
    targetEnvironment: String(r.target_environment),
    backupId: (r.backup_id as string) ?? null,
    status: r.status as ProductionCopy['status'],
    reason: String(r.reason ?? ''),
    responsibleEmail: (r.responsible_email as string) ?? null,
    authorizedAt: iso(r.authorized_at)!,
    importedAt: iso(r.imported_at),
    expiresAt: iso(r.expires_at)!,
    accounts: Array.isArray(r.account_ids) ? (r.account_ids as unknown[]).length : 0,
    purgedAt: iso(r.purged_at),
    closedAt: iso(r.closed_at),
    closeReason: (r.close_reason as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    sourceSnapshotAt: iso(r.source_snapshot_at),
    subjectsCapturedAt: iso(r.subjects_captured_at),
  };
}

export class ProductionCopyError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'ProductionCopyError'; }
}

/* ── Lecture ─────────────────────────────────────────────────────────────── */

export async function listProductionCopies(sql: Sql = pgClient, limit = 100): Promise<ProductionCopy[]> {
  const rows = await sql<Row[]>`SELECT * FROM production_data_copies ORDER BY id DESC LIMIT ${limit}`;
  return rows.map(toCopy);
}

/** Autorisations restées inutilisées au-delà de leur validité : closes (`expired_unused`). */
async function expireStaleAuthorizations(sql: Sql, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - authorizationValidityHours() * 3_600_000);
  await sql`
    UPDATE production_data_copies SET status = 'expired_unused', updated_at = ${now.toISOString()}
     WHERE status = 'authorized' AND authorized_at < ${cutoff.toISOString()}`;
}

/* ── Autorisation BO d'un point d'un autre environnement ─────────────────── */

export async function authorizeRestoreImport(input: {
  backupId: string;
  reason: string;
  admin: { id: number; email: string };
  now?: Date;
  sql?: Sql;
  /** Tests : manifeste déjà lu. */
  manifestEnvironment?: string;
}): Promise<ProductionCopy> {
  const sql = input.sql ?? pgClient;
  const now = input.now ?? new Date();
  const reason = (input.reason ?? '').trim();
  if (reason.length < 10) throw new ProductionCopyError('REASON_REQUIRED', 'Motif obligatoire (10 caractères au moins).');
  if (reason.length > 1000) throw new ProductionCopyError('REASON_TOO_LONG', 'Motif limité à 1 000 caractères.');
  const target = currentEnvironmentName();
  if (!target) throw new ProductionCopyError('ENVIRONMENT_UNKNOWN', 'Environnement courant inconnu (NEXT_PUBLIC_APP_ENV) : autorisation impossible.', 409);
  if (isProductionEnvironment(target)) throw new ProductionCopyError('NOT_APPLICABLE', 'Sans objet en production.', 409);

  let source = input.manifestEnvironment;
  if (source === undefined) {
    const { findBackupManifest } = await import('@/services/backup/database-backup.service');
    const m = await findBackupManifest(input.backupId);
    if (!m) throw new ProductionCopyError('BACKUP_NOT_FOUND', 'Point de restauration introuvable.', 404);
    source = m.environment;
  }
  const origin = classifyRestoreOrigin(source);
  if (origin === 'same_environment') {
    throw new ProductionCopyError('SAME_ENVIRONMENT', 'Ce point provient de cet environnement : aucune autorisation n’est nécessaire.', 409);
  }

  // Lot 104A (P1-F) : pas d'import de données réelles sans garantie de
  // propagation des suppressions de production (configurée ET vérifiée).
  const { deletionPropagationReadiness } = await import('./deletion-propagation.service');
  const readiness = await deletionPropagationReadiness({ sql, now });
  if (!readiness.ready) {
    throw new ProductionCopyError('DELETION_PROPAGATION_NOT_READY',
      `Import de données réelles refusé : ${readiness.reason}. Voir docs/exploitation/copies-donnees-reelles-preproduction.md (§ 5).`, 409);
  }

  await expireStaleAuthorizations(sql, now);
  let row: Row;
  try {
    [row] = await sql<Row[]>`
      INSERT INTO production_data_copies (origin, source_environment, target_environment, backup_id, status, reason,
                                          responsible_admin_id, responsible_email, authorized_at, expires_at, created_at, updated_at)
      VALUES ('restore_point', ${(source || 'inconnu').trim().toLowerCase()}, ${target}, ${input.backupId}, 'authorized', ${reason},
              ${input.admin.id}, ${input.admin.email}, ${now.toISOString()}, ${addDays(now, copyRetentionDays()).toISOString()},
              ${now.toISOString()}, ${now.toISOString()})
      RETURNING *`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new ProductionCopyError('ALREADY_AUTHORIZED', 'Une autorisation est déjà ouverte pour ce point.', 409);
    }
    throw e;
  }
  const copy = toCopy(row);
  const { logAdminAction } = await import('@/lib/admin-audit');
  await logAdminAction({
    adminId: input.admin.id, adminEmail: input.admin.email, action: 'PRODUCTION_COPY_AUTHORIZE', targetType: 'PRODUCTION_COPY',
    targetId: copy.id, result: 'SUCCESS',
    after: { backupId: input.backupId, sourceEnvironment: copy.sourceEnvironment, targetEnvironment: target, origin },
    details: { reason, validityHours: authorizationValidityHours(), retentionDays: copyRetentionDays() },
  });
  return copy;
}

/**
 * Garde appelée par la restauration (lot 82E) AVANT toute écriture.
 * Lève jamais : rend la décision ; l'appelant refuse si `allowed: false`.
 */
export async function guardRestoreOrigin(manifestEnvironment: string | null | undefined, backupId: string, sql: Sql = pgClient, now = new Date()): Promise<RestoreOriginDecision> {
  const origin = classifyRestoreOrigin(manifestEnvironment);
  if (origin === 'same_environment') return { allowed: true, origin, copyId: null };
  let authorization = null;
  try {
    const [a] = await sql<Row[]>`
      SELECT id, backup_id, authorized_at FROM production_data_copies
       WHERE status = 'authorized' AND backup_id = ${backupId} ORDER BY id DESC LIMIT 1`;
    authorization = a ? { id: Number(a.id), backupId: String(a.backup_id), authorizedAt: new Date(a.authorized_at as string) } : null;
  } catch {
    authorization = null; // registre absent (0916) : refus par défaut
  }
  const decision = decideRestoreOrigin({ manifestEnvironment, backupId, authorization, now });
  // Lot 104A (P1-F) : même au dernier moment, aucune restauration d'un autre
  // environnement si la propagation des suppressions n'est pas (ou plus) vérifiée.
  if (decision.allowed && decision.origin !== 'same_environment' && !isProductionEnvironment(currentEnvironmentName())) {
    const { deletionPropagationReadiness } = await import('./deletion-propagation.service');
    const readiness = await deletionPropagationReadiness({ sql, now });
    if (!readiness.ready) {
      return { allowed: false, origin: decision.origin, reason: `Import de données réelles refusé : ${readiness.reason}.` };
    }
  }
  return decision;
}

/**
 * Restauration d'une copie autorisée réussie : copie active, échéance posée,
 * comptes inventoriés ; lot 104A : instant de l'état source et inventaire des
 * comptes / utilisateurs copiés (empreintes) pour la propagation des
 * suppressions de production.
 */
export async function markRestoreImported(copyId: number, sql: Sql = pgClient, now = new Date(), opts: { snapshotAt?: string | Date | null } = {}): Promise<void> {
  const snap = opts.snapshotAt ? new Date(opts.snapshotAt) : null;
  await sql`
    UPDATE production_data_copies
       SET status = 'active', imported_at = ${now.toISOString()},
           expires_at = ${addDays(now, copyRetentionDays()).toISOString()},
           account_ids = COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM accounts), '[]'::jsonb),
           source_snapshot_at = ${snap && !Number.isNaN(snap.getTime()) ? snap.toISOString() : null},
           updated_at = ${now.toISOString()}
     WHERE id = ${copyId}`;
  await captureSubjectsSafely(copyId, sql, now);
  await syncProductionCopiesAnomaly(sql);
}

/** Inventaire des sujets d'une copie (lot 104A) — ne fait jamais échouer l'appelant (rattrapage horaire). */
async function captureSubjectsSafely(copyId: number, sql: Sql, now: Date): Promise<void> {
  try {
    const { captureCopySubjects } = await import('./deletion-propagation.service');
    await captureCopySubjects(copyId, { sql, now });
  } catch (e) {
    console.error(`[production-copy] inventaire de la copie #${copyId} impossible (repris par la tâche horaire) :`, (e as Error).message);
  }
}

/* ── Détection d'une copie de base au démarrage ──────────────────────────── */

/**
 * Identité de la base : posée au premier démarrage (nom de l'environnement
 * courant). Base initialisée par la PRODUCTION et servie hors production →
 * copie de base détectée : tracée (responsable « détection automatique »),
 * échéance posée, Supervision. Ne lève jamais.
 */
export async function startupProductionCopyCheck(sql: Sql = pgClient, now = new Date()): Promise<{ detected: boolean; copyId: number | null }> {
  try {
    const current = currentEnvironmentName();
    if (!current) return { detected: false, copyId: null };
    await sql`
      INSERT INTO environment_identity (id, environment, initialized_at) VALUES (1, ${current}, ${now.toISOString()})
      ON CONFLICT (id) DO NOTHING`;
    const [id] = await sql<Row[]>`SELECT environment FROM environment_identity WHERE id = 1`;
    await sql`UPDATE environment_identity SET last_seen_environment = ${current}, last_seen_at = ${now.toISOString()} WHERE id = 1`;
    const d = detectDatabaseCopy({ storedEnvironment: (id?.environment as string) ?? null });
    let copyId: number | null = null;
    if (d.copy) {
      const [open] = await sql<Row[]>`
        SELECT id FROM production_data_copies
         WHERE origin = 'database_copy' AND status IN ('active', 'purging') ORDER BY id DESC LIMIT 1`;
      if (open) copyId = Number(open.id);
      else {
        const [row] = await sql<Row[]>`
          INSERT INTO production_data_copies (origin, source_environment, target_environment, status, reason, responsible_email,
                                              authorized_at, imported_at, expires_at, account_ids, created_at, updated_at)
          VALUES ('database_copy', ${d.source!}, ${d.target!}, 'active',
                  'Copie de base détectée au démarrage : la base a été initialisée par un environnement de production.',
                  'détection automatique', ${now.toISOString()}, ${now.toISOString()},
                  ${addDays(now, copyRetentionDays()).toISOString()},
                  COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM accounts), '[]'::jsonb),
                  ${now.toISOString()}, ${now.toISOString()})
          RETURNING id`;
        copyId = Number(row.id);
        await captureSubjectsSafely(copyId, sql, now);
        console.error(`[production-copy] COPIE DE BASE DÉTECTÉE : base initialisée par « ${d.source} », servie en « ${d.target} » — `
          + `copie #${copyId} tracée, purge planifiée dans ${copyRetentionDays()} jour(s).`);
      }
    }
    await syncProductionCopiesAnomaly(sql);
    return { detected: d.copy, copyId };
  } catch (e) {
    console.error('[production-copy] contrôle au démarrage impossible :', (e as Error).message);
    return { detected: false, copyId: null };
  }
}

/* ── Supervision ─────────────────────────────────────────────────────────── */

export async function syncProductionCopiesAnomaly(sql: Sql = pgClient): Promise<'reported' | 'resolved' | 'none'> {
  try {
    const { autoResolveAnomaly, buildFingerprint, reportAnomaly } = await import('@/services/admin/anomaly.service');
    const fingerprint = buildFingerprint('other', ...PRODUCTION_COPY_FINGERPRINT_PARTS);
    const rows = await sql<Row[]>`
      SELECT id, origin, source_environment, status, imported_at, expires_at, jsonb_array_length(account_ids) AS comptes, last_error
        FROM production_data_copies WHERE status IN ('active', 'purging') ORDER BY id`;
    if (rows.length) {
      const id = await reportAnomaly({
        domain: 'other',
        fingerprint,
        title: `Copie de données réelles présente dans cet environnement (${rows.length})`,
        detail: {
          copies: rows.map((r) => ({
            id: Number(r.id), origine: r.origin, source: r.source_environment, statut: r.status,
            importee: iso(r.imported_at), echeance: iso(r.expires_at), comptes: Number(r.comptes ?? 0), erreur: r.last_error ?? null,
          })),
          action: 'Purge automatique à l’échéance (tâche quotidienne). BO › Exploitation › Copies de données réelles — '
            + 'docs/exploitation/copies-donnees-reelles-preproduction.md.',
        },
      });
      return id === null ? 'none' : 'reported';
    }
    return (await autoResolveAnomaly(fingerprint, { origin: 'production_copies_check', cause: 'Aucune copie de données réelles active.' })) ? 'resolved' : 'none';
  } catch (e) {
    console.error('[production-copy] supervision impossible :', (e as Error).message);
    return 'none';
  }
}

/* ── Clôture BO ──────────────────────────────────────────────────────────── */

/**
 * Clôture explicite (journalisée) : annule une autorisation non utilisée, ou
 * clôt une copie de base détectée à tort (ex. variable d'environnement
 * renommée). Une copie IMPORTÉE par restauration ne se clôt pas : elle se
 * purge (`purgeNow` avance son échéance à maintenant).
 */
export async function closeProductionCopy(input: {
  id: number;
  reason: string;
  admin: { id: number; email: string };
  purgeNow?: boolean;
  now?: Date;
  sql?: Sql;
}): Promise<ProductionCopy> {
  const sql = input.sql ?? pgClient;
  const now = input.now ?? new Date();
  const reason = (input.reason ?? '').trim();
  if (reason.length < 10) throw new ProductionCopyError('REASON_REQUIRED', 'Motif obligatoire (10 caractères au moins).');
  const [cur] = await sql<Row[]>`SELECT * FROM production_data_copies WHERE id = ${input.id}`;
  if (!cur) throw new ProductionCopyError('NOT_FOUND', 'Copie introuvable.', 404);
  const before = toCopy(cur);
  let row: Row;
  if (input.purgeNow) {
    if (before.status !== 'active') throw new ProductionCopyError('INVALID_STATE', 'Seule une copie active peut être purgée par anticipation.', 409);
    [row] = await sql<Row[]>`UPDATE production_data_copies SET expires_at = ${now.toISOString()}, updated_at = ${now.toISOString()} WHERE id = ${input.id} RETURNING *`;
  } else {
    const closable = before.status === 'authorized' || (before.status === 'active' && before.origin === 'database_copy');
    if (!closable) throw new ProductionCopyError('INVALID_STATE', 'Cette copie ne peut pas être close : elle doit être purgée.', 409);
    [row] = await sql<Row[]>`
      UPDATE production_data_copies SET status = 'closed', closed_at = ${now.toISOString()}, closed_by_email = ${input.admin.email},
             close_reason = ${reason}, updated_at = ${now.toISOString()}
       WHERE id = ${input.id} RETURNING *`;
    if (before.origin === 'database_copy') await adoptCurrentEnvironment(sql, now);
    const { closeCopySubjects } = await import('./deletion-propagation.service');
    await closeCopySubjects(input.id, 'closed', sql, now).catch(() => undefined);
  }
  const { logAdminAction } = await import('@/lib/admin-audit');
  await logAdminAction({
    adminId: input.admin.id, adminEmail: input.admin.email, action: 'PRODUCTION_COPY_CLOSE', targetType: 'PRODUCTION_COPY',
    targetId: input.id, result: 'SUCCESS', before: { status: before.status, expiresAt: before.expiresAt },
    after: { status: row.status, expiresAt: iso(row.expires_at) }, details: { reason, purgeNow: !!input.purgeNow },
  });
  await syncProductionCopiesAnomaly(sql);
  return toCopy(row);
}

/** La base appartient désormais à l'environnement courant (après purge ou clôture d'une copie de base). */
async function adoptCurrentEnvironment(sql: Sql, now: Date): Promise<void> {
  const current = currentEnvironmentName();
  if (!current) return;
  await sql`UPDATE environment_identity SET environment = ${current}, initialized_at = ${now.toISOString()} WHERE id = 1`;
}

/* ── Purge planifiée ─────────────────────────────────────────────────────── */

export interface PurgeDeps {
  /** Supprime un compte par le workflow existant ; renvoie le statut d'exécution. */
  deleteAccount: (accountId: number, now: Date) => Promise<'executed' | 'missing' | string>;
}

/** Suppression d'un compte de la copie : workflow unique (`scheduleDeletion` + `executeScheduledDeletion`). */
async function deleteAccountByWorkflow(accountId: number, now: Date): Promise<'executed' | 'missing' | string> {
  const [acc] = await pgClient<Row[]>`SELECT owner_user_id FROM accounts WHERE id = ${accountId}`;
  if (!acc) return 'missing';
  const { scheduleDeletion, executeScheduledDeletion } = await import('@/services/account/scheduled-deletion.service');
  const owner = acc.owner_user_id == null ? null : Number(acc.owner_user_id);
  if (owner == null) return 'no_owner';
  const schedule = await scheduleDeletion({ accountId, userId: owner, reason: 'ADMIN', origin: 'system', confirmedAt: now, delayDays: 0 });
  const r = await executeScheduledDeletion(schedule.id, { now });
  return r.status;
}

/**
 * Purge des copies échues (tâche quotidienne). Jamais en production. Chaque
 * compte de la copie encore présent est supprimé ; une copie dont un compte
 * échoue reste « en purge » (reprise au passage suivant, anomalie ouverte).
 */
export async function purgeExpiredProductionCopies(
  opts: { now?: Date; sql?: Sql; deps?: PurgeDeps } = {},
): Promise<{ purged: number; failed: number; skipped?: string }> {
  const sql = opts.sql ?? pgClient;
  const now = opts.now ?? new Date();
  if (isProductionEnvironment(currentEnvironmentName())) return { purged: 0, failed: 0, skipped: 'production' };
  const deps = opts.deps ?? { deleteAccount: deleteAccountByWorkflow };
  await expireStaleAuthorizations(sql, now);
  const due = await sql<Row[]>`
    SELECT * FROM production_data_copies WHERE status IN ('active', 'purging') AND expires_at <= ${now.toISOString()} ORDER BY id`;
  let purged = 0;
  let failed = 0;
  for (const c of due) {
    const id = Number(c.id);
    await sql`UPDATE production_data_copies SET status = 'purging', purge_started_at = COALESCE(purge_started_at, ${now.toISOString()}), updated_at = ${now.toISOString()} WHERE id = ${id}`;
    const accountIds = (Array.isArray(c.account_ids) ? c.account_ids : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    const report: Record<string, number> = {};
    const errors: string[] = [];
    for (const accountId of accountIds) {
      try {
        const st = await deps.deleteAccount(accountId, now);
        report[st] = (report[st] ?? 0) + 1;
        if (st !== 'executed' && st !== 'missing') errors.push(`compte ${accountId} : ${st}`);
      } catch (e) {
        report.error = (report.error ?? 0) + 1;
        errors.push(`compte ${accountId} : ${(e as Error).message.slice(0, 200)}`);
      }
    }
    if (errors.length) {
      failed++;
      await sql`UPDATE production_data_copies SET purge_report = ${JSON.stringify(report)}::jsonb, last_error = ${errors.slice(0, 20).join(' ; ')}, updated_at = ${now.toISOString()} WHERE id = ${id}`;
      continue;
    }
    purged++;
    await sql`
      UPDATE production_data_copies SET status = 'purged', purged_at = ${now.toISOString()}, purge_report = ${JSON.stringify(report)}::jsonb,
             last_error = NULL, updated_at = ${now.toISOString()} WHERE id = ${id}`;
    if (c.origin === 'database_copy') await adoptCurrentEnvironment(sql, now);
    const { closeCopySubjects } = await import('./deletion-propagation.service');
    await closeCopySubjects(id, 'purged', sql, now).catch(() => undefined);
  }
  await syncProductionCopiesAnomaly(sql);
  return { purged, failed };
}
