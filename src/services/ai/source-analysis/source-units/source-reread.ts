/**
 * Relecture du FICHIER pour les unités NEEDS_SOURCE — lot 54G (ticket « T1 :
 * finaliser la couverture réelle des documents et supprimer les pertes
 * résiduelles d'extraction », point 2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Une observation visuelle incertaine (`conflictual`) ne peut pas être levée
 * par une relecture du TEXTE déjà extrait (réparation ciblée textuelle) :
 * l'unité est NEEDS_SOURCE. La reprise planifiée `t1-completeness-retry`
 * relit alors le FICHIER ORIGINAL :
 *
 *   · fichier du compte uniquement (adaptateur fichier : contrôle
 *     d'appartenance), jamais un autre compte ;
 *   · PDF : seules les PAGES des unités concernées (sous-document en pièce
 *     jointe, lots de `T1_CHUNK_PAGES`, `T1_REPAIR_MAX_CALLS` appels au plus) ;
 *     image ou autre format : le fichier lui-même ;
 *   · même prompt maître T1, même TASK ANALYZE_DOCUMENT, même contrat, mêmes
 *     règles de preuve (`checkFactEvidence`) ; déclencheur distinct
 *     `t1_source_reread` (télémétrie : relecture ≠ réparation textuelle) ;
 *   · une unité n'est LEVÉE (SUCCEEDED, COVERED) que si la relecture rend, sur
 *     la même page, une observation correspondante NON conflictuelle (ou un
 *     fait visuel certain qui la décrit) — jamais par défaut ;
 *   · sinon l'incertitude est MAINTENUE : nouvelle tentative bornée, puis
 *     EXHAUSTED au plafond (`withRepairStates`, `sourceCap`) — aucune boucle ;
 *   · interruption d'exécution et plafond de coût IA : propagés (jamais
 *     avalés) ; toute autre erreur : relecture en échec, tentative comptée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isExecutionCancelled } from '../../queue/execution-control';
import { isCostCapReached } from '../../gateway/errors';
import type { AiAttachment } from '../../gateway/types';
import { checkFactEvidence } from '../master/fact-evidence';
import type { T1AnalyzeDocumentOutput, T1Fact } from '../master/t1-contract';
import type { AnalysisContext, SourceInput } from '../types';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';
import { offsetPages } from './merge';
import * as pagesChunks from './page-chunks';
import { mots, plat } from './text';
import { pageRanges } from './source-verification';
import type { CoveredSourceUnit } from './types';

export const SOURCE_REREAD_TRIGGER = 't1_source_reread';

type Out = T1AnalyzeDocumentOutput;

/** Appel ANALYZE_DOCUMENT (injecté : `callAnalyzeDocument`). */
export type SourceRereadCall = (p: {
  input: SourceInput; groupIndices: number[]; ctx: AnalysisContext; capabilities: AccountCapabilities; v2Families: V2AssetFamily[];
  attachments: AiAttachment[]; sources: string; triggerCode: string;
}) => Promise<{ output: Out }>;

export interface SourceRereadResult {
  /** Unités soumises (tentative comptée). */
  attempted: string[];
  /** Unités dont l'incertitude est levée par la nouvelle preuve. */
  resolved: string[];
  /** Faits visuels prouvés rattachés aux unités relues (ajoutés sans écraser l'existant). */
  facts: T1Fact[];
  /** Pages relues (PDF) ; vide : fichier entier. */
  pages: number[];
  calls: number;
  /** Relecture impossible ou en échec (fichier illisible, appel en échec). */
  failed: boolean;
  error?: string;
}

/** Description d'une observation ↔ description relue : inclusion ou mots distinctifs communs (≥ 60 %) — pure. */
export function sameObservation(a: string, b: string): boolean {
  const x = plat(a);
  const y = plat(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const mx = new Set(mots(a).filter((w) => w.length >= 4));
  const my = new Set(mots(b).filter((w) => w.length >= 4));
  if (mx.size === 0 || my.size === 0) return false;
  const communs = [...mx].filter((w) => my.has(w)).length;
  return communs / Math.min(mx.size, my.size) >= 0.6;
}

/**
 * Unités levées par une sortie de relecture (pages ABSOLUES) — pure. Une
 * unité est levée seulement par une observation de la même page, de même
 * description, NON conflictuelle ; ou par un fait VISUEL CERTAIN prouvé qui
 * la décrit sur la même page.
 */
export function resolveFromReread(targets: readonly CoveredSourceUnit[], out: Pick<Out, 'visual' | 'facts'>): { resolved: string[]; facts: T1Fact[] } {
  const resolved = new Set<string>();
  const facts: T1Fact[] = [];
  const desc = (u: CoveredSourceUnit) => String(u.payload.description ?? u.text ?? '');
  const memePage = (u: CoveredSourceUnit, page: number | undefined | null) => u.page === null || page === undefined || page === null || page === u.page;
  for (const u of targets) {
    for (const o of out.visual?.observations ?? []) {
      if (o.confidence !== 'conflictual' && memePage(u, o.page) && sameObservation(desc(u), o.description)) resolved.add(u.sourceUnitId);
    }
  }
  for (const f of out.facts ?? []) {
    if (f.provenance !== 'VISUAL_ANALYSIS') continue;
    const check = checkFactEvidence(f);
    if (!check.ok) continue;
    const d = check.fact.visualEvidence?.description ?? '';
    const page = check.fact.visualEvidence?.page ?? check.fact.evidence?.page;
    const cible = targets.find((u) => memePage(u, page) && sameObservation(desc(u), d));
    if (!cible) continue;
    facts.push(check.fact);
    if (check.fact.confidence === 'certain') resolved.add(cible.sourceUnitId);
  }
  return { resolved: [...resolved], facts };
}

/** Relecture du fichier pour des unités NEEDS_SOURCE (bornée par `maxCalls` appels). */
export async function runSourceReread(p: {
  input: SourceInput;
  ctx: AnalysisContext;
  capabilities: AccountCapabilities;
  v2Families: V2AssetFamily[];
  targets: readonly CoveredSourceUnit[];
  maxCalls: number;
  chunkPages: number;
  call: SourceRereadCall;
  /** Octets du fichier (injectable en test ; défaut : `fetchSourceBytes`). */
  fetchBytes?: (url: string) => Promise<Uint8Array | null>;
}): Promise<SourceRereadResult> {
  const res: SourceRereadResult = { attempted: p.targets.map((u) => u.sourceUnitId), resolved: [], facts: [], pages: [], calls: 0, failed: false };
  const url = p.input.contentUrls?.[0];
  const mime = p.input.mimeTypes[0] ?? 'application/pdf';
  const name = p.input.displayNames[0] ?? 'document';
  if (!url) return { ...res, failed: true, error: 'fichier source indisponible' };
  // Lots : pages des unités (PDF), sinon le fichier entier.
  const lots: Array<{ attachments: AiAttachment[]; offset: number; label: string }> = [];
  if (mime.includes('pdf')) {
    const bytes = await (p.fetchBytes ?? pagesChunks.fetchSourceBytes)(url);
    if (!bytes) return { ...res, failed: true, error: 'fichier source illisible' };
    const nPages = await pagesChunks.countPdfPages(bytes);
    if (!nPages) return { ...res, failed: true, error: 'PDF illisible' };
    const pages = [...new Set(p.targets.map((u) => Math.min(nPages, Math.max(1, u.page ?? 1))))].sort((a, b) => a - b);
    res.pages = pages;
    for (const r of pageRanges(pages)) {
      for (let s = r.start; s <= r.end; s += p.chunkPages) {
        const e = Math.min(r.end, s + p.chunkPages - 1);
        const sub = await pagesChunks.extractPdfPages(bytes, s, e);
        lots.push({ attachments: [pagesChunks.chunkAttachment({ url, displayName: name }, sub, s, e)], offset: s - 1, label: `${e - s + 1} page(s)` });
      }
    }
  } else {
    lots.push({ attachments: [{ url, mimeType: mime, displayName: name }], offset: 0, label: 'fichier' });
  }
  const resolus = new Set<string>();
  for (const lot of lots.slice(0, Math.max(1, p.maxCalls))) {
    try {
      res.calls++;
      const r = await p.call({
        input: p.input, groupIndices: [0], ctx: p.ctx, capabilities: p.capabilities, v2Families: p.v2Families,
        attachments: lot.attachments,
        sources: JSON.stringify([{
          index: 0, name: `${name} — relecture ciblée (${lot.label}, ${p.targets.length} observation(s) incertaine(s))`,
          mimeType: lot.attachments[0].mimeType, kind: 'document original (relecture ciblée)',
        }]),
        triggerCode: SOURCE_REREAD_TRIGGER,
      });
      const out = offsetPages(r.output, lot.offset);
      const v = resolveFromReread(p.targets, out);
      for (const id of v.resolved) resolus.add(id);
      res.facts.push(...v.facts);
    } catch (e) {
      if (isExecutionCancelled(e) || isCostCapReached(e)) throw e;
      res.failed = true;
      res.error = (e as Error).message ?? 'relecture en échec';
      console.warn('[t1-source-reread] relecture en échec :', res.error);
    }
  }
  res.resolved = [...resolus];
  return res;
}

/**
 * Couverture des unités après une relecture du fichier (pure) : tentative
 * comptée pour chaque unité relue ; COVERED / `observation_verified`
 * seulement si l'incertitude est levée par la nouvelle preuve ; sinon
 * l'unité reste UNCERTAIN (l'état NEEDS_SOURCE / EXHAUSTED est posé ensuite
 * par `withRepairStates`, `sourceCap`). Les autres unités ne sont pas touchées.
 */
export function applySourceReread<U extends CoveredSourceUnit>(units: readonly U[], r: Pick<SourceRereadResult, 'attempted' | 'resolved'>): U[] {
  const relues = new Set(r.attempted);
  const levees = new Set(r.resolved);
  return units.map((u) => {
    if (!relues.has(u.sourceUnitId)) return u;
    const base = { ...u, repairAttempts: u.repairAttempts + 1 };
    return levees.has(u.sourceUnitId) ? { ...base, status: 'COVERED' as const, reason: 'observation_verified', factCount: u.factCount + 1 } : base;
  });
}
