/**
 * Job de génération d'un dossier V12 (CDC §15.3) :
 *
 *   validate_request → lock_snapshot → resolve_files → render_html →
 *   render_pdf → assemble_zip → store_result → finalize_history
 *
 * Chaque étape est journalisée (`export_generation_logs`, identifiants
 * seulement — LOG-001/002) ; toute erreur porte un code distinct, sa
 * catégorie et son étape (LOG-003), la version de template et le type de
 * dossier (LOG-004). Génération partielle et fichiers exclus sont tracés
 * (`export_generation_items`, LOG-005).
 *
 * Pas de repli dégradé (DEC-002) : un échec de rendu est un échec, remonté,
 * journalisé et notifié au support après la dernière tentative.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { isCilEligible } from '@/lib/asset-capabilities';
import { normalizeExportCode, isDossierEligibleForFamily, isDossierCode, type DossierCode } from '@/services/exports/catalog';
import { notifySupportOfExportFailure } from '@/services/exports/export-support-notifier';
import { attachNotesDescription, loadExportSource, type ExportSource } from '../data/source';
import {
  buildDefaultChoices, choicesFromLegacyOptions, includesNotesDescription, planSelection,
  type ExportChoices, type LegacyDrawerOptions, type OutputFormat,
} from '../data/choices';
import { renderDossier, type RenderedDossier } from '../render/render-dossier';
import type { FetchToFile } from '../render/media';
import { templateVersion } from '../templates';
import { writeDossierZip } from '../zip';
import { buildExportS3Key, s3UploadFile, EXPORT_RETENTION_DAYS, type UploadFn } from '../storage';
import { ExportGenerationError, asGenerationError, type GenerationStep } from './errors';
import {
  addGenerationLog, replaceGenerationItems, updateOwnedGeneration, isGenerationCancelRequested, markGenerationCancelled,
  MAX_ATTEMPTS, type GenerationRow,
} from './repository';
import { GenerationCancelledError, generationReference } from './identity';
import { parisDate, parisIso } from './clock';
import { scheduleOrphanedOutputs } from './files';

/** Demande figée à la création (`snapshot_json.request`). */
export interface GenerationRequestSnapshot {
  outputFormat: OutputFormat;
  /** Choix explicites (payload V12, §17.2). */
  choices?: ExportChoices | null;
  /** Options du tiroir historique. */
  legacyOptions?: LegacyDrawerOptions | null;
  requestedAt: string;
  /** Empreinte de la demande (dédoublonnage des doubles clics, `enqueue.ts`). */
  requestHash?: string;
  /** Lot 44 (O5) : sinistre du dossier Assurance-sinistre retenu à la demande. */
  claimOperationId?: number | null;
  /** Lot 111B : générations remplacées par cette régénération explicite. */
  replacesGenerationIds?: number[];
}

interface JobDeps {
  fetchToFile?: FetchToFile;
  upload: UploadFn;
  loadSource: typeof loadExportSource;
  /** Carte #767 (E03) : texte « Notes / Description » des pièces retenues (lecture stricte, fail-closed). */
  attachNotes: typeof attachNotesDescription;
  notifySupport: typeof notifySupportOfExportFailure;
  /** Objets envoyés mais non rattachés à la génération → file de purge. */
  scheduleOrphans: typeof scheduleOrphanedOutputs;
  now: () => Date;
  /** Lot 111B : demande d'annulation persistante (lecture en base). */
  isCancelRequested: (id: number) => Promise<boolean>;
  /** Lot 111B : clôture `cancelled` conditionnée au bail. */
  markCancelled: (id: number, workerId: string, step: string) => Promise<boolean>;
}

const defaultJobDeps = (): JobDeps => ({
  upload: s3UploadFile,
  loadSource: loadExportSource,
  attachNotes: attachNotesDescription,
  notifySupport: notifySupportOfExportFailure,
  scheduleOrphans: scheduleOrphanedOutputs,
  now: () => new Date(),
  isCancelRequested: isGenerationCancelRequested,
  markCancelled: markGenerationCancelled,
});

/** Référence imprimée : « VBN-CIL-20260928-000123 » (lot 111B : définie dans `identity.ts`, aussi lue par l'historique). */
export { generationReference } from './identity';

/** Délai avant nouvelle tentative d'une erreur transitoire : 30 s, 2 min, 8 min. */
export const retryDelayMs = (attempt: number): number => 30_000 * 4 ** Math.max(0, attempt - 1);

/** Choix effectifs : payload V12, sinon options du tiroir, sinon pré-sélection du CDC. */
export function effectiveChoices(code: DossierCode, source: ExportSource, req: GenerationRequestSnapshot, today: string): ExportChoices {
  if (req.choices) return req.choices;
  if (req.legacyOptions) return choicesFromLegacyOptions(code, source, req.legacyOptions, { outputFormat: req.outputFormat, today });
  return buildDefaultChoices(code, source, { outputFormat: req.outputFormat, today });
}

/** Instantané §16.3 (sans le contenu des fichiers). */
function buildSnapshot(code: DossierCode, source: ExportSource, choices: ExportChoices, req: GenerationRequestSnapshot, createdAt: string, rendered?: RenderedDossier) {
  return {
    asset: { id: source.asset.id, family: source.family, name: source.asset.name, fields: source.asset.characteristics },
    // CDC 15 X-02 (lot 16) : source utilisée (canonique seule depuis le lot
    // 16b-3), version du registre et chemins de rattachement des pièces.
    dataSource: source.sourceTrace ?? null,
    additionalInfo: source.additionalInfo,
    // Lot 44 : sinistre retenu (Opération CLAIM) — sa sous-rubrique est dans `additionalInfo.claim`.
    claim: source.claim ?? null,
    export: { type: code, templateVersion: templateVersion(code), createdAt },
    sections: Object.entries(rendered?.plan.sections ?? choices.sections).map(([id, enabled]) => ({ id, enabled })),
    choices,
    // Carte #767 (E03) : choix d'inclusion de « Notes / Description » — vérifiable après coup
    // (`included`), avec le nombre de pièces qui portent un texte (jamais le texte ici : il est dans `data`).
    notesDescription: {
      included: includesNotesDescription(choices),
      documents: includesNotesDescription(choices) ? source.documents.filter((d) => !!d.notesDescription).length : 0,
    },
    zip: { enabled: (rendered?.zipEntries.length ?? 0) > 0 },
    warnings: rendered?.warnings.map((w) => w.code) ?? [],
    thresholds: rendered ? { pages: rendered.pageCount, integratedPdf: rendered.counts.integratedPdf, zipItems: rendered.counts.zip } : null,
    request: { outputFormat: req.outputFormat, requestedAt: req.requestedAt, origin: choices.origin },
    // Données exactes transmises au template (IC-GEN-010).
    data: rendered?.data ?? null,
  };
}

/**
 * Exécute une génération prise par le worker (`status = generating`, bail
 * détenu par `workerId`). `isActive()` : faux si le bail a été perdu ;
 * `signal` : délai global dépassé ou annulation (worker). Dans les deux cas
 * l'exécution s'arrête à l'étape suivante sans rien écrire, et les objets
 * déjà envoyés sont confiés à la file de purge.
 *
 * Lot 111B — annulation coopérative (génération remplacée par une
 * régénération) : `isCancelled()` (observée par le worker) et une relecture
 * en base avant chaque écriture décisive (envoi, clôture). Le signal est
 * transmis au rendu Chromium, aux téléchargements des pièces et aux envois
 * OVH. Issue `cancelled` : statut terminal `cancelled`, bail libéré, objets
 * non publiés purgés, répertoire temporaire supprimé — ni échec, ni
 * notification du support.
 */
export async function runGeneration(row: GenerationRow, workerId: string, opts: { isActive?: () => boolean; isCancelled?: () => boolean; signal?: AbortSignal; deps?: Partial<JobDeps> } = {}): Promise<'ready' | 'partial' | 'failed' | 'retry' | 'lost' | 'cancelled'> {
  const deps = { ...defaultJobDeps(), ...opts.deps };
  const started = deps.now();
  const code = normalizeExportCode(row.exportType);
  const tplVersion = code && isDossierCode(code) ? templateVersion(code) : null;
  const log = (level: 'info' | 'warn' | 'error', step: GenerationStep, message: string, extra?: { code?: string; details?: Record<string, unknown> }) =>
    addGenerationLog(row.id, { level, step, message, code: extra?.code ?? null, details: { exportType: code ?? row.exportType, templateVersion: tplVersion, attempt: row.generationAttemptCount, ...(extra?.details ?? {}) } });
  const leaseLost = () => !!opts.isActive && !opts.isActive();
  const guard = () => {
    if (leaseLost()) throw new LeaseLostError();
    if (opts.isCancelled?.()) throw new GenerationCancelledError();
    if (opts.signal?.aborted) throw new LeaseLostError();
  };
  /** Relecture en base avant une écriture décisive (n'attend pas le prochain tour du worker). */
  const checkpoint = async () => {
    guard();
    if (await deps.isCancelRequested(row.id).catch(() => false)) throw new GenerationCancelledError();
  };
  /** L'annulation est-elle demandée (observée par le worker ou en base) ? */
  const cancelObserved = async (e?: unknown) =>
    e instanceof GenerationCancelledError || !!opts.isCancelled?.() || await deps.isCancelRequested(row.id).catch(() => false);
  // Objets S3 envoyés par CETTE exécution, et vrai une fois rattachés à la ligne.
  const uploaded: string[] = [];
  let committed = false;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `verebona-export-${row.id}-`));
  let current: GenerationStep = 'validate_request';
  try {
    // ── validate_request ────────────────────────────────────────────────────
    await log('info', current, 'Génération démarrée.', { details: { workerId } });
    if (!code || !isDossierCode(code)) throw new ExportGenerationError('INVALID_EXPORT_TYPE', current, `type ${row.exportType}`);
    const [asset] = await db.select().from(assets)
      .where(and(eq(assets.id, row.assetId), eq(assets.accountId, row.accountId), isNull(assets.deletedAt))).limit(1);
    if (!asset) throw new ExportGenerationError('ASSET_NOT_FOUND', current, `bien ${row.assetId} absent du compte ${row.accountId}`);
    if (!isDossierEligibleForFamily(code, asset.category) || (code === 'CIL' && !isCilEligible(asset))) {
      throw new ExportGenerationError('NOT_ELIGIBLE', current, `${code} non éligible pour ${asset.category}/${asset.subtype ?? ''}`);
    }
    const req = ((row.snapshotJson as { request?: GenerationRequestSnapshot } | null)?.request) ?? { outputFormat: 'PDF', requestedAt: new Date(row.createdAt).toISOString() };

    // ── lock_snapshot ───────────────────────────────────────────────────────
    current = 'lock_snapshot';
    guard();
    const now = deps.now();
    const today = parisDate(now);
    const generatedAt = parisIso(now);
    let source: ExportSource;
    try {
      const claimOperationId = req.choices?.claimOperationId ?? req.claimOperationId ?? null;
      source = await deps.loadSource({
        assetId: row.assetId, accountId: row.accountId, userId: row.userId, exportType: code,
        ...(claimOperationId ? { claimOperationId } : {}),
      });
    } catch (e) {
      throw asGenerationError(e, current);
    }
    if (code === 'CIL' && source.cil?.readiness.globalStatus === 'action_required') {
      // Blocs RÉELLEMENT bloquants (lot 69), pas la liste de la règle.
      const ids = source.cil.readiness.blockingBlocks.map((b) => b.id);
      throw new ExportGenerationError('NOT_ELIGIBLE', current, `CIL-RULE-002 : ${ids.length ? `${ids.join(', ')} à compléter` : 'bloc bloquant à compléter'}`);
    }
    const choices = effectiveChoices(code, source, req, today);
    // Carte #767 (E03) : « Notes / Description » des pièces RETENUES, seulement si l'inclusion a été
    // cochée à la préparation (choix `user` explicite). Lecture stricte : métadonnées indisponibles →
    // la génération échoue (aucun dossier produit avec une valeur de repli, DEC-002).
    if (includesNotesDescription(choices)) {
      try {
        const retenues = planSelection(code, source, choices, today).documents.map((pd) => pd.doc.id);
        source = await deps.attachNotes(source, row.accountId, retenues, `dossier ${code} (génération ${row.id})`);
      } catch (e) {
        throw asGenerationError(e, current);
      }
      await log('info', current, 'Notes / Description des documents : inclusion demandée.', {
        details: { documentsWithText: source.documents.filter((d) => !!d.notesDescription).length },
      });
    }
    await updateOwnedGeneration(row.id, workerId, {
      snapshotJson: { ...buildSnapshot(code, source, choices, req, generatedAt), request: req } as Record<string, unknown>,
      templateVersion: tplVersion,
    });
    await log('info', current, 'Instantané des données et des choix figé.', {
      details: { documents: choices.items.filter((i) => i.sourceType === 'document').length, photos: choices.items.filter((i) => i.sourceType === 'photo').length, origin: choices.origin },
    });

    // ── resolve_files → render_html → render_pdf ─────────────────────────────
    const rendered = await renderDossier({
      code, source, choices, today, workDir,
      meta: { reference: generationReference(code, row.id, today), generatedAt, preparedBy: source.preparedBy },
      fetchToFile: deps.fetchToFile,
      signal: opts.signal,
      onStep: async (s) => { current = s; guard(); await log('info', s, `Étape ${s}.`); },
    });
    guard();
    const excluded = rendered.items.filter((i) => i.status === 'excluded');
    if (excluded.length) {
      await log(rendered.partial ? 'warn' : 'info', 'resolve_files', `${excluded.length} élément(s) exclu(s).`, {
        code: rendered.partial ? 'FILE_UNAVAILABLE' : undefined,
        details: { excluded: excluded.map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, reason: i.reason })) },
      });
    }

    // ── assemble_zip ────────────────────────────────────────────────────────
    current = 'assemble_zip';
    const pdfName = `${rendered.fileBaseName}.pdf`;
    const pdfPath = path.join(workDir, pdfName);
    await fs.writeFile(pdfPath, rendered.pdf);
    let zipPath: string | null = null;
    let zipSize: number | null = null;
    if (rendered.zipEntries.length > 0) {
      guard();
      zipPath = path.join(workDir, `${rendered.fileBaseName}.zip`);
      try {
        zipSize = await writeDossierZip({ pdfPath, pdfName, entries: rendered.zipEntries, dest: zipPath });
      } catch (e) {
        throw asGenerationError(e, current);
      }
      await log('info', current, 'Archive ZIP constituée.', { details: { entries: rendered.zipEntries.length, bytes: zipSize } });
    }

    // ── store_result ────────────────────────────────────────────────────────
    current = 'store_result';
    await checkpoint();
    const attemptNo = row.generationAttemptCount ?? null;
    const pdfKey = buildExportS3Key(row.accountId, row.assetId, row.id, pdfName, attemptNo);
    const zipKey = zipPath ? buildExportS3Key(row.accountId, row.assetId, row.id, path.basename(zipPath), attemptNo) : null;
    // Lot 111B : envoi interruptible (signal transmis au client S3) ; un envoi
    // interrompu peut avoir laissé un objet → sa clé est confiée à la purge.
    const send = async (local: string, key: string, type: string) => {
      try {
        await (opts.signal ? deps.upload(local, key, type, { signal: opts.signal }) : deps.upload(local, key, type));
        uploaded.push(key);
      } catch (e) {
        if (opts.signal?.aborted) { uploaded.push(key); throw e instanceof LeaseLostError || e instanceof GenerationCancelledError ? e : new LeaseLostError(); }
        throw e;
      }
    };
    try {
      await send(pdfPath, pdfKey, 'application/pdf');
      guard();
      if (zipPath && zipKey) {
        await send(zipPath, zipKey, 'application/zip');
      }
    } catch (e) {
      if (e instanceof LeaseLostError || e instanceof GenerationCancelledError) throw e;
      throw asGenerationError(e, current);
    }

    // ── finalize_history (retry technique : ne pas perdre le fichier) ────────
    current = 'finalize_history';
    const completedAt = deps.now();
    const status = rendered.partial ? 'partial' : 'ready';
    const outputFormat: OutputFormat = zipKey ? 'ZIP' : 'PDF';
    const metrics = {
      'generation.duration_ms': completedAt.getTime() - started.getTime(),
      'generation.output_format': outputFormat,
      'generation.pdf_pages': rendered.pageCount,
      'generation.file_size_bytes': zipSize ?? rendered.pdf.length,
      'generation.pdf_size_bytes': rendered.pdf.length,
      'generation.render_passes': rendered.passes,
      'items.integrated_pdf_count': rendered.counts.integratedPdf,
      'items.zip_count': rendered.counts.zip,
      'items.excluded_count': rendered.counts.excluded,
      'items.photo_count': rendered.counts.photos,
      'renderer.template_version': rendered.templateVersion,
      warnings: rendered.warnings.map((w) => w.code),
    };
    const values = {
      status,
      outputFormat,
      fileKey: zipKey ?? pdfKey,
      fileSizeBytes: zipSize ?? rendered.pdf.length,
      outputPayload: JSON.stringify({ pdfS3Key: pdfKey, pdfSize: rendered.pdf.length, ...(zipKey ? { zipS3Key: zipKey, zipSize } : {}), pdfName, zipName: zipKey ? path.basename(zipPath!) : undefined }),
      expiresAt: new Date(completedAt.getTime() + EXPORT_RETENTION_DAYS * 86_400_000),
      metricsJson: metrics,
      snapshotJson: { ...buildSnapshot(code, source, choices, req, generatedAt, rendered), request: req } as Record<string, unknown>,
      templateVersion: rendered.templateVersion,
      errorCode: null,
      errorPayload: null,
      completedAt,
      lockedBy: null,
      lockedUntil: null,
    };
    await checkpoint();
    let saved = false;
    for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
      try {
        saved = await updateOwnedGeneration(row.id, workerId, values);
        if (!saved) break;
      } catch (e) {
        if (attempt === 3) throw asGenerationError(e, current);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (!saved) {
      // Lot 111B : clôture refusée par les préconditions (annulation demandée
      // entre-temps) → aucune publication, issue « annulée ».
      if (await cancelObserved()) throw new GenerationCancelledError();
      await log('warn', current, 'Génération dépossédée avant la clôture : fichiers envoyés confiés à la purge.', { details: { pdfKey, zipKey } });
      return 'lost';
    }
    committed = true;
    await replaceGenerationItems(row.id, rendered.items).catch((e) =>
      log('warn', current, 'Traçabilité des éléments non enregistrée.', { details: { error: (e as Error).message } }));
    await log('info', current, rendered.partial ? 'Génération partielle terminée.' : 'Génération terminée.', { details: metrics });
    return status;
  } catch (e) {
    // Lot 111B : annulation volontaire (remplacée) — jamais un échec, jamais de
    // notification du support. Bail perdu : aucune écriture.
    if (!leaseLost() && await cancelObserved(e)) {
      await deps.markCancelled(row.id, workerId, current).catch((x) =>
        console.error(`[exports-v12] génération ${row.id} : clôture de l'annulation impossible (reprise par le balayage) :`, (x as Error).message));
      console.info(`[exports-v12] génération ${row.id} : arrêtée à l'étape ${current} (remplacée par une nouvelle génération).`);
      return 'cancelled';
    }
    if (e instanceof LeaseLostError || e instanceof GenerationCancelledError || opts.signal?.aborted) {
      console.warn(`[exports-v12] génération ${row.id} : bail perdu ou délai global dépassé, exécution abandonnée.`);
      return 'lost';
    }
    const err = asGenerationError(e, current);
    const attempt = row.generationAttemptCount ?? 1;
    const retry = !err.permanent && attempt < MAX_ATTEMPTS;
    console.error(`[exports-v12] génération ${row.id} (${code ?? row.exportType}, ${tplVersion ?? '—'}) en échec à l'étape ${err.step} : ${err.code} — ${err.message}`);
    await log('error', err.step, err.message, { code: err.code, details: { category: err.category, retry, ...(err.details ?? {}) } });
    const errorPayload = JSON.stringify({ code: err.code, message: err.safeMessage, step: err.step, category: err.category, technicalMessage: err.message, attempt });
    if (retry) {
      const requeued = await updateOwnedGeneration(row.id, workerId, {
        status: 'queued', errorCode: err.code, errorPayload, lockedBy: null, lockedUntil: null,
        nextAttemptAt: new Date(deps.now().getTime() + retryDelayMs(attempt)),
      }).catch(() => false);
      if (!requeued && await cancelObserved()) {
        await deps.markCancelled(row.id, workerId, err.step).catch(() => false);
        return 'cancelled';
      }
      return 'retry';
    }
    // Lot 111B : remplacée pendant l'échec → annulation, pas de panne ni de notification.
    if (await cancelObserved()) {
      await deps.markCancelled(row.id, workerId, err.step).catch(() => false);
      return 'cancelled';
    }
    const supportEmailSent = err.category === 'business' || err.category === 'threshold'
      ? false
      : await deps.notifySupport({
        assetId: row.assetId, exportId: row.id, exportType: code ?? row.exportType, technicalMessage: `${err.code} @ ${err.step} : ${err.message}`,
        attemptCount: attempt, userId: row.userId, accountId: row.accountId,
      }).catch(() => false);
    await updateOwnedGeneration(row.id, workerId, {
      status: 'failed', errorCode: err.code, errorPayload: JSON.stringify({ ...JSON.parse(errorPayload), supportEmailSent }),
      completedAt: deps.now(), lockedBy: null, lockedUntil: null,
    }).catch(() => undefined);
    return 'failed';
  } finally {
    if (uploaded.length && !committed) {
      await deps.scheduleOrphans(row.id, uploaded).catch((e) =>
        console.error(`[exports-v12] génération ${row.id} : objets orphelins non planifiés pour purge (${uploaded.join(', ')}) :`, (e as Error).message));
    }
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Durée maximale d'une exécution (worker), défaut 10 min. */
export const jobTimeoutMs = (): number => {
  const n = Number(process.env.EXPORTS_JOB_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 10 * 60_000;
};

/**
 * Clôture en échec (RENDER_TIMEOUT) d'une exécution qui a dépassé le délai
 * global. Écriture conditionnée au bail : sans effet si la génération a déjà
 * été reprise ailleurs. L'exécution en cours, avertie par son signal,
 * s'arrête à l'étape suivante sans plus rien écrire.
 */
export async function failTimedOutGeneration(row: GenerationRow, workerId: string, deps: Pick<JobDeps, 'notifySupport' | 'now'> & Partial<Pick<JobDeps, 'isCancelRequested' | 'markCancelled'>> = defaultJobDeps()): Promise<boolean> {
  // Lot 111B : une génération remplacée qui dépasse le délai est ANNULÉE, pas en échec.
  const isCancelRequested = deps.isCancelRequested ?? isGenerationCancelRequested;
  if (await isCancelRequested(row.id).catch(() => false)) {
    return (deps.markCancelled ?? markGenerationCancelled)(row.id, workerId, 'render_pdf').catch(() => false);
  }
  const err = new ExportGenerationError('RENDER_TIMEOUT', 'render_pdf', `délai global de génération dépassé (${Math.round(jobTimeoutMs() / 1000)} s)`);
  const attempt = row.generationAttemptCount ?? 1;
  await addGenerationLog(row.id, { level: 'error', step: err.step, code: err.code, message: err.message, details: { category: err.category, attempt } });
  const supportEmailSent = await deps.notifySupport({
    assetId: row.assetId, exportId: row.id, exportType: row.exportType, technicalMessage: `${err.code} : ${err.message}`,
    attemptCount: attempt, userId: row.userId, accountId: row.accountId,
  }).catch(() => false);
  return updateOwnedGeneration(row.id, workerId, {
    status: 'failed', errorCode: err.code,
    errorPayload: JSON.stringify({ code: err.code, message: err.safeMessage, step: err.step, category: err.category, technicalMessage: err.message, attempt, supportEmailSent }),
    completedAt: deps.now(), lockedBy: null, lockedUntil: null,
  }).catch(() => false);
}

class LeaseLostError extends Error {
  constructor() { super('bail de génération perdu'); }
}
