/**
 * Export RGPD « Mes données » — CDC Back-Office V1 GDP-020 à GDP-022, GDP-009.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CYCLE (lot 103C : génération DURABLE, voir `gdpr-export.job.ts`)
 *
 *   demande (POST)  → dans UNE transaction (verrou par utilisateur) :
 *                     ligne `gdpr_exports` `pending` = travail en file,
 *                     identifiant de corrélation, clé d'idempotence du
 *                     client. Double clic, POST parallèles ou rejoués :
 *                     la demande active (ou de même clé) est renvoyée,
 *                     jamais une seconde archive. Puis, HORS transaction et
 *                     sans jamais bloquer : registre `gdpr_requests`
 *                     (GDP-007) — un échec y est noté comme DETTE et rejoué ;
 *   génération      → worker des exports (bail, tentatives bornées,
 *                     reprise après arrêt du processus) : collecte paginée
 *                     → fichiers temporaires → ZIP en flux → dépôt S3 en
 *                     parties ; manifeste construit depuis les fichiers
 *                     réellement présents ; COMPLÈTE ou PARTIELLE ;
 *   prêt            → demande système Traitée ; notification
 *                     GDPR_EXPORT_READY (GDP-021, une seule fois) ;
 *   échec           → après les tentatives automatiques : code stable,
 *                     référence, demande du registre restée En cours avec
 *                     `last_error` (GDP-009), anomalie de Supervision
 *                     compacte. L'utilisateur peut relancer (la même demande
 *                     du registre est reprise) ; après des échecs répétés,
 *                     il est orienté vers l'assistance.
 *   téléchargement  → route authentifiée qui redirige vers une URL S3
 *                     présignée courte (GDP-022). L'archive expire après
 *                     GDPR_EXPORT_RETENTION_HOURS, puis est supprimée.
 *
 * `export_generation` n'est pas réutilisée : elle est rattachée à un bien
 * (`asset_id NOT NULL`) et porte des payloads de dossiers métier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import { pgClient } from '@/db';
import { gdprExportView, type GdprExportView } from './export-state';
import type { MissingItem } from './export-content';
import { syncGdprRegistry } from './gdpr-export.job';

/* ── Paramètres techniques (GDP-022) ──────────────────────────────────── */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
/** Durée de validité de l'URL S3 présignée délivrée au clic. */
const LINK_TTL_SECONDS = () => envInt('GDPR_EXPORT_LINK_TTL_SECONDS', 300);

type GdprExportStatus = 'pending' | 'generating' | 'ready' | 'error' | 'expired';

export interface GdprExportState {
  id: number;
  status: GdprExportStatus;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  error: string | null;
  /** Lot 102C : parties téléchargeables (1 pour une archive unique). */
  parts: GdprExportPartState[];
  /** Lot 103C : archive prête COMPLÈTE ou PARTIELLE. */
  completeness: 'complete' | 'partial' | null;
  /** Lot 103C : inventaire des manques (archive partielle, 50 premiers). */
  missing: Array<{ label: string; reason: string }>;
  missingCount: number;
  /** Lot 103C : état unique présenté (message, action possible, référence). */
  view: GdprExportView;
}

export interface GdprExportPartState {
  number: number;
  sizeBytes: number | null;
  documents: number;
}

type Raw = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

const REASON_LABELS: Record<string, string> = {
  OBJECT_MISSING: 'fichier introuvable dans le stockage',
  READ_FAILED: 'lecture momentanément impossible',
  PART_LIMIT: 'nombre maximal de parties atteint',
  ROW_LIMIT: 'catégorie lue en partie seulement',
  DEPTH_LIMIT: 'catégorie lue en partie seulement',
};

function toState(r: Raw, parts: Raw[] = [], consecutiveFailures = 1): GdprExportState {
  const summary = (r.summary ?? {}) as Raw;
  const partStates: GdprExportPartState[] = parts.length
    ? parts.map((p) => ({ number: Number(p.part_number), sizeBytes: p.size_bytes == null ? null : Number(p.size_bytes), documents: Number(p.document_count ?? 0) }))
    : (r.status === 'ready' && r.s3_key ? [{ number: 1, sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), documents: Number(summary.documents ?? 0) }] : []);
  const completeness = r.status === 'ready' ? ((r.completeness as 'complete' | 'partial' | null) ?? 'complete') : null;
  const missingList = Array.isArray(summary.missing) ? (summary.missing as MissingItem[]) : [];
  const missingCount = completeness === 'partial' ? Number(summary.missingCount ?? missingList.length) : 0;
  return {
    id: Number(r.id),
    status: r.status as GdprExportStatus,
    createdAt: iso(r.created_at)!,
    completedAt: iso(r.completed_at),
    expiresAt: iso(r.expires_at),
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    // Message destiné à l'utilisateur : jamais le détail technique.
    error: r.status === 'error' ? 'La génération de l’archive a échoué.' : null,
    parts: r.status === 'ready' ? partStates : [],
    completeness,
    missing: completeness === 'partial'
      ? missingList.slice(0, 50).map((m) => ({
        label: m.kind === 'document' ? `Document « ${m.name} »` : `Catégorie « ${m.table} »`,
        reason: REASON_LABELS[m.reason] ?? m.reason,
      }))
      : [],
    missingCount,
    view: gdprExportView({
      status: String(r.status),
      completeness,
      expiresAt: iso(r.expires_at),
      errorCode: (r.error_code as string | null) ?? null,
      correlationId: (r.correlation_id as string | null) ?? null,
      nextAttemptAt: iso(r.next_attempt_at),
      missingCount,
    }, { consecutiveFailures }),
  };
}

async function partsOf(exportId: number): Promise<Raw[]> {
  try {
    return await pgClient<Raw[]>`
      SELECT part_number, size_bytes, document_count FROM gdpr_export_parts
       WHERE export_id = ${exportId} AND s3_key IS NOT NULL ORDER BY part_number`;
  } catch {
    return []; // migration 0915 absente : archive unique historique
  }
}

/** Demandes consécutives terminées en échec (la plus récente d'abord). */
async function consecutiveFailures(userId: number): Promise<number> {
  const rows = await pgClient<{ status: string }[]>`
    SELECT status FROM gdpr_exports WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 10`;
  let n = 0;
  for (const r of rows) { if (r.status === 'error') n++; else break; }
  return n;
}

/** Réveille le worker de cette instance (sans effet s'il n'y est pas démarré). */
async function nudgeWorker(): Promise<void> {
  try {
    const { nudgeExportWorker } = await import('@/services/exports/v12/generation/worker');
    nudgeExportWorker();
  } catch { /* le tour périodique prendra la demande */ }
}

/** Dernier export de l'utilisateur (état affiché dans Mon compte). */
export async function getLatestExport(userId: number): Promise<GdprExportState | null> {
  await purgeExpiredExports({ userId }).catch(() => 0);
  const [row] = await pgClient<Raw[]>`
    SELECT * FROM gdpr_exports WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 1`;
  if (!row) return null;
  if (row.status === 'pending') void nudgeWorker();
  return toState(row, row.status === 'ready' ? await partsOf(Number(row.id)) : [], row.status === 'error' ? await consecutiveFailures(userId) : 0);
}

/**
 * Enregistre une demande d'export — atomique et idempotente (§3 B).
 *
 * Verrou consultatif par utilisateur DANS la transaction d'insertion : deux
 * POST simultanés sont sérialisés ; le second trouve la demande active (ou
 * celle de même clé client) et la renvoie (`created: false`). Une demande
 * active est TOUJOURS exécutable : c'est une ligne de la file du worker,
 * reprise même si le processus qui l'a enregistrée s'arrête.
 *
 * Le registre RGPD est alimenté ENSUITE, hors transaction : son échec ne
 * fait jamais échouer la demande (dette notée, rejouée).
 */
export async function requestGdprExport(userId: number, opts: { clientKey?: string | null } = {}): Promise<{ export: GdprExportState; created: boolean }> {
  await purgeExpiredExports({ userId }).catch(() => 0);
  const clientKey = opts.clientKey ?? null;

  const { row, created } = await pgClient.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('gdpr_export_request'), ${userId})`;
    if (clientKey) {
      const [same] = await tx<Raw[]>`
        SELECT * FROM gdpr_exports WHERE user_id = ${userId} AND client_request_key = ${clientKey} ORDER BY id DESC LIMIT 1`;
      if (same) return { row: same, created: false };
    }
    const [active] = await tx<Raw[]>`
      SELECT * FROM gdpr_exports WHERE user_id = ${userId} AND status IN ('pending', 'generating')
       ORDER BY id DESC LIMIT 1`;
    if (active) return { row: active, created: false };

    // Lot 102C : en état restreint (rétractation, fin d'abonnement, suppression
    // demandée) l'adhésion peut ne plus être « active » : repli sur le compte
    // dont l'utilisateur est titulaire, pour que l'export reste rattaché.
    const [membership] = await tx<{ account_id: number }[]>`
      SELECT account_id FROM (
        SELECT account_id, 0 AS rang, id FROM account_memberships WHERE user_id = ${userId} AND lower(status) = 'active'
        UNION ALL
        SELECT id AS account_id, 1 AS rang, id FROM accounts WHERE owner_user_id = ${userId}
      ) c ORDER BY rang, id LIMIT 1`;
    const accountId = membership ? Number(membership.account_id) : null;
    const [inserted] = await tx<Raw[]>`
      INSERT INTO gdpr_exports (user_id, account_id, status, correlation_id, client_request_key, notify_on_ready, registry_pending)
      VALUES (${userId}, ${accountId}, 'pending', ${randomUUID()}, ${clientKey}, true, true)
      RETURNING *`;
    return { row: inserted, created: true };
  });

  if (created) {
    console.info(`[gdpr-export] demande enregistrée : export #${String(row.id)} réf=${String(row.correlation_id)} utilisateur #${userId}`);
    await syncGdprRegistry(Number(row.id)); // ne lève jamais
    void nudgeWorker();
  }
  const [fresh] = await pgClient<Raw[]>`SELECT * FROM gdpr_exports WHERE id = ${Number(row.id)}`;
  const current = fresh ?? row;
  return {
    export: toState(current, current.status === 'ready' ? await partsOf(Number(current.id)) : [], current.status === 'error' ? await consecutiveFailures(userId) : 0),
    created,
  };
}

/** Envoie la notification « export prêt » une seule fois (garde atomique). */
export async function notifyGdprExportIfDue(exportId: number): Promise<void> {
  const [row] = await pgClient<Raw[]>`
    UPDATE gdpr_exports SET notified_at = now()
     WHERE id = ${exportId} AND status = 'ready' AND notify_on_ready AND notified_at IS NULL
     RETURNING user_id, account_id, expires_at`;
  if (!row) return;
  try {
    const { emit } = await import('@/lib/notifications/event-service');
    await emit({
      type: 'GDPR_EXPORT_READY',
      payload: { exportId, expiresAt: iso(row.expires_at) ?? undefined },
      recipientUserIds: [Number(row.user_id)],
      accountId: row.account_id == null ? null : Number(row.account_id),
      entityType: 'gdpr_export',
      entityId: exportId,
      dedupeKey: `gdpr-export-ready:${exportId}`,
    });
  } catch (e) {
    console.error(`[gdpr-export] notification #${exportId} non émise :`, (e as Error).message);
  }
}

/**
 * URL présignée courte d'une partie de l'archive prête et non expirée de
 * l'utilisateur (partie 1 par défaut). Lot 102C : chaque partie a son lien,
 * généré au clic, valable GDPR_EXPORT_LINK_TTL_SECONDS. Archive PARTIELLE
 * comprise (ses manques sont annoncés). Toujours filtrée par utilisateur :
 * aucun lien vers l'archive d'un autre.
 */
export async function getDownloadUrl(userId: number, opts: { exportId?: number; part?: number } | number = {}): Promise<string | null> {
  const o = typeof opts === 'number' ? { exportId: opts } : opts;
  const part = o.part && Number.isSafeInteger(o.part) && o.part > 0 ? o.part : 1;
  const [row] = await pgClient<Raw[]>`
    SELECT id, s3_key FROM gdpr_exports
     WHERE user_id = ${userId} AND status = 'ready' AND s3_key IS NOT NULL AND expires_at > now()
       ${o.exportId ? pgClient`AND id = ${o.exportId}` : pgClient``}
     ORDER BY id DESC LIMIT 1`;
  if (!row) return null;
  let key: string | null = part === 1 ? (row.s3_key as string) : null;
  const parts = await pgClient<Raw[]>`
    SELECT s3_key FROM gdpr_export_parts WHERE export_id = ${Number(row.id)} AND part_number = ${part} AND s3_key IS NOT NULL`
    .catch(() => [] as Raw[]);
  if (parts[0]?.s3_key) key = parts[0].s3_key as string;
  if (!key) return null;
  const { getExportSignedUrl } = await import('@/services/export-upload.service');
  // Nom proposé : celui de la partie (« verebona-mes-donnees-AAAA-MM-JJ[-partie-N-sur-T].zip »).
  return getExportSignedUrl(key, LINK_TTL_SECONDS(), key.split('/').pop() || 'verebona-mes-donnees.zip');
}

/**
 * Supprime les archives expirées (objets S3 + état `expired`) et, lot 103C,
 * les parties restées en stockage d'un export en ÉCHEC (suppression manquée).
 */
export async function purgeExpiredExports(scope: { userId?: number; limit?: number } = {}): Promise<number> {
  const rows = await pgClient<Raw[]>`
    SELECT id, s3_key, status FROM gdpr_exports e
     WHERE ((e.status = 'ready' AND e.expires_at <= now())
         OR (e.status = 'error' AND EXISTS (SELECT 1 FROM gdpr_export_parts p WHERE p.export_id = e.id AND p.s3_key IS NOT NULL)))
       ${scope.userId ? pgClient`AND e.user_id = ${scope.userId}` : pgClient``}
     ORDER BY e.id LIMIT ${scope.limit ?? 50}`;
  if (!rows.length) return 0;
  const { deleteStoredFile } = await import('./gdpr-storage');
  let n = 0;
  for (const r of rows) {
    // Lot 102C : toutes les parties (la partie 1 est aussi `s3_key`).
    const partKeys = (await pgClient<Raw[]>`
      SELECT s3_key FROM gdpr_export_parts WHERE export_id = ${Number(r.id)} AND s3_key IS NOT NULL`.catch(() => [] as Raw[]))
      .map((p) => p.s3_key as string);
    const keys = [...new Set([...(r.s3_key ? [r.s3_key as string] : []), ...partKeys])];
    let ok = true;
    for (const key of keys) ok = (await deleteStoredFile(key)) && ok;
    if (!ok) continue;
    await pgClient`UPDATE gdpr_export_parts SET s3_key = NULL WHERE export_id = ${Number(r.id)}`.catch(() => undefined);
    if (r.status === 'ready') {
      await pgClient`UPDATE gdpr_exports SET status = 'expired', s3_key = NULL WHERE id = ${Number(r.id)}`;
      n++;
    } else {
      await pgClient`UPDATE gdpr_exports SET s3_key = NULL WHERE id = ${Number(r.id)}`;
    }
  }
  return n;
}

/**
 * Purge planifiée de TOUTES les archives expirées (tâche quotidienne).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'EXPIRATION N'ÉTAIT APPLIQUÉE QU'EN PASSANT
 *
 * `purgeExpiredExports` n'était appelée que lorsqu'un utilisateur demandait
 * un export : sans nouvelle demande, une archive « expirée » — un ZIP de
 * TOUTES les données personnelles d'un utilisateur — restait indéfiniment
 * dans le stockage, alors que la durée de conservation annoncée
 * (GDPR_EXPORT_RETENTION_HOURS, GDP-022) est une promesse de suppression.
 *
 * Lots de 50, bornés : une archive dont la suppression échoue (stockage
 * injoignable) reste `ready` et serait relue à chaque lot — la borne évite
 * de boucler, le passage suivant réessaiera.
 *
 * Lot 103C : le même passage rejoue la dette du registre RGPD et rattrape
 * les générations orphelines (filet quotidien en plus du worker).
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function purgeAllExpiredExports(maxBatches = 20): Promise<{ purged: number; batches: number }> {
  const BATCH = 50;
  let purged = 0;
  let batches = 0;
  while (batches < maxBatches) {
    batches += 1;
    const n = await purgeExpiredExports({ limit: BATCH });
    purged += n;
    if (n < BATCH) break;
  }
  try {
    const { gdprExportMaintenance } = await import('./gdpr-export.job');
    await gdprExportMaintenance(true);
  } catch (e) {
    console.error('[gdpr-export] rattrapage quotidien impossible :', (e as Error).message);
  }
  return { purged, batches };
}
