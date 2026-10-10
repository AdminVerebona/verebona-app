/**
 * Complétude T1 — orchestration (lot 34F) :
 *
 *   analyse (passe 1 + lots) → couche A (unités) → contrôle DÉTERMINISTE de
 *   couverture → si couverture complète : STOP ; sinon réparation ciblée des
 *   seules unités concernées (bornée) → fusion idempotente → nouveau contrôle
 *   → après projection : provenance fait → sourceUnitId[], requalifications
 *   tracées, rapport de complétude et état de qualité.
 *
 * Aucune deuxième passe systématique : un document dont chaque unité porteuse
 * d'une valeur est couverte ne déclenche aucun appel de plus.
 */
import { buildSourceUnits } from './build-units';
import {
  buildCompletenessReport, computeCoverage, DROP_REASONS, selectRepairUnits, SourceUnitLinker,
  type EvidenceRef, type FactLink,
} from './coverage';
import { mergeFacts } from './merge';
import { plat } from './text';
import { repairSettings, runRepairPass, type RepairCall } from './repair';
import {
  SOURCE_LAYER_VERSION, UNRESOLVED_REASONS,
  type PageGap, type SourceLayer, type SourceUnit, type SourceUnitOrigin, type TextSegment, type UnresolvedFactRecord, type UnresolvedReason,
} from './types';
import { factLabel } from '../master/fact-evidence';
import type { ProjectedFact, T1Fact } from '../master/t1-contract';
import type { T1DroppedItem } from '../master/tolerant-output';
import type { ProjectionWarning } from '../projection/document-projection';
import type { AnalysisContext, AnalysisWarning, SourceInput } from '../types';
import type { AnalyzeDocumentResult } from '../steps/analyze-document.step';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';

/** Matière de la couche A produite par l'étape d'analyse. */
export interface T1ExtractionExtras {
  segments: TextSegment[];
  gaps: PageGap[];
  dropped: Array<T1DroppedItem & { pass: SourceUnitOrigin }>;
  /** Faits lus sans preuve adaptée (écartés des faits, conservés ici). */
  noEvidence: T1Fact[];
  /** Champs retirés par la validation champ par champ de la passerelle (lot 33D). */
  prunedPaths: string[];
  batchedSections: number;
  truncatedSections: number;
  chunkCount: number;
  pageCount: number | null;
  capabilities: AccountCapabilities;
  v2Families: V2AssetFamily[];
}

export interface SourceLayerDraft {
  units: SourceUnit[];
  linker: SourceUnitLinker;
  metadataUnitIds: Set<string>;
  entityUnitIds: Set<string>;
  failed: Map<string, { reason: string; retryable: boolean }>;
  attempts: Map<string, number>;
  unresolved: UnresolvedFactRecord[];
  repairPassCount: number;
  repairCalls: number;
  extras: T1ExtractionExtras;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Preuve d'un fait (contrat T1 ou fait projeté). */
export function evidenceOf(f: Pick<T1Fact, 'provenance' | 'evidence' | 'visualEvidence' | 'rawValue' | 'normalizedValue' | 'rawKey' | 'label' | 'attribute'>): EvidenceRef {
  return {
    provenance: f.provenance,
    excerpt: f.evidence?.excerpt ?? null,
    page: f.evidence?.page ?? null,
    table: f.evidence?.table ?? null,
    visualDescription: f.visualEvidence?.description ?? null,
    visualPage: f.visualEvidence?.page ?? null,
    values: [f.rawValue, f.normalizedValue],
    labels: [f.rawKey, f.label, f.attribute],
  };
}

/** Preuve d'un élément BRUT (non validé) écarté par la lecture tolérante. */
function evidenceOfRaw(payload: unknown): EvidenceRef {
  if (!isObj(payload)) return {};
  const e = isObj(payload.evidence) ? payload.evidence : {};
  const v = isObj(payload.visualEvidence) ? payload.visualEvidence : {};
  const t = isObj(e.table) ? e.table : null;
  return {
    provenance: payload.provenance === 'VISUAL_ANALYSIS' ? 'VISUAL_ANALYSIS' : 'TEXT_EXTRACTION',
    excerpt: typeof e.excerpt === 'string' ? e.excerpt : null,
    page: typeof e.page === 'number' ? e.page : null,
    table: t && typeof t.index === 'number' && typeof t.row === 'number' && typeof t.column === 'number'
      ? { index: t.index, row: t.row, column: t.column } : null,
    visualDescription: typeof v.description === 'string' ? v.description : typeof payload.description === 'string' ? payload.description : null,
    visualPage: typeof v.page === 'number' ? v.page : typeof payload.page === 'number' ? payload.page : null,
    values: [str(payload.rawValue), str(payload.normalizedValue)],
    labels: [str(payload.rawKey), str(payload.label), str(payload.attribute)],
  };
}

const asReason = (r: string): UnresolvedReason => ((UNRESOLVED_REASONS as readonly string[]).includes(r) ? r as UnresolvedReason : 'INVALID_SCHEMA');

function droppedRecord(d: T1DroppedItem & { pass: SourceUnitOrigin }, linker: SourceUnitLinker): UnresolvedFactRecord {
  const p = isObj(d.payload) ? d.payload : {};
  return {
    reason: asReason(d.reason),
    status: 'UNRESOLVED',
    sourceUnitIds: linker.link(evidenceOfRaw(d.payload)),
    rawKey: str(p.rawKey ?? p.label ?? p.title ?? p.subject ?? null),
    canonicalKey: typeof p.canonicalKey === 'string' ? p.canonicalKey : null,
    rawValue: str(p.rawValue ?? p.normalizedValue ?? p.description ?? null),
    originalPayload: d.payload ?? null,
    pass: d.pass,
    detail: d.path,
  };
}

/** Couche A et réparation ciblée, AVANT projection. `null` sans matière (analyse simulée). */
export async function completeT1Extraction(p: {
  input: SourceInput;
  groupIndices: number[];
  ctx: AnalysisContext;
  analysed: AnalyzeDocumentResult;
  /** Appel ANALYZE_DOCUMENT (injecté pour éviter un cycle d'import). */
  call: RepairCall;
  /** Vérification en base des cibles des faits de réparation. */
  verifyTargets?: (facts: T1Fact[]) => Promise<{ verifiedIds: AnalyzeDocumentResult['verifiedIds']; warnings: AnalysisWarning[] }>;
  env?: Record<string, string | undefined>;
}): Promise<SourceLayerDraft | null> {
  const x = p.analysed.extraction;
  if (!x) return null;
  const a = p.analysed.analysis;
  const units = buildSourceUnits({
    segments: x.segments, tables: p.analysed.tables, visual: a.visual ?? null, document: a.document, gaps: x.gaps,
  });
  const linker = new SourceUnitLinker(units);
  const meta = new Set<string>();
  const d = a.document;
  for (const m of [d.title, d.description, d.documentDate, d.amountCents, d.classification, d.supplier]) {
    const ev = m?.evidence;
    if (ev?.excerpt) for (const id of linker.link({ excerpt: ev.excerpt, page: ev.page ?? null })) if (!id.startsWith('doc:')) meta.add(id);
  }
  if (d.supplier?.name) for (const id of linker.link({ excerpt: d.supplier.name })) if (!id.startsWith('doc:')) meta.add(id);
  const entites = new Set<string>();
  for (const c of [...a.entities.assets, ...a.entities.rooms, ...a.entities.equipments, ...a.entities.suppliers]) {
    for (const s of [...c.evidenceSignals, c.rawLabel ?? '']) {
      if (plat(s).length < 4) continue;
      for (const id of linker.link({ excerpt: s })) if (!id.startsWith('doc:')) entites.add(id);
    }
  }
  const unresolved: UnresolvedFactRecord[] = [
    ...x.dropped.map((dr) => droppedRecord(dr, linker)),
    ...x.noEvidence.map((f): UnresolvedFactRecord => ({
      reason: 'NO_EVIDENCE', status: 'UNRESOLVED', sourceUnitIds: linker.link({ ...evidenceOf(f), excerpt: null }),
      rawKey: f.rawKey ?? f.label ?? null, canonicalKey: f.canonicalKey, rawValue: str(f.rawValue ?? f.normalizedValue),
      originalPayload: f, pass: 'PASS_1', detail: f.provenance,
    })),
    ...x.prunedPaths.map((path): UnresolvedFactRecord => ({
      reason: 'FIELD_PRUNED', status: 'UNRESOLVED', sourceUnitIds: [], rawKey: null, canonicalKey: null, rawValue: null,
      originalPayload: { path }, pass: 'PASS_1', detail: path,
    })),
  ];

  const draft: SourceLayerDraft = {
    units, linker, metadataUnitIds: meta, entityUnitIds: entites, failed: new Map(), attempts: new Map(),
    unresolved, repairPassCount: 0, repairCalls: 0, extras: x,
  };

  // ── Réparation ciblée, bornée ──────────────────────────────────────────
  const { maxPasses, maxCalls, minUnits } = repairSettings(p.env);
  for (let pass = 1; pass <= maxPasses; pass++) {
    const cov = coverageOf(draft, a.facts);
    const cibles = selectRepairUnits(cov, maxPasses);
    if (cibles.length === 0 || cibles.length < minUnits) break;
    const r = await runRepairPass({
      input: p.input, groupIndices: p.groupIndices, ctx: p.ctx, capabilities: x.capabilities, v2Families: x.v2Families,
      units: cibles, maxCalls, pass, call: p.call,
    });
    draft.repairPassCount++;
    draft.repairCalls += r.calls;
    for (const id of r.attempted) {
      draft.attempts.set(id, (draft.attempts.get(id) ?? 0) + 1);
      const f = r.failed.get(id);
      if (f) draft.failed.set(id, f); else draft.failed.delete(id);
    }
    const ajoutes = mergeFacts(a.facts, r.facts);
    if (ajoutes.length > 0 && p.verifyTargets) {
      const v = await p.verifyTargets(ajoutes);
      for (const k of Object.keys(v.verifiedIds) as Array<keyof typeof v.verifiedIds>) {
        for (const id of v.verifiedIds[k]) p.analysed.verifiedIds[k].add(id);
      }
      p.analysed.warnings.push(...v.warnings);
    }
    console.info(`[t1-repair] passe ${pass} : ${cibles.length} unité(s) ciblée(s), ${r.calls} appel(s), ${ajoutes.length} fait(s) ajouté(s), ${r.failed.size} en échec`);
    if (ajoutes.length === 0 && r.failed.size === 0) break;
  }
  return draft;
}

function factLinks(draft: SourceLayerDraft, facts: readonly T1Fact[]): FactLink[] {
  return facts.map((f) => ({ unitIds: draft.linker.link(evidenceOf(f)), confidence: f.confidence }));
}

function coverageOf(draft: SourceLayerDraft, facts: readonly T1Fact[]) {
  return computeCoverage(draft.units, {
    facts: factLinks(draft, facts),
    metadataUnitIds: draft.metadataUnitIds,
    entityUnitIds: draft.entityUnitIds,
    droppedUnitIds: draft.unresolved.filter((u) => u.status === 'UNRESOLVED' && DROP_REASONS.has(u.reason)).flatMap((u) => u.sourceUnitIds),
    failed: draft.failed,
    repairAttempts: draft.attempts,
  });
}

/** Avertissements de projection → motif de conservation d'un fait requalifié. */
const REQUALIFICATIONS: Readonly<Record<string, UnresolvedReason>> = {
  UNKNOWN_CANONICAL_KEY: 'UNKNOWN_CANONICAL_KEY',
  VALUE_NOT_NORMALIZABLE: 'VALUE_NOT_NORMALIZABLE',
  UNIT_MISMATCH: 'VALUE_NOT_NORMALIZABLE',
  KEY_NOT_APPLICABLE_TO_FAMILY: 'KEY_NOT_APPLICABLE',
  KEY_INPUT_ONLY: 'KEY_NOT_APPLICABLE',
  CANONICAL_KEY_TARGET_MISMATCH: 'KEY_NOT_APPLICABLE',
  TARGET_UNVERIFIED: 'UNKNOWN_TARGET',
};

/**
 * Après projection : provenance des faits projetés (`sourceUnitIds`, posé
 * EN PLACE), requalifications tracées, couverture finale, rapport, état de
 * qualité et avertissements fonctionnels.
 */
export function finalizeSourceLayer(draft: SourceLayerDraft, p: {
  analysisFacts: readonly T1Fact[];
  projected: ProjectedFact[];
  projectionWarnings: readonly ProjectionWarning[];
  warningCodes: readonly string[];
  retryAllowed?: boolean;
}): { layer: SourceLayer; warnings: AnalysisWarning[] } {
  for (const f of p.projected) {
    f.sourceUnitIds = draft.linker.link({
      provenance: f.provenance, excerpt: f.evidence?.excerpt ?? null, page: f.evidence?.page ?? null,
      table: f.evidence?.table ?? null, visualDescription: f.visualEvidence?.description ?? null,
      visualPage: f.visualEvidence?.page ?? null, values: [f.rawValue, f.value], labels: [f.rawKey, f.label, f.attribute],
    });
  }
  const cov = coverageOf(draft, p.analysisFacts);
  const couvertes = new Set(cov.filter((u) => u.status === 'COVERED' && u.reason === 'fact').map((u) => u.sourceUnitId));
  const records = draft.unresolved.map((r) => (
    r.status === 'UNRESOLVED' && DROP_REASONS.has(r.reason) && r.sourceUnitIds.length > 0
      && draft.repairPassCount > 0 && r.sourceUnitIds.every((id) => couvertes.has(id.replace(/:cell:\d+$/, '')))
      ? { ...r, status: 'RECOVERED' as const } : r
  ));
  // Requalifications : le fait existe (générique, cible neutralisée), mais pas tel qu'annoncé.
  const vus = new Set<string>();
  for (const w of p.projectionWarnings) {
    const reason = REQUALIFICATIONS[w.code];
    if (!reason || !w.target) continue;
    const concernes = p.analysisFacts.filter((f) => (w.code === 'TARGET_UNVERIFIED'
      ? factLabel(f) === w.target && f.target.entityId !== null
      : f.canonicalKey === w.target));
    for (const f of concernes) {
      const k = `${reason}:${p.analysisFacts.indexOf(f)}`;
      if (vus.has(k)) continue;
      vus.add(k);
      records.push({
        reason, status: 'RETAINED', sourceUnitIds: draft.linker.link(evidenceOf(f)),
        rawKey: f.rawKey ?? f.label ?? null, canonicalKey: f.canonicalKey, rawValue: str(f.rawValue ?? f.normalizedValue),
        originalPayload: f, pass: 'PASS_1', detail: w.message.slice(0, 300),
      });
    }
  }
  const report = buildCompletenessReport(cov, {
    factsCount: p.projected.length,
    unresolvedFacts: records,
    truncatedSectionsCount: draft.extras.truncatedSections,
    batchedSectionsCount: draft.extras.batchedSections,
    repairPassCount: draft.repairPassCount,
    chunkCount: draft.extras.chunkCount,
    warningCodes: p.warningCodes,
    retryAllowed: p.retryAllowed ?? true,
  });
  const warnings: AnalysisWarning[] = [];
  if (report.failedUnits > 0) {
    warnings.push({
      code: 'SOURCE_UNIT_FAILED',
      message: `${report.failedUnits} unité(s) de la source non analysée(s) — contenu conservé, ${report.qualityState === 'INCOMPLETE_RETRYABLE' ? 'nouvelle tentative programmée' : 'reprise manuelle nécessaire'}.`,
      target: 't1-completeness:failed',
    });
  }
  if (report.qualityState === 'INCOMPLETE_RETRYABLE' || report.qualityState === 'INCOMPLETE_FINAL') {
    warnings.push({
      code: 'COVERAGE_INCOMPLETE',
      message: `Couverture de la source incomplète (${Math.round(report.coverageRatio * 100)} %, état ${report.qualityState}).`,
      target: 't1-completeness:incomplete',
    });
  }
  return {
    layer: {
      layerVersion: SOURCE_LAYER_VERSION,
      units: cov,
      unresolvedFacts: records,
      report,
      retryable: report.qualityState === 'INCOMPLETE_RETRYABLE',
    },
    warnings,
  };
}
