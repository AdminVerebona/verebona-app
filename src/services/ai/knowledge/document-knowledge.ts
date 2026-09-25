/**
 * Représentation durable d'un document — construction (fonctions pures).
 *
 * T1 produit un `SourceAnalysisResult`. Ce module en tire les deux premiers
 * niveaux de la base de connaissance documentaire :
 *
 *   1. contenu source extrait (texte, description, titre, date, émetteur,
 *      montant, éléments structurants et leurs preuves, métadonnées) ;
 *   2. faits génériques (« Chaudière / puissance / 24 / kW »), chacun avec
 *      confiance, extrait justificatif, localisation et provenance.
 *
 * Le troisième niveau — les projections métier — reste celui de la
 * réconciliation (T3). Voir `document-knowledge.service.ts`.
 *
 * Aucun accès base ici : ces fonctions sont testées sans infrastructure.
 */
import type { SourceAnalysisResult, ExtractedField, ExtractedTable, FactProvenance, VisualEvidence, VisualObservation } from '../source-analysis/types';
import { cellContext } from './document-tables';
import { EXTRACT_SOURCE_PROMPT_VERSION } from '../source-analysis/prompt-version';

export type KnowledgeEngine = 'source_analysis' | 'legacy';

export interface DocumentExtractionRecord {
  accountId: number;
  fileId: number;
  analysisRunId: number | null;
  assetIdAtAnalysis: number | null;
  engine: KnowledgeEngine;
  sourceType: 'asset_file' | 'web_link';
  sourceVersion: number | null;
  title: string | null;
  description: string | null;
  documentDate: string | null;
  supplierName: string | null;
  supplierSiret: string | null;
  amountCents: number | null;
  currency: string;
  /** Texte réellement lisible — jamais d'interprétation visuelle. */
  fullText: string | null;
  /** Observations visuelles (0161), séparées du texte et de la description. */
  visualSummary: string | null;
  visualObservations: VisualObservation[];
  documentTypeCode: string | null;
  rubricCode: string | null;
  hasExploitableContent: boolean;
  structuralEvidence: Record<string, { confidence: string; excerpt: string; location?: Record<string, unknown> }>;
  metadata: Record<string, unknown>;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  operationTraceId: string | null;
}

export interface DocumentFactRecord {
  factKey: string;
  subject: string | null;
  attribute: string | null;
  label: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueUnit: string | null;
  valueJson: unknown;
  normalizedValue: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  confidence: 'certain' | 'probable' | 'conflictual';
  /** Extrait littéral ; `null` pour une observation visuelle (jamais de faux extrait). */
  excerpt: string | null;
  location: Record<string, unknown>;
  /** TEXT_EXTRACTION (lu) | VISUAL_ANALYSIS (observé) — 0161. */
  evidenceOrigin: FactProvenance;
  visualEvidence: VisualEvidence | null;
}

export interface DocumentKnowledge {
  extraction: DocumentExtractionRecord;
  facts: DocumentFactRecord[];
  /** Tableaux structurés (0162) ; absents = aucun tableau. */
  tables?: ExtractedTable[];
}

// ── Valeurs et unités ──────────────────────────────────────────────────────

/**
 * Unités reconnues quand le modèle a laissé l'unité dans la valeur
 * (« 24 kW »). Liste volontairement fermée : une unité inventée à partir d'un
 * mot quelconque (« 3 portes ») serait pire que pas d'unité.
 */
const KNOWN_UNITS = [
  'kWh', 'kW', 'W', 'MWh', 'kVA', 'A', 'V', 'Wc',
  'm²', 'm2', 'm³', 'm3', 'm', 'cm', 'mm', 'km',
  'L', 'l', 'kg', 'g', 't',
  '€', 'EUR', '€ TTC', '€ HT', '%',
  'ans', 'an', 'mois', 'jours', 'j', 'h',
  'ch', 'CV', 'cv', 'bar', '°C', 'dB', 'Go', 'To', 'Mo', 'pouces', '"',
] as const;

/** Nombre au format français ou anglais : « 1 250,50 », « 1250.5 », « 24 ». */
function parseLocaleNumber(raw: string): number | null {
  const compact = raw.replace(/[\s  ]/g, '');
  // Identifiants (« 0612345678 », « 07723 ») : jamais des quantités.
  if (/^-?0\d/.test(compact)) return null;
  // « 1.250 » : millier français ou décimale anglaise ? Ambigu → pas de nombre.
  if (/^-?[1-9]\d{0,2}\.\d{3}$/.test(compact)) return null;
  if (!/^-?\d+([.,]\d+)?$/.test(compact) && !/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(compact)) return null;
  const normalized = /,\d+$/.test(compact) ? compact.replace(/\./g, '').replace(',', '.') : compact;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sépare une valeur « 24 kW » en { number: 24, unit: 'kW' }. Rend `null` si
 * la chaîne n'est pas exactement un nombre suivi d'une unité connue.
 */
export function splitValueAndUnit(value: string): { number: number; unit: string | null } | null {
  const trimmed = value.trim();
  const direct = parseLocaleNumber(trimmed);
  if (direct !== null) return { number: direct, unit: null };
  for (const unit of [...KNOWN_UNITS].sort((a, b) => b.length - a.length)) {
    if (trimmed.endsWith(unit)) {
      const n = parseLocaleNumber(trimmed.slice(0, -unit.length));
      if (n !== null) return { number: n, unit };
    }
    if (trimmed.startsWith(unit) && (unit === '€' || unit === 'EUR')) {
      const n = parseLocaleNumber(trimmed.slice(unit.length));
      if (n !== null) return { number: n, unit };
    }
  }
  return null;
}

/**
 * Sujet / attribut déduits d'une clé pointée (`chaudiere.puissance`) quand le
 * modèle ne les a pas fournis. Une clé simple ne permet pas de deviner : on
 * n'invente rien.
 */
function subjectAttributeFromKey(key: string): { subject: string | null; attribute: string | null } {
  const parts = key.split('.').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { subject: parts.slice(0, -1).join(' '), attribute: parts[parts.length - 1] };
  }
  return { subject: null, attribute: null };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoOrNull = (v: string | undefined | null) => (v && ISO_DATE.test(v) ? v : null);

/** Transforme un champ extrait en fait générique. */
export function toFact(field: ExtractedField): DocumentFactRecord {
  const visual = field.provenance === 'VISUAL_ANALYSIS';
  const derived = subjectAttributeFromKey(field.fieldKey);
  let valueNumber: number | null = null;
  let valueUnit: string | null = field.unit?.trim() || null;
  let valueText: string | null = null;

  if (typeof field.value === 'number') {
    valueNumber = field.value;
    valueText = String(field.value);
  } else if (typeof field.value === 'boolean') {
    valueText = field.value ? 'oui' : 'non';
  } else if (typeof field.value === 'string') {
    valueText = field.value;
    // Une chaîne n'est lue comme nombre qu'accompagnée d'une unité (dans la
    // valeur ou fournie à part) : « 7723001 » (numéro de série), « 75001 »
    // (code postal) restent du texte.
    const split = splitValueAndUnit(field.value);
    if (split && (split.unit || valueUnit)) {
      valueNumber = split.number;
      valueUnit = valueUnit ?? split.unit;
    }
  }

  const location: Record<string, unknown> = {};
  if (field.page) location.page = field.page;
  if (field.selector) location.selector = field.selector;
  if (field.section) location.section = field.section;

  return {
    factKey: field.fieldKey,
    subject: field.subject?.trim() || derived.subject,
    attribute: field.attribute?.trim() || derived.attribute,
    label: field.label?.trim() || null,
    valueText,
    valueNumber,
    valueUnit,
    valueJson: field.value ?? null,
    normalizedValue: field.normalizedValue ?? (valueNumber !== null ? String(valueNumber) : valueText?.trim().toLowerCase() ?? null),
    periodStart: isoOrNull(field.periodStart),
    periodEnd: isoOrNull(field.periodEnd),
    confidence: field.confidence,
    excerpt: visual ? null : (field.excerpt ?? null),
    location,
    evidenceOrigin: visual ? 'VISUAL_ANALYSIS' : 'TEXT_EXTRACTION',
    visualEvidence: visual ? (field.visualEvidence ?? null) : null,
  };
}

/**
 * Observation visuelle de niveau document → fait recherchable par T2
 * (« Est-ce une chaudière murale ? ») sans rouvrir le fichier. Elle reste
 * marquée VISUAL_ANALYSIS : T2 la présente comme une observation, jamais
 * comme une citation.
 */
export function observationToFact(o: VisualObservation, index: number, key = `visual.observation.${index + 1}`): DocumentFactRecord {
  const location: Record<string, unknown> = {};
  if (o.page) location.page = o.page;
  return {
    factKey: key,
    subject: o.subject?.trim() || null,
    attribute: 'observation visuelle',
    label: null,
    valueText: o.description,
    valueNumber: null,
    valueUnit: null,
    valueJson: o.description,
    normalizedValue: o.description.trim().toLowerCase(),
    periodStart: null,
    periodEnd: null,
    confidence: o.confidence,
    excerpt: null,
    location,
    evidenceOrigin: 'VISUAL_ANALYSIS',
    visualEvidence: { page: o.page, imageIndex: o.imageIndex, region: o.region, description: o.description },
  };
}

/**
 * Fait lu dans une cellule : sa preuve garde le contexte tabulaire (tableau,
 * ligne, colonne, page) — « 78 000 km » seul ne dit pas de quel véhicule.
 */
function withTableContext(fact: DocumentFactRecord, field: ExtractedField, tables: ExtractedTable[]): DocumentFactRecord {
  if (!field.table) return fact;
  const t = tables[field.table.index];
  const ctx = t ? cellContext(t, field.table.row, field.table.column) : null;
  if (!ctx) return fact;
  return {
    ...fact,
    location: { ...fact.location, table: ctx, ...(ctx.page && !fact.location.page ? { page: ctx.page } : {}) },
    label: fact.label ?? ([ctx.rowHeader, ctx.columnHeader].filter(Boolean).join(' — ') || null),
  };
}

/** Un fait n'est persisté qu'avec la preuve de sa provenance. */
function hasEvidence(f: DocumentFactRecord): boolean {
  return f.evidenceOrigin === 'VISUAL_ANALYSIS'
    ? !!f.visualEvidence?.description?.trim() && f.excerpt === null
    : !!f.excerpt && f.excerpt.trim().length > 0;
}

/**
 * Représentation durable issue du moteur d'analyse unifié (T1).
 */
export function buildKnowledgeFromSourceAnalysis(
  result: SourceAnalysisResult,
  ctx: {
    accountId: number;
    fileId: number;
    analysisRunId: number | null;
    assetIdAtAnalysis: number | null;
    sourceType: 'asset_file' | 'web_link';
    sourceVersion?: number | null;
    promptVersion?: string;
  },
): DocumentKnowledge {
  const d = result.document;
  const evidence: DocumentExtractionRecord['structuralEvidence'] = {};
  const keep = (key: string, v?: { confidence: string; excerpt: string; location?: object }) => {
    if (v) evidence[key] = { confidence: v.confidence, excerpt: v.excerpt, location: (v.location ?? {}) as Record<string, unknown> };
  };
  keep('title', d.title);
  keep('description', d.description);
  keep('documentDate', d.date);
  keep('supplier', d.supplier);
  keep('amountCents', d.amountCents);
  keep('documentType', d.type);

  const hasExploitableContent = !result.warnings.some((w) => w.code === 'NO_EXPLOITABLE_CONTENT');

  return {
    extraction: {
      accountId: ctx.accountId,
      fileId: ctx.fileId,
      analysisRunId: ctx.analysisRunId,
      assetIdAtAnalysis: ctx.assetIdAtAnalysis,
      engine: 'source_analysis',
      sourceType: ctx.sourceType,
      sourceVersion: ctx.sourceVersion ?? null,
      title: d.title?.value ?? null,
      description: d.description?.value ?? null,
      documentDate: isoOrNull(d.date?.value ?? null),
      supplierName: d.supplier?.value.name ?? null,
      supplierSiret: d.supplier?.value.siret ?? null,
      amountCents: typeof d.amountCents?.value === 'number' ? d.amountCents.value : null,
      currency: 'EUR',
      fullText: d.transcription?.trim() || null,
      visualSummary: d.visual?.summary?.trim() || null,
      visualObservations: d.visual?.observations ?? [],
      documentTypeCode: d.rubric?.documentTypeCode ?? null,
      rubricCode: d.rubric?.rubricCode ?? null,
      hasExploitableContent,
      structuralEvidence: evidence,
      metadata: {
        sourceIds: result.sourceGroup.sourceIds,
        legacyDocumentType: d.type?.value ?? null,
        category: d.category?.value ?? null,
        warnings: result.warnings.map((w) => w.code),
        assetCandidates: result.assetCandidates.map((c) => ({
          entityId: c.entityId, rawLabel: c.rawLabel ?? null, confidence: c.confidence, verified: c.verified,
        })),
        roomCandidates: result.roomCandidates.map((c) => ({ entityId: c.entityId, rawLabel: c.rawLabel ?? null, verified: c.verified })),
        equipmentCandidates: result.equipmentCandidates.map((c) => ({ entityId: c.entityId, rawLabel: c.rawLabel ?? null, verified: c.verified })),
        agendaCandidates: result.agendaCandidates.map((a) => ({ title: a.title, date: a.date, confidence: a.confidence })),
        // Trace des tableaux (le détail est dans document_tables / document_table_cells).
        tables: (d.tables ?? []).map((t) => ({ index: t.index, title: t.title, pages: [t.pageStart, t.pageEnd], rows: t.rowCount, columns: t.columnCount, uncertain: t.uncertain, issues: t.issues })),
      },
      provider: result.operationTrace.usedFallback ? 'fallback' : 'gemini',
      model: result.operationTrace.models[0] ?? null,
      promptVersion: ctx.promptVersion ?? EXTRACT_SOURCE_PROMPT_VERSION,
      operationTraceId: result.operationTrace.traceIds[0] ?? null,
    },
    tables: d.tables ?? [],
    facts: [
      ...result.extractedFields.map((f) => withTableContext(toFact(f), f, d.tables ?? [])),
      ...(d.visual?.observations ?? []).map((o, i) => observationToFact(o, i)),
      // Photo sans texte : la vue d'ensemble est la seule information — elle
      // doit rester trouvable, avec une confiance modérée.
      ...(d.visual?.summary ? [observationToFact({ description: d.visual.summary, confidence: 'probable' }, 0, 'visual.summary')] : []),
    ].filter(hasEvidence),
  };
}

/** Faits → champs extraits, pour produire des projections sans relire le fichier. */
export function factsToExtractedFields(facts: Array<Pick<DocumentFactRecord,
  'factKey' | 'valueJson' | 'normalizedValue' | 'confidence' | 'excerpt' | 'location'>
  & Partial<Pick<DocumentFactRecord, 'evidenceOrigin' | 'visualEvidence'>>>): ExtractedField[] {
  return facts
    // Les observations de niveau document décrivent la source, pas un champ du bien.
    .filter((f) => !f.factKey.startsWith('visual.'))
    .map((f) => ({
    fieldKey: f.factKey,
    value: f.valueJson,
    normalizedValue: f.normalizedValue ?? undefined,
    confidence: f.confidence,
    excerpt: f.excerpt ?? undefined,
    provenance: f.evidenceOrigin ?? 'TEXT_EXTRACTION',
    visualEvidence: f.visualEvidence ?? undefined,
    page: typeof f.location.page === 'number' ? f.location.page : undefined,
    selector: typeof f.location.selector === 'string' ? f.location.selector : undefined,
  }));
}
