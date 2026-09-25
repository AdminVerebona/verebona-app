/**
 * Tableaux extraits par T1 — structure ligne/colonne (fonctions pures).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN TABLEAU DONT LES ASSOCIATIONS SONT PERDUES EST UN TABLEAU MAL EXTRAIT
 *
 * La transcription garde le texte ; ce module garde les RELATIONS :
 *   · chaque cellule est rangée par index de ligne et de colonne, jamais par
 *     position dans une liste — une cellule vide reste une cellule vide et ne
 *     décale rien ;
 *   · une cellule fusionnée (colspan / rowspan) couvre explicitement les
 *     positions voisines, qui ne deviennent pas des « vides » ;
 *   · un tableau poursuivi sur la page suivante (mêmes en-têtes, pages
 *     contiguës) reste UN tableau ;
 *   · une structure douteuse est marquée `uncertain` et n'est jamais
 *     « réparée » : on ne reconstruit pas une association que la source ne
 *     garantit pas.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ExtractSourceOutput } from '../source-analysis/schemas';
import type { EvidenceConfidence } from '../evidence/evidence.types';
import type { ExtractedTable, ExtractedTableCell } from '../source-analysis/types';

type RawTable = ExtractSourceOutput['tables'][number];

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const weaker = (c: EvidenceConfidence): EvidenceConfidence => (c === 'certain' ? 'probable' : c);

function sameHeaders(a: RawTable, b: RawTable): boolean {
  if (a.columns.length !== b.columns.length) return false;
  return a.columns.every((c, i) => plain(c.header) === plain(b.columns[i].header));
}

/**
 * Continuité multi-pages : même en-têtes, page suivante, pas de titre
 * différent. Sinon, deux tableaux restent deux tableaux.
 */
function continues(prev: RawTable, next: RawTable): boolean {
  const end = prev.pageEnd ?? prev.pageStart;
  if (!end || !next.pageStart || next.pageStart !== end + 1) return false;
  if (next.title && prev.title && plain(next.title) !== plain(prev.title)) return false;
  return sameHeaders(prev, next);
}

/** Ligne d'en-tête répétée en haut d'une page : pas une ligne de données. */
function isRepeatedHeader(row: RawTable['rows'][number], t: RawTable): boolean {
  if (row.cells.length !== t.columns.length) return false;
  return row.cells.every((c) => c.value !== null && plain(String(c.value)) === plain(t.columns[c.column]?.header ?? ''));
}

export function normalizeTables(raw: RawTable[] | undefined): ExtractedTable[] {
  return normalizeTablesWithMap(raw).tables;
}

/**
 * Comme `normalizeTables`, avec la correspondance entre la position d'une
 * cellule dans la sortie modèle (tableau, ligne) et sa position après
 * fusion multi-pages — les faits y font référence.
 */
export function normalizeTablesWithMap(raw: RawTable[] | undefined): {
  tables: ExtractedTable[];
  locate: (rawIndex: number, rawRow: number) => { index: number; row: number } | null;
} {
  if (!raw || raw.length === 0) return { tables: [], locate: () => null };

  // 1. Continuité multi-pages.
  const merged: Array<{ t: RawTable; issues: string[] }> = [];
  /** rawIndex → (rawRow → { index, row }) */
  const where = new Map<number, Map<number, { index: number; row: number }>>();
  raw.forEach((t, rawIndex) => {
    const last = merged[merged.length - 1];
    const rowMap = new Map<number, { index: number; row: number }>();
    if (last && continues(last.t, t)) {
      const offset = last.t.rows.length;
      let k = 0;
      const kept: RawTable['rows'] = [];
      t.rows.forEach((r, i) => {
        if (isRepeatedHeader(r, t)) return;
        rowMap.set(i, { index: merged.length - 1, row: offset + k });
        k += 1;
        kept.push({ ...r, page: r.page ?? t.pageStart });
      });
      last.t = {
        ...last.t,
        pageEnd: t.pageEnd ?? t.pageStart,
        rows: [...last.t.rows, ...kept],
        uncertain: last.t.uncertain || t.uncertain,
      };
      last.issues.push(`suite page ${t.pageStart} rattachée au même tableau`);
    } else {
      t.rows.forEach((_, i) => rowMap.set(i, { index: merged.length, row: i }));
      merged.push({ t: { ...t, rows: t.rows.map((r) => ({ ...r, page: r.page ?? t.pageStart })) }, issues: [] });
    }
    where.set(rawIndex, rowMap);
  });

  // 2. Grille explicite.
  const tables = merged.map(({ t, issues }, index) => {
    const columnCount = t.columns.length;
    const columns = t.columns.map((c) => ({ header: c.header.trim(), path: c.path?.length ? c.path : [c.header.trim()] }));
    let uncertain = t.uncertain;
    if (t.uncertaintyNote) issues.push(t.uncertaintyNote);
    const tableConfidence: EvidenceConfidence = t.confidence ?? 'certain';
    const cells: ExtractedTableCell[] = [];
    /** Positions couvertes par une cellule fusionnée (« r:c »). */
    const covered = new Set<string>();

    t.rows.forEach((row, r) => {
      const seen = new Set<number>();
      for (const c of row.cells) {
        if (c.column >= columnCount) {
          uncertain = true;
          issues.push(`ligne ${r + 1} : cellule hors des ${columnCount} colonnes, écartée`);
          continue;
        }
        if (seen.has(c.column) || covered.has(`${r}:${c.column}`)) {
          uncertain = true;
          issues.push(`ligne ${r + 1}, colonne ${c.column + 1} : deux valeurs pour une même cellule`);
          continue;
        }
        const colspan = Math.min(c.colspan ?? 1, columnCount - c.column);
        const rowspan = Math.min(c.rowspan ?? 1, t.rows.length - r);
        for (let dr = 0; dr < rowspan; dr += 1) {
          for (let dc = 0; dc < colspan; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            covered.add(`${r + dr}:${c.column + dc}`);
          }
        }
        for (let dc = 0; dc < colspan; dc += 1) seen.add(c.column + dc);
        const value = c.value === null || (typeof c.value === 'string' && c.value.trim() === '') ? null : String(c.value).trim();
        const base = c.confidence ?? tableConfidence;
        cells.push({
          row: r, column: c.column,
          rowHeader: row.header?.trim() || null,
          columnHeader: columns[c.column].header,
          columnPath: columns[c.column].path,
          value,
          normalized: value === null ? null : (c.normalized?.trim() || null),
          valueType: c.valueType ?? null,
          colspan, rowspan,
          page: row.page ?? t.pageStart ?? null,
          confidence: uncertain ? weaker(base) : base,
        });
      }
      // Cellules absentes ET non couvertes : explicitement vides.
      for (let col = 0; col < columnCount; col += 1) {
        if (seen.has(col) || covered.has(`${r}:${col}`)) continue;
        cells.push({
          row: r, column: col, rowHeader: row.header?.trim() || null,
          columnHeader: columns[col].header, columnPath: columns[col].path,
          value: null, normalized: null, valueType: null, colspan: 1, rowspan: 1,
          page: row.page ?? t.pageStart ?? null, confidence: tableConfidence,
        });
      }
    });

    // Une incertitude détectée après coup s'applique à toutes les cellules.
    const finalCells = uncertain ? cells.map((c) => ({ ...c, confidence: weaker(c.confidence) })) : cells;
    finalCells.sort((a, b) => a.row - b.row || a.column - b.column);

    return {
      index,
      title: t.title?.trim() || null,
      pageStart: t.pageStart ?? null,
      pageEnd: t.pageEnd ?? t.pageStart ?? null,
      columns,
      rowCount: t.rows.length,
      columnCount,
      cells: finalCells,
      confidence: uncertain ? weaker(tableConfidence) : tableConfidence,
      uncertain,
      issues: [...new Set(issues)],
    };
  });
  return { tables, locate: (rawIndex, rawRow) => where.get(rawIndex)?.get(rawRow) ?? null };
}

/** Cellule effective à une position, fusions comprises. */
export function cellAt(t: Pick<ExtractedTable, 'cells'>, row: number, column: number): ExtractedTableCell | null {
  return t.cells.find((c) => row >= c.row && row < c.row + c.rowspan && column >= c.column && column < c.column + c.colspan) ?? null;
}

/** Contexte tabulaire d'une valeur — la preuve d'un fait issu d'une cellule. */
export function cellContext(t: ExtractedTable, row: number, column: number): Record<string, unknown> | null {
  const cell = cellAt(t, row, column);
  if (!cell) return null;
  return {
    tableIndex: t.index,
    title: t.title,
    row,
    column,
    rowHeader: cell.rowHeader ?? rowLabel(t, row),
    columnHeader: t.columns[column]?.header ?? null,
    columnPath: t.columns[column]?.path ?? [],
    page: cell.page,
    rawValue: cell.value,
  };
}

/** Libellé d'une ligne sans en-tête : sa première cellule non vide. */
export function rowLabel(t: Pick<ExtractedTable, 'cells'>, row: number): string | null {
  const first = t.cells.filter((c) => c.row === row && c.value !== null).sort((a, b) => a.column - b.column)[0];
  return first?.value ?? null;
}

/** Rendu texte borné d'un tableau (revalidation ciblée, contexte modèle). */
export function renderTableText(t: Pick<ExtractedTable, 'title' | 'columns' | 'cells' | 'rowCount' | 'pageStart' | 'pageEnd'>, maxRows = 60): string {
  const head = `Tableau${t.title ? ` « ${t.title} »` : ''}${t.pageStart ? ` — page ${t.pageStart}${t.pageEnd && t.pageEnd !== t.pageStart ? `-${t.pageEnd}` : ''}` : ''}`;
  const hdr = ['(ligne)', ...t.columns.map((c) => c.path.join(' > '))].join(' | ');
  const lines: string[] = [];
  for (let r = 0; r < Math.min(t.rowCount, maxRows); r += 1) {
    const rh = t.cells.find((c) => c.row === r)?.rowHeader ?? '';
    const vals = t.columns.map((_, col) => {
      const c = cellAt(t, r, col);
      return c?.value ?? '(vide)';
    });
    lines.push([rh || `L${r + 1}`, ...vals].join(' | '));
  }
  return [head, hdr, ...lines].join('\n');
}

// ── Lecture T2 : intersection ligne / colonne ──────────────────────────────

export interface TableCellRow {
  tableId: number;
  fileId: number;
  documentTitle: string | null;
  tableTitle: string | null;
  tableUncertain: boolean;
  row: number;
  column: number;
  rowHeader: string | null;
  columnHeader: string | null;
  columnPath: string[];
  value: string | null;
  normalized: string | null;
  page: number | null;
  confidence: string;
}

export interface TableAnswer {
  cell: TableCellRow;
  /** Libellé de la ligne (en-tête, ou première cellule). */
  rowLabel: string;
  /** Autres cellules de la même ligne, pour situer la valeur. */
  rowContext: Array<{ header: string; value: string }>;
  score: number;
}

const words = (s: string) => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
const hits = (text: string | null | undefined, terms: string[]) => {
  if (!text) return 0;
  const w = new Set(words(text));
  return terms.filter((t) => w.has(t) || plain(text).includes(t)).length;
};

/**
 * Cherche la cellule à l'intersection d'une LIGNE et d'une COLONNE désignées
 * par la question (« kilométrage de la Clio au 3 septembre 2026 »).
 *
 * Exige les deux : un terme désignant la colonne (en-tête) ET un terme
 * désignant la ligne (en-tête de ligne ou autre cellule de la ligne — une
 * date, un nom). Plusieurs cellules aussi bien classées portant des valeurs
 * différentes → aucune réponse (`ambiguous`) : on ne tranche pas au hasard.
 */
export function findTableIntersection(
  rows: TableCellRow[],
  rawTerms: string[],
  isoDates: string[] = [],
): { answer: TableAnswer | null; ambiguous: TableAnswer[]; empty?: TableAnswer } {
  const terms = [...new Set(rawTerms.flatMap(words))];
  if (terms.length < 2 && isoDates.length === 0) return { answer: null, ambiguous: [] };

  const byRow = new Map<string, TableCellRow[]>();
  for (const c of rows) {
    const k = `${c.tableId}:${c.row}`;
    if (!byRow.has(k)) byRow.set(k, []);
    byRow.get(k)!.push(c);
  }

  const scored: TableAnswer[] = [];
  for (const cells of byRow.values()) {
    cells.sort((a, b) => a.column - b.column);
    for (const cell of cells) {
      // Les cellules vides concourent aussi : si la cellule désignée est vide,
      // la réponse est « vide », jamais la valeur d'une ligne voisine.
      const colScore = hits(cell.columnHeader, terms) + hits(cell.columnPath.join(' '), terms);
      if (colScore === 0) continue;
      const others = cells.filter((o) => o.column !== cell.column && o.value !== null);
      const rowTerms = terms.filter((t) => !words(cell.columnHeader ?? '').includes(t));
      let rowScore = hits(cell.rowHeader, rowTerms) + others.reduce((n, o) => n + hits(o.value, rowTerms), 0);
      for (const d of isoDates) {
        if (others.some((o) => o.normalized === d || (o.value && toIso(o.value) === d))) rowScore += 2;
      }
      if (rowScore === 0) continue;
      const label = cell.rowHeader ?? others[0]?.value ?? `ligne ${cell.row + 1}`;
      scored.push({
        cell, rowLabel: label, score: colScore * 2 + rowScore,
        rowContext: others.map((o) => ({ header: o.columnHeader ?? `colonne ${o.column + 1}`, value: o.value! })),
      });
    }
  }
  if (scored.length === 0) return { answer: null, ambiguous: [] };
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score === scored[0].score);
  if (top.length === 1 && top[0].cell.value === null) return { answer: null, ambiguous: [], empty: top[0] };
  if (top.some((s) => s.cell.value === null)) return { answer: null, ambiguous: top.slice(0, 4) };
  const values = new Set(top.map((s) => plain(s.cell.value ?? '')));
  if (values.size > 1) return { answer: null, ambiguous: top.slice(0, 4) };
  return { answer: top[0], ambiguous: [] };
}

/** « 03/09/2026 » → « 2026-09-03 » (sinon null). */
function toIso(v: string): string | null {
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
