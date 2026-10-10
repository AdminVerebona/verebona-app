/**
 * Poursuite d'une analyse T1 saturée, par lots de pages (voir
 * `page-chunks.ts`). Orchestration : téléchargement du PDF, comptage des
 * pages, appels ANALYZE_DOCUMENT par lot (même prompt maître, même contrat),
 * fusion idempotente. Ne lève que pour une interruption d'exécution ou un
 * plafond de coût (comme la passe principale) ; tout autre échec de lot
 * devient une lacune FAILED.
 */
import { isExecutionCancelled } from '../../queue/execution-control';
import { isCostCapReached } from '../../gateway/errors';
import { isDefinitiveGatewayFailure } from '../failure-policy';
import type { AiAttachment } from '../../gateway/types';
import type { T1AnalyzeDocumentOutput } from '../master/t1-contract';
import type { T1DroppedItem, T1NormalisationReport } from '../master/tolerant-output';
import type { SourceInput } from '../types';
import * as pages from './page-chunks';
import { lastPageSeen, mergeChunkOutput, offsetPages } from './merge';
import { pageMarker, paginationFooter } from './text';
import type { PageGap, SourceUnitOrigin, TextSegment } from './types';

type Out = T1AnalyzeDocumentOutput;

export interface ChunkCallResult {
  output: Out;
  report: T1NormalisationReport | null;
  batches: number;
  outputTokens: number;
}

export type ChunkCall = (p: { attachments: AiAttachment[]; sources: string; triggerCode: string }) => Promise<ChunkCallResult>;

export interface ContinuationResult {
  output: Out;
  segments: TextSegment[];
  gaps: PageGap[];
  chunkCount: number;
  /** Sections définitivement non lues (saturation sans découpage possible). */
  truncatedSections: number;
  batches: number;
  dropped: Array<T1DroppedItem & { pass: SourceUnitOrigin }>;
  reports: T1NormalisationReport[];
  /** Motif quand la saturation n'a pas pu être poursuivie. */
  notContinuable?: string;
  pageCount: number | null;
}

/** Dernière page désignée par une marque de page dans le texte. */
export function lastPageInText(text: string | undefined): number {
  if (!text) return 0;
  let max = 0;
  for (const l of text.split('\n')) {
    const m = pageMarker(l) ?? paginationFooter(l);
    if (m !== null) max = Math.max(max, m);
  }
  return max + (text.includes('\f') ? text.split('\f').length - 1 : 0);
}

export async function continueByPages(p: {
  input: SourceInput;
  groupIndices: number[];
  first: Out;
  firstOutputTokens: number;
  firstReport: T1NormalisationReport | null;
  call: ChunkCall;
}): Promise<ContinuationResult> {
  const base: ContinuationResult = {
    output: p.first,
    segments: [{ text: p.first.transcription ?? '', pageOffset: 0, origin: 'PASS_1' }],
    gaps: [], chunkCount: 0, truncatedSections: 0, batches: 0, dropped: [], reports: [], pageCount: null,
  };
  if (!pages.isSaturated({ outputTokens: p.firstOutputTokens })) return base;

  // Découpage possible : un seul fichier PDF accessible.
  const idx = p.groupIndices.length === 1 ? p.groupIndices[0] : -1;
  const url = idx >= 0 ? p.input.contentUrls?.[idx] : undefined;
  const pdf = idx >= 0 && (p.input.mimeTypes[idx] ?? 'application/pdf').includes('pdf');
  if (!url || !pdf) {
    return { ...base, truncatedSections: 1, notContinuable: idx < 0 ? 'document de plusieurs fichiers' : 'format non découpable par pages' };
  }

  const bytes = await pages.fetchSourceBytes(url);
  const pageCount = bytes ? await pages.countPdfPages(bytes) : null;
  if (!bytes || !pageCount) {
    return { ...base, truncatedSections: 1, notContinuable: 'document illisible pour le découpage par pages' };
  }
  const vu = lastPageSeen(p.first, lastPageInText(p.first.transcription));
  // Sortie saturée sans aucune page citée : on repart de la page 2 (la 1re a été lue).
  const from = Math.max(vu, 2);
  if (from > pageCount) return { ...base, pageCount };
  const { chunkPages, maxChunks } = pages.chunkSettings();
  const plan = pages.planChunks(pageCount, from, chunkPages, maxChunks);

  let output = p.first;
  const segments = [...base.segments];
  const gaps: PageGap[] = [];
  const dropped: ContinuationResult['dropped'] = [];
  const reports: T1NormalisationReport[] = [];
  let batches = 0;
  const name = p.input.displayNames[idx] ?? 'document';
  for (const c of plan.chunks) {
    try {
      const sub = await pages.extractPdfPages(bytes, c.start, c.end);
      const k = c.end - c.start + 1;
      const r = await p.call({
        attachments: [pages.chunkAttachment({ url, displayName: name }, sub, c.start, c.end)],
        // Sans numéro de page absolu : le modèle numérote le lot 1…k, recalé ici.
        sources: JSON.stringify([{ index: 0, name: `${name} — extrait de ${k} page(s)`, mimeType: 'application/pdf', kind: 'document (extrait de pages)' }]),
        triggerCode: 't1_page_chunk',
      });
      const recale = offsetPages(r.output, c.start - 1);
      output = mergeChunkOutput(output, recale).output;
      segments.push({ text: r.output.transcription ?? '', pageOffset: c.start - 1, origin: 'CHUNK' });
      batches += r.batches;
      if (r.report) reports.push(r.report);
      for (const d of r.report?.dropped ?? []) dropped.push({ ...d, pass: 'CHUNK' });
    } catch (e) {
      if (isExecutionCancelled(e) || isCostCapReached(e)) throw e;
      gaps.push({ pageStart: c.start, pageEnd: c.end, retryable: !isDefinitiveGatewayFailure(e), message: (e as Error).message ?? 'échec du lot' });
    }
  }
  if (plan.beyond) {
    gaps.push({ pageStart: plan.beyond.start, pageEnd: plan.beyond.end, retryable: false, message: `au-delà de ${maxChunks} lots de pages` });
  }
  return {
    output, segments, gaps, chunkCount: plan.chunks.length, truncatedSections: 0, batches, dropped, reports, pageCount,
  };
}
