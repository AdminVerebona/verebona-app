/**
 * Export RGPD « Mes données » — CDC Back-Office V1 GDP-020 à GDP-022, GDP-009.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CYCLE
 *
 *   demande (POST)  → `gdpr_exports` pending + demande système « Accès »
 *                     En cours (GDP-007) ;
 *   génération      → collecte (schéma) → filtre (pur) → ZIP (JSZip, déjà
 *                     utilisé par les exports de biens) → dépôt S3 via
 *                     `export-upload.service` ;
 *   prêt            → demande système Traitée ; si la réponse faite à
 *                     l'utilisateur était asynchrone, notification
 *                     GDPR_EXPORT_READY (GDP-021) ;
 *   échec           → erreur conservée sur l'export et sur la demande
 *                     (`last_error`), qui reste En cours : le BO la suit,
 *                     sans relance manuelle (GDP-009). L'utilisateur peut
 *                     relancer depuis Mon compte ; la même demande est
 *                     alors reprise, sans doublon au registre.
 *   téléchargement  → route authentifiée qui redirige vers une URL S3
 *                     présignée courte (GDP-022). L'archive expire après
 *                     GDPR_EXPORT_RETENTION_HOURS, puis est supprimée.
 *
 * `export_generation` n'est pas réutilisée : elle est rattachée à un bien
 * (`asset_id NOT NULL`) et porte des payloads de dossiers métier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import JSZip from 'jszip';
import { pgClient } from '@/db';
import { buildGdprExportContent, partManifest, planExportParts, type ExportPartPlan } from './export-content';
import { collectUserData } from './export-collector';
import { upsertSystemRequest, updateSystemRequest } from './system-requests';

/* ── Paramètres techniques (GDP-022 : durée à définir) ────────────────── */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
/** Durée de conservation de l'archive générée. */
const RETENTION_HOURS = () => envInt('GDPR_EXPORT_RETENTION_HOURS', 72);
/** Durée de validité de l'URL S3 présignée délivrée au clic. */
const LINK_TTL_SECONDS = () => envInt('GDPR_EXPORT_LINK_TTL_SECONDS', 300);
/**
 * Lot 102C — taille maximale des documents d'UNE partie de l'archive. Plus
 * aucun plafond global : tous les originaux sont livrés, répartis en parties
 * numérotées (`planExportParts`). Borne mémoire : une partie est construite,
 * déposée puis libérée avant la suivante. L'ancienne variable
 * GDPR_EXPORT_MAX_DOCUMENT_BYTES (plafond global) n'est plus lue.
 */
export const PART_MAX_BYTES = () => envInt('GDPR_EXPORT_PART_MAX_BYTES', 100 * 1024 * 1024);
/** Garde-fou du nombre de parties (cas théorique au vu des quotas d'offre). */
export const MAX_PARTS = () => envInt('GDPR_EXPORT_MAX_PARTS', 200);
/**
 * Sans progression depuis ce délai, une génération « en cours » est
 * considérée comme interrompue (lot 102C : mesuré depuis la dernière partie
 * déposée, une archive en plusieurs parties peut durer plus longtemps).
 */
const STALE_MINUTES = 20;

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
}

export interface GdprExportPartState {
  number: number;
  sizeBytes: number | null;
  documents: number;
}

type Raw = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function toState(r: Raw, parts: Raw[] = []): GdprExportState {
  const partStates: GdprExportPartState[] = parts.length
    ? parts.map((p) => ({ number: Number(p.part_number), sizeBytes: p.size_bytes == null ? null : Number(p.size_bytes), documents: Number(p.document_count ?? 0) }))
    : (r.status === 'ready' && r.s3_key ? [{ number: 1, sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), documents: Number((r.summary as Raw | null)?.documents ?? 0) }] : []);
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

/** Clôt les générations interrompues (processus arrêté) et les archives expirées de l'utilisateur. */
async function sweepUser(userId: number): Promise<void> {
  const stale = await pgClient<Raw[]>`
    UPDATE gdpr_exports
       SET status = 'error', error_message = 'GENERATION_INTERRUPTED', completed_at = now()
     WHERE user_id = ${userId} AND status IN ('pending', 'generating')
       AND coalesce(progress_at, started_at, created_at) < now() - make_interval(mins => ${STALE_MINUTES})
     RETURNING request_id`;
  for (const s of stale) {
    if (s.request_id) await updateSystemRequest({ id: Number(s.request_id) }, { lastError: 'Génération interrompue.' });
  }
  await purgeExpiredExports({ userId });
}

/** Dernier export de l'utilisateur (état affiché dans Mon compte). */
export async function getLatestExport(userId: number): Promise<GdprExportState | null> {
  await sweepUser(userId);
  const [row] = await pgClient<Raw[]>`
    SELECT * FROM gdpr_exports WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 1`;
  return row ? toState(row, row.status === 'ready' ? await partsOf(Number(row.id)) : []) : null;
}

/**
 * Enregistre une demande d'export. Idempotent : une génération déjà en cours
 * est renvoyée telle quelle (double clic, ERR-002).
 */
export async function requestGdprExport(userId: number): Promise<{ export: GdprExportState; created: boolean }> {
  await sweepUser(userId);

  const [active] = await pgClient<Raw[]>`
    SELECT * FROM gdpr_exports WHERE user_id = ${userId} AND status IN ('pending', 'generating')
     ORDER BY id DESC LIMIT 1`;
  if (active) return { export: toState(active), created: false };

  // Lot 102C : en état restreint (rétractation, fin d'abonnement, suppression
  // demandée) l'adhésion peut ne plus être « active » : repli sur le compte
  // dont l'utilisateur est titulaire, pour que l'export reste rattaché.
  const [membership] = await pgClient<{ account_id: number }[]>`
    SELECT account_id FROM (
      SELECT account_id, 0 AS rang, id FROM account_memberships WHERE user_id = ${userId} AND lower(status) = 'active'
      UNION ALL
      SELECT id AS account_id, 1 AS rang, id FROM accounts WHERE owner_user_id = ${userId}
    ) c ORDER BY rang, id LIMIT 1`;
  const accountId = membership ? Number(membership.account_id) : null;

  // Relance après un échec : la demande restée ouverte est reprise.
  const [openRequest] = await pgClient<{ id: number }[]>`
    SELECT r.id FROM gdpr_requests r
     WHERE r.origin = 'system' AND r.status <> 'done' AND r.subject_user_ref = ${userId}
       AND r.source_ref LIKE 'gdpr_export:%'
     ORDER BY r.id DESC LIMIT 1`;

  let row: Raw;
  try {
    [row] = await pgClient<Raw[]>`
      INSERT INTO gdpr_exports (user_id, account_id, request_id, status)
      VALUES (${userId}, ${accountId}, ${openRequest?.id ?? null}, 'pending')
      RETURNING *`;
  } catch (e) {
    // Course entre deux requêtes : l'index unique a gardé la première.
    if ((e as { code?: string }).code === '23505') {
      const [again] = await pgClient<Raw[]>`
        SELECT * FROM gdpr_exports WHERE user_id = ${userId} AND status IN ('pending', 'generating') LIMIT 1`;
      if (again) return { export: toState(again), created: false };
    }
    throw e;
  }

  if (!openRequest) {
    const requestId = await upsertSystemRequest({
      sourceRef: `gdpr_export:${row.id}`,
      rightType: 'access',
      userId,
      accountId,
      receivedAt: new Date(row.created_at as string),
      status: 'in_progress',
    }).catch((e) => {
      console.error('[gdpr-export] registre non alimenté :', (e as Error).message);
      return null;
    });
    if (requestId) await pgClient`UPDATE gdpr_exports SET request_id = ${requestId} WHERE id = ${Number(row.id)}`;
  } else {
    await updateSystemRequest({ id: openRequest.id }, { lastError: null });
  }

  return { export: toState(row), created: true };
}

/**
 * Génère l'archive. Verrou : seule la transition pending → generating
 * autorise la génération ; un second appel ne fait rien.
 */
export async function runGdprExport(exportId: number): Promise<GdprExportState | null> {
  const [claimed] = await pgClient<Raw[]>`
    UPDATE gdpr_exports
       SET status = 'generating', started_at = now(), attempt_count = attempt_count + 1
     WHERE id = ${exportId} AND status = 'pending'
     RETURNING *`;
  if (!claimed) return null;

  const userId = Number(claimed.user_id);
  const requestId = claimed.request_id == null ? null : Number(claimed.request_id);
  const now = new Date();

  try {
    const data = await collectUserData(userId);
    // Lot 102C : TOUS les documents, répartis en parties de taille bornée.
    const plan = planExportParts(data.documents, { maxPartBytes: PART_MAX_BYTES(), maxParts: MAX_PARTS() });
    const day = now.toISOString().slice(0, 10);
    const total = plan.parts.length;
    const fileNameOf = (n: number) => (total === 1
      ? `verebona-mes-donnees-${day}.zip`
      : `verebona-mes-donnees-${day}-partie-${String(n).padStart(String(total).length, '0')}-sur-${total}.zip`);
    const content = buildGdprExportContent({
      generatedAt: now, userId, accountIds: data.accountIds, tables: data.tables, documents: plan,
      parts: plan.parts.map((p) => ({ plan: p, fileName: fileNameOf(p.number) })),
    });

    const { downloadStoredFile } = await import('./gdpr-storage');
    const { uploadExportFile } = await import('@/services/export-upload.service');
    // Reprise propre d'une tentative précédente (parties d'un échec).
    await pgClient`DELETE FROM gdpr_export_parts WHERE export_id = ${exportId}`.catch(() => undefined);

    let totalBytes = 0;
    let missingTotal = 0;
    let firstKey: string | null = null;
    for (const part of plan.parts) {
      const zip = new JSZip();
      if (part.number === 1) for (const [path, text] of Object.entries(content.textFiles)) zip.file(path, text);
      zip.file(`manifest-partie-${part.number}.json`, partManifest({ generatedAt: now, part, totalParts: total }));
      const missing = await addPartDocuments(zip, part, downloadStoredFile);
      if (missing.length) {
        zip.file('documents/NON-RECUPERES.txt',
          `Documents de cette partie qui n'ont pas pu être relus lors de la génération (identifiants) : ${missing.join(', ')}\n`);
      }
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const s3Key = `gdpr-exports/${userId}/${exportId}/${fileNameOf(part.number)}`;
      await uploadExportFile(buffer, s3Key, 'application/zip');
      firstKey ??= s3Key;
      totalBytes += buffer.length;
      missingTotal += missing.length;
      await recordPart(exportId, part, s3Key, buffer.length, missing.length);
    }

    const summary = {
      tables: content.manifest.tables.length,
      rows: content.manifest.tables.reduce((n, t) => n + t.rows, 0),
      documents: plan.include.length - missingTotal,
      documentsSkipped: plan.skipped.length + missingTotal,
      parts: total,
    };
    const [ready] = await pgClient<Raw[]>`
      UPDATE gdpr_exports
         SET status = 'ready', s3_key = ${firstKey}, size_bytes = ${totalBytes}, parts_count = ${total},
             summary = ${JSON.stringify(summary)}::jsonb, error_message = NULL, completed_at = now(), progress_at = now(),
             expires_at = now() + make_interval(hours => ${RETENTION_HOURS()})
       WHERE id = ${exportId}
       RETURNING *`;

    if (requestId) {
      const expires = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })
        .format(new Date(ready.expires_at as string));
      await updateSystemRequest({ id: requestId }, {
        status: 'done',
        lastError: null,
        result: `Archive générée (${summary.tables} catégories, ${summary.rows} enregistrements, ` +
          `${summary.documents} document(s)${summary.documentsSkipped ? `, ${summary.documentsSkipped} non joint(s)` : ''}` +
          `${total > 1 ? `, en ${total} parties` : ''}) ` +
          `et mise à disposition jusqu’au ${expires}.`,
      }).catch((e) => console.error('[gdpr-export] registre non mis à jour :', (e as Error).message));
    }

    await notifyIfDue(exportId);
    return toState(ready, await partsOf(exportId));
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    console.error(`[gdpr-export] export #${exportId} en échec :`, message);
    const [failed] = await pgClient<Raw[]>`
      UPDATE gdpr_exports SET status = 'error', error_message = ${message.slice(0, 2000)}, completed_at = now()
       WHERE id = ${exportId} RETURNING *`;
    if (requestId) {
      await updateSystemRequest({ id: requestId }, { lastError: `Échec de génération : ${message.slice(0, 500)}` })
        .catch(() => undefined);
    }
    return failed ? toState(failed) : null;
  }
}

/** Documents d'une partie lus un à un (mémoire bornée à la partie). Renvoie les identifiants non relus. */
async function addPartDocuments(
  zip: JSZip,
  part: ExportPartPlan,
  download: (key: string, bucket?: string | null) => Promise<Buffer | null>,
): Promise<number[]> {
  const missing: number[] = [];
  for (const doc of part.documents) {
    const buffer = await download(doc.s3Key!, doc.s3Bucket);
    if (buffer) zip.file(doc.path, buffer);
    else missing.push(doc.id);
  }
  return missing;
}

/** Partie déposée : enregistrée et progression notée (la génération n'est pas « interrompue »). */
async function recordPart(exportId: number, part: ExportPartPlan, s3Key: string, size: number, missing: number): Promise<void> {
  await pgClient`
    INSERT INTO gdpr_export_parts (export_id, part_number, s3_key, size_bytes, document_count, missing_count)
    VALUES (${exportId}, ${part.number}, ${s3Key}, ${size}, ${part.documents.length - missing}, ${missing})
    ON CONFLICT (export_id, part_number) DO UPDATE
       SET s3_key = EXCLUDED.s3_key, size_bytes = EXCLUDED.size_bytes,
           document_count = EXCLUDED.document_count, missing_count = EXCLUDED.missing_count`;
  await pgClient`UPDATE gdpr_exports SET progress_at = now() WHERE id = ${exportId}`;
}

/**
 * La réponse faite à l'utilisateur a été asynchrone : il sera notifié quand
 * l'archive sera prête. Si elle l'est déjà (course), la notification part
 * immédiatement.
 */
export async function markNotifyOnReady(exportId: number): Promise<void> {
  await pgClient`UPDATE gdpr_exports SET notify_on_ready = true WHERE id = ${exportId}`;
  await notifyIfDue(exportId);
}

/** Envoie la notification « export prêt » une seule fois (garde atomique). */
async function notifyIfDue(exportId: number): Promise<void> {
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
 * généré au clic, valable GDPR_EXPORT_LINK_TTL_SECONDS.
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

/** Supprime les archives expirées (objet S3 + état `expired`). */
export async function purgeExpiredExports(scope: { userId?: number; limit?: number } = {}): Promise<number> {
  const rows = await pgClient<Raw[]>`
    SELECT id, s3_key FROM gdpr_exports
     WHERE status = 'ready' AND expires_at <= now()
       ${scope.userId ? pgClient`AND user_id = ${scope.userId}` : pgClient``}
     ORDER BY expires_at LIMIT ${scope.limit ?? 50}`;
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
    await pgClient`UPDATE gdpr_exports SET status = 'expired', s3_key = NULL WHERE id = ${Number(r.id)}`;
    n++;
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
  return { purged, batches };
}

