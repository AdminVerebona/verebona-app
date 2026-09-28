/**
 * Rendu complet d'un dossier V12, sans base de données : étapes
 * `resolve_files` → `render_html` → `render_pdf` (+ annexes) du §15.3.
 *
 * Entrées figées (données du bien, choix, méta) → PDF final, liste des pièces
 * du ZIP, traçabilité des éléments retenus / exclus. Utilisé par le job de
 * génération (`generation/job.ts`), l'aperçu du back-office et les tests
 * d'intégration.
 */

import path from 'node:path';
import type { DossierCode } from '@/services/exports/catalog';
import { DOSSIER_LABELS } from '@/services/exports/catalog';
import { planSelection, type ExportChoices, type SelectionPlan, type ChoiceSourceType } from '../data/choices';
import type { ExportSource } from '../data/source';
import type { ResolvedFiles } from '../data/resolved';
import { mapDossierData, type GenerationMeta } from '../data/mappers';
import { planAttachments, makeZipNamer } from '../html/selection';
import { renderDossierHtml, templateLabel, templateVersion } from '../templates';
import { staticBaseUrl, stylesheetUrls } from '../static-assets';
import { evaluateThresholds, type ThresholdAlert } from '../thresholds';
import { deliverableBaseName } from '../naming';
import { ExportGenerationError, asGenerationError, type GenerationStep } from '../generation/errors';
import { resolveFiles, fileSize, type FetchToFile } from './media';
import { printDossier } from './render-pdf';
import { applyAnnexOverlays } from './annexes';
import type { AnyDossierData, RenderContext, PageMap } from '../types';

export interface ItemRecord {
  sourceType: ChoiceSourceType;
  sourceId: number;
  label: string;
  mode: 'PDF' | 'ZIP' | null;
  status: 'included' | 'excluded';
  reason: string | null;
}

export interface ZipEntry { path: string; localPath: string }

export interface RenderedDossier {
  pdf: Buffer;
  pageCount: number;
  passes: number;
  data: AnyDossierData;
  plan: SelectionPlan;
  templateVersion: string;
  fileBaseName: string;
  /** Pièces jointes au ZIP (ZIP-001 : vide ⇒ pas de ZIP). */
  zipEntries: ZipEntry[];
  items: ItemRecord[];
  partial: boolean;
  warnings: ThresholdAlert[];
  counts: { integratedPdf: number; zip: number; excluded: number; photos: number };
}

/** Rendu interrompu par l'appelant (annulation, bail perdu). */
export type StepHook = (step: GenerationStep, details?: Record<string, unknown>) => Promise<void> | void;

export const renderTimeoutMs = (): number => {
  const n = Number(process.env.EXPORTS_RENDER_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5_000 ? n : 180_000;
};

export async function renderDossier(params: {
  code: DossierCode;
  source: ExportSource;
  choices: ExportChoices;
  meta: { reference: string; generatedAt: string; preparedBy: string | null };
  today: string;
  workDir: string;
  fetchToFile?: FetchToFile;
  timeoutMs?: number;
  onStep?: StepHook;
}): Promise<RenderedDossier> {
  const { code, source, choices, today, workDir } = params;
  const step = async (s: GenerationStep, d?: Record<string, unknown>) => { await params.onStep?.(s, d); };

  // ── resolve_files ─────────────────────────────────────────────────────────
  await step('resolve_files');
  const plan = planSelection(code, source, choices, today);
  let resolved: ResolvedFiles;
  try {
    resolved = await resolveFiles({ workDir, documents: plan.documents, photos: plan.photos, fetchToFile: params.fetchToFile });
  } catch (e) {
    throw asGenerationError(e, 'resolve_files');
  }
  const okDoc = (id: number) => resolved.documents.get(id)?.status === 'ok';
  const okPhoto = (id: number) => resolved.photos.get(id)?.status === 'ok';

  // Seuils sur le contenu réel (§6.3).
  const integrated = plan.documents.filter((pd) => pd.mode === 'PDF' && okDoc(pd.doc.id));
  const realPages = integrated.reduce((s, pd) => s + (resolved.documents.get(pd.doc.id)?.pages ?? 1), 0);
  let totalBytes = 0;
  for (const r of resolved.documents.values()) totalBytes += await fileSize(r.localPath);
  for (const r of resolved.photos.values()) totalBytes += await fileSize(r.localPath);
  const photosIn = plan.photos.filter((pp) => okPhoto(pp.photo.id));
  const thresholds = evaluateThresholds({
    integratedDocuments: integrated.length,
    photos: photosIn.length,
    totalBytes,
    pages: 6 + Math.ceil(photosIn.length / 4) + realPages,
  });
  if (thresholds.blocking.length) {
    throw new ExportGenerationError('THRESHOLD_BLOCKED', 'resolve_files', thresholds.blocking.map((b) => b.code).join(', '), { blocking: thresholds.blocking.map((b) => b.code) });
  }

  const hasZipItems = choices.outputFormat === 'ZIP'
    && (plan.documents.some((pd) => pd.mode === 'ZIP' && okDoc(pd.doc.id)) || plan.photos.some((pp) => pp.mode === 'ZIP' && okPhoto(pp.photo.id)));
  const baseName = deliverableBaseName(code, source.asset.name, today);
  const meta: GenerationMeta = {
    ...params.meta,
    templateLabel: templateLabel(code),
    zipName: hasZipItems ? `${baseName}.zip` : null,
    label: DOSSIER_LABELS[code],
  };

  // ── render_html → render_pdf → apposition ────────────────────────────────
  // Une pièce qui passe l'inspection stricte s'appose normalement ; si
  // l'apposition échoue malgré tout, la pièce est marquée « corrupted » et le
  // dossier est RE-RENDU sans elle (index, pagination et compteurs justes,
  // jamais de page d'annexe vide). Au plus deux re-rendus.
  const docIdOf = (ref: string) => Number(ref.replace(/^d/, ''));
  const overlayFailed = new Set<number>();
  let data!: AnyDossierData;
  let attachments!: ReturnType<typeof planAttachments>;
  let printed!: Awaited<ReturnType<typeof printDossier>>;
  let overlay!: Awaited<ReturnType<typeof applyAnnexOverlays>>;
  for (let round = 0; ; round++) {
    await step('render_html', round ? { rerender: round, excluded: [...overlayFailed] } : undefined);
    try {
      data = mapDossierData(code, { source, plan, resolved, meta, today });
    } catch (e) {
      throw asGenerationError(e, 'render_html');
    }
    attachments = planAttachments(data.documents);
    const sys = staticBaseUrl();
    const photoUrls = new Map<string, string>();
    for (const [id, r] of resolved.photos) if (r.status === 'ok' && r.url) photoUrls.set(`photo-${id}`, r.url);
    const baseCtx: Omit<RenderContext, 'pageMap'> = {
      sys,
      stylesheets: stylesheetUrls(sys),
      asset: (file) => (file ? photoUrls.get(file) ?? null : null),
    };
    const build = (pageMap: PageMap | null) => {
      try {
        return renderDossierHtml(code, data as never, { ...baseCtx, pageMap });
      } catch (e) {
        throw asGenerationError(e, 'render_html');
      }
    };
    build(null); // erreur de template détectée avant de lancer Chromium

    await step('render_pdf', { annexes: attachments.annexes.length });
    const annexLayout = attachments.annexes.map((a) => ({ annexRef: a.annexRef!, pageCount: a.pageCount ?? 1 }));
    try {
      printed = await printDossier({ workDir, build, annexes: annexLayout, timeoutMs: params.timeoutMs ?? renderTimeoutMs() });
    } catch (e) {
      throw asGenerationError(e, 'render_pdf');
    }
    try {
      overlay = await applyAnnexOverlays({
        pdf: printed.pdf,
        annexes: attachments.annexes.map((a) => {
          const r = resolved.documents.get(docIdOf(a.id));
          const isPdf = String(a.format).toUpperCase() === 'PDF';
          return { annexRef: a.annexRef!, pageCount: a.pageCount ?? 1, pdfPath: isPdf ? r?.localPath : undefined, boxes: r?.boxes };
        }),
        pageMap: printed.pageMap,
        frames: printed.frames,
        pageSizes: printed.pageSizes,
        metadata: { title: `${DOSSIER_LABELS[code]} — ${source.asset.name}`, subject: 'Dossier préparé avec Verebona' },
      });
    } catch (e) {
      throw asGenerationError(e, 'render_pdf');
    }
    if (!overlay.failed.length) break;
    if (round >= 2) {
      throw new ExportGenerationError('RENDER_ERROR', 'render_pdf', `apposition impossible après ${round} re-rendus : ${overlay.failed.join(', ')}`);
    }
    for (const ref of overlay.failed) {
      const id = attachments.annexes.find((a) => a.annexRef === ref)?.id;
      if (!id) continue;
      const docId = docIdOf(String(id));
      overlayFailed.add(docId);
      resolved.documents.set(docId, { id: docId, status: 'corrupted', pages: null });
    }
  }

  // ── Pièces du ZIP (ZIP-003/004/006/007/008) ───────────────────────────────
  const zipEntries: ZipEntry[] = [];
  if (hasZipItems) {
    for (const z of attachments.zip) {
      const r = resolved.documents.get(docIdOf(z.id));
      if (r?.status === 'ok' && r.localPath && z.zipPath) zipEntries.push({ path: z.zipPath, localPath: r.localPath });
    }
    const namePhoto = makeZipNamer();
    for (const pp of plan.photos) {
      const r = resolved.photos.get(pp.photo.id);
      if (pp.mode !== 'ZIP' || r?.status !== 'ok' || !r.localPath) continue;
      zipEntries.push({ path: namePhoto({ id: pp.photo.id, fileName: pp.photo.fileName ?? path.basename(r.localPath), format: 'jpg' }, 'photos'), localPath: r.localPath });
    }
  }

  // ── Traçabilité (§16.1) ───────────────────────────────────────────────────
  const items: ItemRecord[] = [
    ...plan.excluded.map((x) => ({ sourceType: x.sourceType, sourceId: x.sourceId, label: x.label, mode: null, status: 'excluded' as const, reason: x.reason })),
    ...plan.documents.map((pd) => {
      const r = resolved.documents.get(pd.doc.id);
      const ok = r?.status === 'ok';
      return { sourceType: 'document' as const, sourceId: pd.doc.id, label: pd.doc.title, mode: pd.mode, status: ok ? 'included' as const : 'excluded' as const, reason: ok ? null : r?.status ?? 'missing' };
    }),
    ...plan.photos.map((pp) => {
      const r = resolved.photos.get(pp.photo.id);
      const ok = r?.status === 'ok';
      return { sourceType: 'photo' as const, sourceId: pp.photo.id, label: pp.photo.caption ?? `Photo ${pp.photo.id}`, mode: pp.mode, status: ok ? 'included' as const : 'excluded' as const, reason: ok ? null : r?.status ?? 'missing' };
    }),
    ...source.events.filter((e) => plan.events.has(e.key)).map((e) => ({ sourceType: e.source, sourceId: e.id, label: e.title, mode: null, status: 'included' as const, reason: null })),
  ];
  // Génération partielle : fichier retenu devenu indisponible ou illisible (ALT-004).
  const fileFailures = items.filter((i) => i.status === 'excluded' && ['missing', 'corrupted', 'protected', 'unreadable', 'too_large'].includes(i.reason ?? ''));

  return {
    pdf: overlay.pdf,
    pageCount: printed.pageCount,
    passes: printed.passes,
    data,
    plan,
    templateVersion: templateVersion(code),
    fileBaseName: baseName,
    zipEntries,
    items,
    partial: fileFailures.length > 0,
    warnings: thresholds.warnings,
    counts: {
      integratedPdf: attachments.annexes.length,
      zip: zipEntries.length,
      excluded: items.filter((i) => i.status === 'excluded').length,
      photos: photosIn.filter((pp) => pp.mode === 'PDF').length,
    },
  };
}
