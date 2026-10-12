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
import {
  citedPages, pageRanges, probePdf, verificationUnverifiable, verifyNonPdf, verifyPdfCoverage,
  type SourceProbe, type SourceVerification,
} from './source-verification';

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
  /** Lot 49B (DEV-01) : couverture réelle de la source (pages vérifiées, manquantes, non vérifiées). */
  verification?: SourceVerification;
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
  const sature = pages.isSaturated({ outputTokens: p.firstOutputTokens });

  // Découpage et vérification par pages : un seul fichier PDF accessible.
  const idx = p.groupIndices.length === 1 ? p.groupIndices[0] : -1;
  const url = idx >= 0 ? p.input.contentUrls?.[idx] : undefined;
  const pdf = idx >= 0 && (p.input.mimeTypes[idx] ?? 'application/pdf').includes('pdf');
  const mimes = p.groupIndices.map((i) => p.input.mimeTypes[i] ?? 'application/pdf');
  // Lot 49B (DEV-01) : source préextraite (lien web, corpus) — la source EST le texte.
  const texte = !!p.input.extractedContent?.trim() && (p.input.sourceType === 'web_link' || !p.input.contentUrls?.length);
  if (!url || !pdf || texte || !/^https?:/i.test(url)) {
    const verification = verifyNonPdf({ mimeTypes: mimes, textSource: texte || (!url && !p.input.contentUrls?.length), hasContent: hasContent(p.first) });
    if (!sature) return { ...base, verification };
    return { ...base, verification, truncatedSections: 1, notContinuable: idx < 0 ? 'document de plusieurs fichiers' : 'format non découpable par pages' };
  }

  const bytes = await pages.fetchSourceBytes(url);
  // Lot 49B (DEV-01) : vérification seule (sortie non saturée) d'un très gros fichier — non sondé
  // (mémoire du worker) : couverture NON VÉRIFIABLE, jamais réputée complète.
  if (bytes && !sature && bytes.length > probeMaxBytes()) {
    return { ...base, verification: verificationUnverifiable('source_too_large') };
  }
  // Sonde déterministe du document original (pages réelles, texte lisible) — une seule lecture du PDF.
  const sonde = bytes ? await probePdf(bytes) : null;
  const pageCount = sonde?.pageCount ?? (bytes && sature ? await pages.countPdfPages(bytes) : null);
  if (!bytes || !pageCount) {
    const verification = verificationUnverifiable(bytes ? 'pdf_unreadable' : 'source_unreadable');
    if (!sature) return { ...base, verification };
    return { ...base, verification, truncatedSections: 1, notContinuable: 'document illisible pour le découpage par pages' };
  }
  const probe = sonde ?? { pageCount, pages: [] };
  const { chunkPages, maxChunks } = pages.chunkSettings();

  let plan: { chunks: Array<{ start: number; end: number }>; beyond: { start: number; end: number } | null };
  if (sature) {
    const vu = lastPageSeen(p.first, lastPageInText(p.first.transcription));
    // Lot 49B (TC02) : sans page citée, la page 1 n'est pas réputée lue — reprise dès la page 1.
    // Page citée : la dernière page lue est relue (elle a pu être coupée), la 1re n'est jamais relue pour rien.
    const from = vu >= 1 ? Math.max(vu, 2) : 1;
    if (from > pageCount) return { ...base, pageCount, verification: final(p.first, base.segments, probe, new Set()) };
    plan = pages.planChunks(pageCount, from, chunkPages, maxChunks);
  } else {
    // Sortie NON saturée : omission détectée (page absente de la lecture) → reprise CIBLÉE de ces pages seulement.
    const v0 = final(p.first, base.segments, probe, new Set());
    if (v0.missing.length === 0) return { ...base, pageCount, verification: v0 };
    console.info(`[t1-coverage] fichier ${p.input.sourceIds[idx]} : ${v0.missing.length} page(s) non restituée(s) sur ${pageCount} — reprise ciblée.`);
    plan = planRanges(pageRanges(v0.missing), chunkPages, maxChunks);
  }

  let output = p.first;
  const segments = [...base.segments];
  const gaps: PageGap[] = [];
  const dropped: ContinuationResult['dropped'] = [];
  const reports: T1NormalisationReport[] = [];
  const relues = new Set<number>();
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
        triggerCode: sature ? 't1_page_chunk' : 't1_page_omission',
      });
      const recale = offsetPages(r.output, c.start - 1);
      output = mergeChunkOutput(output, recale).output;
      segments.push({ text: r.output.transcription ?? '', pageOffset: c.start - 1, origin: 'CHUNK' });
      for (let x = c.start; x <= c.end; x++) relues.add(x);
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
    verification: final(output, segments, probe, relues),
  };
}

/** Taille au-delà de laquelle un PDF non saturé n'est pas sondé (`T1_COVERAGE_PROBE_MAX_MB`, 40 Mo par défaut). */
export function probeMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.T1_COVERAGE_PROBE_MAX_MB);
  return (Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 40) * 1024 * 1024;
}

/** T1 a-t-il rendu un contenu ? */
function hasContent(o: Out): boolean {
  return !!o.transcription?.trim() || (o.facts?.length ?? 0) > 0 || (o.tables?.length ?? 0) > 0 || (o.visual?.observations?.length ?? 0) > 0;
}

/** Vérification après lecture (passe + lots relus). */
function final(o: Out, segments: TextSegment[], probe: SourceProbe, relues: ReadonlySet<number>): SourceVerification {
  const cited = citedPages(o);
  // Marques des segments relus (texte d'un lot numéroté 1…k, recalé).
  for (const s of segments.slice(1)) for (const x of citedPages({ facts: [], tables: [], transcription: s.text }, s.pageOffset).pages) cited.pages.add(x);
  return verifyPdfCoverage({
    probe, cited, transcription: segments.map((s) => s.text).join('\n'), hasContent: hasContent(o), reread: relues,
  });
}

/** Lots de pages couvrant des plages (bornés par `maxChunks`) ; le reste est rendu à part. */
function planRanges(ranges: Array<{ start: number; end: number }>, chunkPages: number, maxChunks: number) {
  const chunks: Array<{ start: number; end: number }> = [];
  const reste: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    for (let s = r.start; s <= r.end; s += chunkPages) {
      const c = { start: s, end: Math.min(r.end, s + chunkPages - 1) };
      if (chunks.length < maxChunks) chunks.push(c); else reste.push(c);
    }
  }
  const beyond = reste.length > 0 ? { start: reste[0].start, end: reste[reste.length - 1].end } : null;
  return { chunks, beyond };
}
