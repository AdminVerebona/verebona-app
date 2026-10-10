/**
 * Construction DÉTERMINISTE de la couche A (fonctions pures) : texte
 * intégral → blocs / couples libellé-valeur / éléments de formulaire,
 * tableaux → structure + lignes, observations visuelles, métadonnées.
 *
 * Aucune limite de taille : un document de 2 000 pages produit autant
 * d'unités qu'il le faut. Les identifiants ne dépendent que du contenu et de
 * sa position (même texte ⇒ mêmes identifiants), ce qui rend la fusion de
 * plusieurs passes idempotente.
 */
import type { ExtractedTable, VisualObservation } from '../types';
import type { T1AnalyzeDocumentOutput } from '../master/t1-contract';
import {
  formField, hasStructurableValue, isNonInformational, labelValue, pageMarker, paginationFooter, plat,
} from './text';
import type { PageGap, SourceUnit, SourceUnitOrigin, TextSegment } from './types';

/** Bornes d'un bloc de texte : au-delà, le paragraphe est découpé (granularité de la couverture). */
export const BLOCK_MAX_LINES = 8;
export const BLOCK_MAX_CHARS = 600;

export const tableUnitId = (t: Pick<ExtractedTable, 'index' | 'pageStart'>) => `page:${t.pageStart ?? 1}:table:${t.index + 1}`;
export const rowUnitId = (t: Pick<ExtractedTable, 'index' | 'pageStart'>, row: number) => `${tableUnitId(t)}:row:${row + 1}`;
export const cellUnitId = (t: Pick<ExtractedTable, 'index' | 'pageStart'>, row: number, column: number) =>
  `${rowUnitId(t, row)}:cell:${column + 1}`;
export const visualUnitId = (o: Pick<VisualObservation, 'page'>, index: number) => `page:${o.page ?? 1}:visual:${index + 1}`;
export const VISUAL_SUMMARY_UNIT_ID = 'doc:visual:summary';
export const metaUnitId = (field: string) => `doc:meta:${field}`;
export const gapUnitId = (g: Pick<PageGap, 'pageStart' | 'pageEnd'>) => `page:${g.pageStart}:gap:${g.pageEnd}`;

/** Unité de ligne d'une adresse de cellule (`…:row:4:cell:3` → `…:row:4`). */
export const unitOfCell = (id: string) => id.replace(/:cell:\d+$/, '');

export interface BuildUnitsInput {
  /** Texte lu, par segment (passe principale, lots de pages). */
  segments: TextSegment[];
  tables?: ExtractedTable[];
  visual?: { summary?: string | null; observations?: VisualObservation[] } | null;
  document?: T1AnalyzeDocumentOutput['document'] | null;
  gaps?: PageGap[];
  /** Origine des unités de tableaux / visuels / métadonnées. */
  origin?: SourceUnitOrigin;
}

/** Découpe une ligne trop longue à des frontières d'espace (jamais au milieu d'un mot si possible). */
function decouper(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

class Builder {
  readonly units: SourceUnit[] = [];
  private readonly compteurs = new Map<string, number>();
  private readonly vus = new Set<string>();

  private next(page: number, kind: string): number {
    const k = `${page}:${kind}`;
    const n = (this.compteurs.get(k) ?? 0) + 1;
    this.compteurs.set(k, n);
    return n;
  }

  push(u: Omit<SourceUnit, 'ordinal'>): void {
    this.units.push({ ...u, ordinal: this.units.length });
  }

  /** Unité de texte ; un contenu identique sur la même page (recouvrement de lots) n'est pas dupliqué. */
  text(page: number, kind: 'TEXT_BLOCK' | 'LABEL_VALUE' | 'FORM_FIELD', text: string, origin: SourceUnitOrigin,
    extra: { label?: string; value?: string; checked?: boolean | null; segment: number }): void {
    const cle = `${page}:${kind}:${plat(text)}`;
    if (plat(text) && this.vus.has(cle)) return;
    this.vus.add(cle);
    const n = this.next(page, kind);
    const id = kind === 'TEXT_BLOCK' ? `page:${page}:block:${n}` : kind === 'LABEL_VALUE' ? `page:${page}:field:${n}` : `page:${page}:form:${n}`;
    this.push({
      sourceUnitId: id, kind, page, parentUnitId: null, text,
      ...(extra.label !== undefined ? { label: extra.label } : {}),
      ...(extra.value !== undefined ? { value: extra.value } : {}),
      payload: kind === 'FORM_FIELD' ? { checked: extra.checked ?? null } : {},
      location: { page, segment: extra.segment },
      origin,
      salient: kind !== 'TEXT_BLOCK' ? !isNonInformational(text) : hasStructurableValue(text),
    });
  }
}

function segmentUnits(b: Builder, seg: TextSegment, segIndex: number): void {
  const parts = seg.text.replace(/\r\n?/g, '\n').split('\f');
  const decorated = parts.some((p) => p.split('\n').some((l) => pageMarker(l) !== null));
  const footers = !decorated && parts.some((p) => p.split('\n').some((l) => paginationFooter(l) !== null));
  let page = seg.pageOffset + 1;
  let bloc: string[] = [];
  const flush = () => {
    const t = bloc.join('\n').trim();
    bloc = [];
    if (t) b.text(page, 'TEXT_BLOCK', t, seg.origin, { segment: segIndex });
  };
  parts.forEach((part, k) => {
    if (k > 0) { flush(); page += 1; }
    for (const brute of part.split('\n')) {
      const line = brute.trimEnd();
      const marque = pageMarker(line);
      if (marque !== null) { flush(); page = seg.pageOffset + marque; continue; }
      if (!line.trim()) { flush(); continue; }
      const pied = footers ? paginationFooter(line) : null;
      if (pied !== null) {
        // Pied de page « Page N/M » : unité non informative, fin de la page N.
        flush();
        b.text(page, 'TEXT_BLOCK', line.trim(), seg.origin, { segment: segIndex });
        page = seg.pageOffset + pied + 1;
        continue;
      }
      const ff = formField(line);
      if (ff) { flush(); b.text(page, 'FORM_FIELD', line.trim(), seg.origin, { label: ff.label, checked: ff.checked, segment: segIndex }); continue; }
      const lv = labelValue(line);
      if (lv) { flush(); b.text(page, 'LABEL_VALUE', line.trim(), seg.origin, { label: lv.label, value: lv.value, segment: segIndex }); continue; }
      for (const morceau of decouper(line, BLOCK_MAX_CHARS)) {
        const taille = bloc.reduce((s, l) => s + l.length + 1, 0);
        if (bloc.length >= BLOCK_MAX_LINES || (bloc.length > 0 && taille + morceau.length > BLOCK_MAX_CHARS)) flush();
        bloc.push(morceau);
      }
    }
  });
  flush();
}

const amountText = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

function metadataUnits(b: Builder, d: NonNullable<BuildUnitsInput['document']>, origin: SourceUnitOrigin): void {
  const meta = (field: string, text: string | null | undefined, payload: Record<string, unknown>, page?: number) => {
    if (!text || !String(text).trim()) return;
    b.push({
      sourceUnitId: metaUnitId(field), kind: 'DOCUMENT_METADATA', page: page ?? null, parentUnitId: null,
      text: String(text), payload: { field, ...payload }, location: page ? { page } : {}, origin, salient: false,
    });
  };
  if (d.title) meta('title', d.title.value, { confidence: d.title.confidence, evidence: d.title.evidence }, d.title.evidence?.page);
  if (d.description) meta('description', d.description.value, { confidence: d.description.confidence, evidence: d.description.evidence }, d.description.evidence?.page);
  if (d.documentDate) meta('documentDate', d.documentDate.value, { confidence: d.documentDate.confidence, evidence: d.documentDate.evidence }, d.documentDate.evidence?.page);
  if (d.supplier) meta('supplier', [d.supplier.name, d.supplier.siret].filter(Boolean).join(' — '), { confidence: d.supplier.confidence, evidence: d.supplier.evidence }, d.supplier.evidence?.page);
  if (d.amountCents) meta('amount', amountText(d.amountCents.value), { cents: d.amountCents.value, confidence: d.amountCents.confidence, evidence: d.amountCents.evidence }, d.amountCents.evidence?.page);
  if (d.classification) {
    const c = d.classification;
    meta('classification', [c.canonicalType, c.rubricCode, c.documentTypeCode].filter(Boolean).join(' / ') || null,
      { confidence: c.confidence, evidence: c.evidence }, c.evidence?.page);
  }
}

function tableUnits(b: Builder, tables: ExtractedTable[], origin: SourceUnitOrigin): void {
  for (const t of tables) {
    const id = tableUnitId(t);
    const entete = [t.title, t.columns.map((c) => c.header).filter(Boolean).join(' | ')].filter(Boolean).join('\n');
    b.push({
      sourceUnitId: id, kind: 'TABLE', page: t.pageStart ?? 1, parentUnitId: null, text: entete || null,
      payload: {
        tableIndex: t.index, title: t.title, columns: t.columns, rowCount: t.rowCount, columnCount: t.columnCount,
        uncertain: t.uncertain, issues: t.issues, pageEnd: t.pageEnd,
      },
      location: { page: t.pageStart ?? 1, tableIndex: t.index }, origin, salient: false,
    });
    const parLigne = new Map<number, ExtractedTable['cells']>();
    for (const c of t.cells) {
      const l = parLigne.get(c.row) ?? [];
      l.push(c);
      parLigne.set(c.row, l);
    }
    for (let r = 0; r < t.rowCount; r += 1) {
      const cells = (parLigne.get(r) ?? []).slice().sort((a, x) => a.column - x.column);
      const valeurs = cells.filter((c) => c.value !== null);
      const entete = cells.find((c) => c.rowHeader)?.rowHeader ?? null;
      const text = [entete, ...valeurs.map((c) => `${c.columnHeader ? `${c.columnHeader} : ` : ''}${c.value}`)].filter(Boolean).join(' | ');
      b.push({
        sourceUnitId: rowUnitId(t, r), kind: 'TABLE_ROW', page: cells.find((c) => c.page)?.page ?? t.pageStart ?? 1,
        parentUnitId: id, text: text || null,
        payload: {
          tableIndex: t.index, row: r, rowHeader: entete,
          cells: cells.map((c) => ({ column: c.column, header: c.columnHeader, value: c.value, normalized: c.normalized, page: c.page })),
        },
        location: { tableIndex: t.index, row: r }, origin, salient: valeurs.length > 0,
      });
    }
  }
}

/** Couche A d'une analyse (sans couverture). */
export function buildSourceUnits(p: BuildUnitsInput): SourceUnit[] {
  const b = new Builder();
  const origin = p.origin ?? 'PASS_1';
  if (p.document) metadataUnits(b, p.document, origin);
  p.segments.forEach((s, i) => { if (s.text?.trim()) segmentUnits(b, s, i); });
  tableUnits(b, p.tables ?? [], origin);
  (p.visual?.observations ?? []).forEach((o, i) => {
    b.push({
      sourceUnitId: visualUnitId(o, i), kind: 'VISUAL_OBSERVATION', page: o.page ?? 1, parentUnitId: null,
      text: [o.subject, o.description].filter(Boolean).join(' — '),
      payload: { description: o.description, subject: o.subject ?? null, confidence: o.confidence, imageIndex: o.imageIndex ?? null, region: o.region ?? null },
      location: { page: o.page ?? 1, ...(o.region ? { region: o.region } : {}), ...(o.imageIndex !== undefined ? { imageIndex: o.imageIndex } : {}) },
      origin, salient: true,
    });
  });
  if (p.visual?.summary?.trim()) {
    b.push({
      sourceUnitId: VISUAL_SUMMARY_UNIT_ID, kind: 'VISUAL_SUMMARY', page: null, parentUnitId: null,
      text: p.visual.summary.trim(), payload: {}, location: {}, origin, salient: true,
    });
  }
  for (const g of p.gaps ?? []) {
    b.push({
      sourceUnitId: gapUnitId(g), kind: 'PAGE_GAP', page: g.pageStart, parentUnitId: null, text: null,
      payload: { pageStart: g.pageStart, pageEnd: g.pageEnd, retryable: g.retryable, message: g.message.slice(0, 300) },
      location: { pageStart: g.pageStart, pageEnd: g.pageEnd }, origin: 'CHUNK', salient: true,
    });
  }
  return b.units;
}

/** Texte intégral à persister (`document_extractions.full_text`) : segments, marque de page entre lots. */
export function fullTextOf(segments: TextSegment[]): string {
  return segments
    .filter((s) => s.text?.trim())
    .map((s, i) => (i === 0 && s.pageOffset === 0 ? s.text : `--- page ${s.pageOffset + 1} ---\n${s.text}`))
    .join('\n');
}
