/**
 * Demande d'export d'un bien — FAÇADE MÉTIER PARTAGÉE (Trello #753, CDC T2 §9.10, §14.3 W28, D27).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CORPS POUR DEUX APPELANTS
 *
 * Le corps de `POST /api/assets/[id]/exports` (type demandé, export de données
 * brutes produit dans la requête, mise en file d'un dossier prêt à l'emploi)
 * vivait dans la route. L'Assistant doit lancer exactement la même demande,
 * avec les mêmes contrôles (éligibilité, offre, dossier désactivé, seuils,
 * plafond de générations actives, limitation de débit) : le corps est ici, la
 * route et l'Assistant l'appellent tous les deux. Aucune règle n'est ajoutée
 * ni retirée ; la route traduit seulement l'issue en réponse HTTP, à
 * l'identique d'avant.
 *
 * Une demande d'export n'écrit AUCUNE donnée métier (bien, document, échéance,
 * événement de référence) : elle crée une ligne d'historique de génération et
 * un fichier. C'est pourquoi elle ne passe pas par un plan confirmé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { exportGenerations, accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { buildExportAssetSnapshot } from '@/services/exports/export-snapshot-source';
import { buildExportManifest } from '@/services/export-manifest.service';
import { isPremiumPlan } from '@/types/domain';
import { buildExportZip } from '@/services/export-zip.service';
import { uploadExportFile, buildExportS3Key } from '@/services/export-upload.service';
import type { AccessibleAsset } from '@/services/exports/export-access';
import { normalizeExportCode, EXPORT_BRUT_CODE, type ExportCode } from '@/services/exports/catalog';
import { EXPORT_ERROR_MESSAGES, technicalErrorMessage } from '@/services/exports/export-errors';
import { notifySupportOfExportFailure } from '@/services/exports/export-support-notifier';
import { toGenerationDto } from '@/services/exports/v12/generation/status';
import { enqueueGeneration, type ReplacedGeneration } from '@/services/exports/v12/generation/enqueue';
import { nudgeExportWorker } from '@/services/exports/v12/generation/worker';
import { EXPORT_RETENTION_DAYS } from '@/services/exports/v12/storage';
import type { ThresholdAlert } from '@/services/exports/v12/thresholds';

type GenerationDto = ReturnType<typeof toGenerationDto>;

/** #849 (C2) : archive complète produite — à vérifier par le client après téléchargement. */
export interface RawArchiveInfo {
  scope: 'complete';
  sha256: string;
  size: number;
  status: 'COMPLETE';
  categories: Record<string, { expected: number; exported: number; excluded: number; missing: number }>;
}

/** Issue d'une demande d'export, indépendante du transport (route HTTP ou Assistant). */
export type ExportRequestOutcome =
  /** Type inconnu du catalogue des exports. */
  | { kind: 'invalid_type' }
  /** Export de données brutes : ZIP produit dans la requête, prêt à télécharger. */
  /** Carte #843 (E08) : `includedDocumentIds` — documents RÉELLEMENT retenus par le moteur (revalidation à la génération). */
  /** Carte #849 (C2) : `archive` — ZIP COMPLET (portée `complete`) : empreinte SHA-256, taille, inventaire par catégorie. */
  | { kind: 'raw_ready'; code: typeof EXPORT_BRUT_CODE; dto: GenerationDto; includedDocumentIds: number[]; archive?: RawArchiveInfo }
  /** Export de données brutes : la génération a échoué (ligne d'historique en échec, support prévenu). */
  /** #849 (C2) : `errorCode` EXPORT_INCOMPLETE (pièces illisibles / absentes, détail dans `missing`), ARCHIVE_TOO_LARGE… */
  | { kind: 'raw_failed'; code: typeof EXPORT_BRUT_CODE; exportId: number; publicId: string; errorCode?: string; missing?: Array<{ category: string; id: number; motif: string }> }
  /** Dossier prêt à l'emploi : mis en file (rendu asynchrone par le worker). */
  | { kind: 'queued'; code: ExportCode; dto: GenerationDto; warnings: ThresholdAlert[]; reused: boolean; replaced: ReplacedGeneration[] }
  /** Dossier refusé par un contrôle synchrone (éligibilité, offre, dossier désactivé, seuils, plafond…). */
  | { kind: 'refused'; status: number; code: string; message: string; extra?: Record<string, unknown> };

/**
 * Lance la demande d'export d'un bien DÉJÀ contrôlé (`findAccessibleAssetForExport` : bien du compte courant).
 * `body` : corps de la demande, tel que la route le reçoit (`exportType`, `choices` ou `options`, `regenerate`…).
 */
export async function requestExportForAsset(p: {
  asset: AccessibleAsset;
  userId: number;
  body: Record<string, unknown>;
}): Promise<ExportRequestOutcome> {
  const { asset, userId, body } = p;
  const code = normalizeExportCode(body?.exportType);
  if (!code) return { kind: 'invalid_type' };

  if (code === EXPORT_BRUT_CODE) return generateRawExport(asset, userId, body);

  const result = await enqueueGeneration({ asset, userId, code, body });
  if (!result.ok) {
    return { kind: 'refused', status: result.status, code: result.code, message: result.message, ...(result.extra ? { extra: result.extra } : {}) };
  }
  nudgeExportWorker();
  return { kind: 'queued', code, dto: toGenerationDto(result.generation), warnings: result.warnings, reused: result.reused, replaced: result.replaced };
}

/**
 * Export de données brutes (EXC-001, hors dossiers V12) : ZIP produit dans la
 * requête, sélection du tiroir respectée ; rétention de 30 jours.
 */
async function generateRawExport(asset: AccessibleAsset, userId: number, body: Record<string, unknown>): Promise<ExportRequestOutcome> {
  const accountId = asset.accountId;
  const options = (body.options ?? {}) as { customDocIds?: number[]; customDocIdsCoverWebLinks?: boolean; includePhotos?: boolean; includeEquipments?: boolean; complete?: boolean };
  // #849 (C1) : ZIP COMPLET — même moteur, portée `complete` (onglet Exports, fenêtre de suppression), toutes offres.
  const complete = options.complete === true || body.scope === 'complete';
  const now = new Date();
  const [row] = await db.insert(exportGenerations).values({
    assetId: asset.id,
    accountId,
    userId,
    exportType: EXPORT_BRUT_CODE,
    variant: typeof body.variant === 'string' ? body.variant : null,
    status: 'generating',
    requestedOutputs: JSON.stringify(['ZIP']),
    manifestPayload: JSON.stringify(options),
    outputFormat: 'ZIP',
    generationAttemptCount: 1,
    generationStartedAt: now,
    createdAt: now,
  }).returning();

  try {
    const [accountRow] = await db.select({ planType: accounts.planType }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const isPremium = isPremiumPlan(accountRow?.planType ?? '');
    // X-02 (lot 16) : source canonique.
    const snapshot = await buildExportAssetSnapshot(asset.id, userId, { accountId }, 'EXPORT_BRUT');
    const manifest = buildExportManifest('EXPORT_BRUT', snapshot, { ...options, requestedOutputs: ['ZIP'] });
    let zipBuffer: Buffer;
    let archive: RawArchiveInfo | undefined;
    if (complete) {
      const { buildCompleteAssetArchive } = await import('@/services/exports/complete-archive');
      const { readStorageObject, buildRecapForSnapshot } = await import('@/services/export-zip.service');
      let tco: unknown = null;
      try {
        const { readAssetTco } = await import('@/services/business-operations/tco/service');
        tco = await readAssetTco(accountId, asset.id);
      } catch (e) {
        console.warn('[Exports POST] TCO non calculable pour l’archive complète :', { assetId: asset.id, error: (e as Error).message });
      }
      const res = await buildCompleteAssetArchive({
        accountId, assetId: asset.id, readObject: readStorageObject,
        recapTxt: buildRecapForSnapshot({ ...snapshot, photos: snapshot.photos }), tco,
      });
      if (res.status !== 'COMPLETE' || !res.buffer || !res.sha256) {
        const { ExportIncompleteError } = await import('@/services/export-zip.service');
        throw new ExportIncompleteError(res.manifest.missing);
      }
      zipBuffer = res.buffer;
      archive = { scope: 'complete', sha256: res.sha256, size: res.buffer.length, status: 'COMPLETE', categories: res.manifest.categories };
    } else {
      zipBuffer = await buildExportZip(manifest, snapshot, null, isPremium);
    }
    const zipKey = buildExportS3Key(accountId, asset.id, row.id, complete ? 'archive_complete.zip' : 'export_brut.zip');
    await uploadExportFile(zipBuffer, zipKey, 'application/zip');
    const completedAt = new Date();
    const [done] = await db.update(exportGenerations).set({
      status: 'ready',
      outputPayload: JSON.stringify({ zipS3Key: zipKey, zipSize: zipBuffer.length, ...(archive ? { scope: 'complete', zipSha256: archive.sha256, categories: archive.categories } : {}) }),
      fileKey: zipKey,
      fileSizeBytes: zipBuffer.length,
      expiresAt: new Date(completedAt.getTime() + EXPORT_RETENTION_DAYS * 86_400_000),
      metricsJson: {
        'generation.duration_ms': completedAt.getTime() - now.getTime(), 'generation.output_format': 'ZIP', 'generation.file_size_bytes': zipBuffer.length,
        ...(snapshot.dataSource ? { 'generation.data_source': snapshot.dataSource.source, 'generation.registry_version': snapshot.dataSource.registryVersion } : {}),
      },
      completedAt,
    }).where(eq(exportGenerations.id, row.id)).returning();
    return {
      kind: 'raw_ready', code: EXPORT_BRUT_CODE, dto: toGenerationDto(done),
      includedDocumentIds: [...manifest.includedDocuments, ...manifest.includedWebLinks].map((d) => d.id),
      ...(archive ? { archive } : {}),
    };
  } catch (error) {
    // #849 (C2) : export incomplet ou trop volumineux — échec VISIBLE, détail des manquants conservé.
    const { ExportIncompleteError } = await import('@/services/export-zip.service');
    const { CompleteArchiveError } = await import('@/services/exports/complete-archive');
    const errorCode = error instanceof ExportIncompleteError ? 'EXPORT_INCOMPLETE'
      : error instanceof CompleteArchiveError ? error.code : 'GENERATION_FAILED';
    const missing = error instanceof ExportIncompleteError ? error.missing : undefined;
    const technicalMessage = technicalErrorMessage(error);
    console.error('[Exports POST] Export brut échoué :', { exportId: row.id, assetId: asset.id, error });
    const supportEmailSent = await notifySupportOfExportFailure({
      assetId: asset.id, exportId: row.id, exportType: EXPORT_BRUT_CODE, technicalMessage, attemptCount: 1, userId, accountId,
    });
    await db.update(exportGenerations).set({
      status: 'failed',
      errorCode: 'GENERATION_FAILED',
      errorPayload: JSON.stringify({
        code: 'GENERATION_FAILED', message: EXPORT_ERROR_MESSAGES.GENERATION_FAILED, technicalMessage, supportEmailSent,
        ...(errorCode !== 'GENERATION_FAILED' ? { detailCode: errorCode } : {}), ...(missing ? { missing } : {}),
      }),
      completedAt: new Date(),
    }).where(eq(exportGenerations.id, row.id));
    return {
      kind: 'raw_failed', code: EXPORT_BRUT_CODE, exportId: row.id, publicId: row.publicId,
      ...(errorCode !== 'GENERATION_FAILED' ? { errorCode } : {}), ...(missing ? { missing } : {}),
    };
  }
}
