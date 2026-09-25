/**
 * T1 — tableaux : lignes, colonnes, cellules vides, en-têtes multiples,
 * fusions et continuité multi-pages ; lecture T2 à l'intersection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ExtractSourceOutput } from '../../source-analysis/schemas';
import { normalizeTables, normalizeTablesWithMap, cellAt, cellContext, renderTableText, findTableIntersection, type TableCellRow } from '../document-tables';
import { buildKnowledgeFromSourceAnalysis } from '../document-knowledge';
import { describeLocation, tableContextOf } from '@/services/verebona-assistant/core/revalidation.service';
import type { SourceAnalysisResult } from '../../source-analysis/types';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const T = (t: unknown) => ExtractSourceOutput.parse({ tables: [t] }).tables[0];
const at = (t: ReturnType<typeof normalizeTables>[number], r: number, c: number) => cellAt(t, r, c)?.value ?? null;

const vehicules = T({
  title: 'Historique des véhicules', pageStart: 2,
  columns: [{ header: 'Véhicule' }, { header: 'Kilométrage' }, { header: 'Date' }],
  rows: [
    { cells: [{ column: 0, value: 'Tesla' }, { column: 1, value: '42 000 km' }, { column: 2, value: '01/09/2026', normalized: '2026-09-01' }] },
    { cells: [{ column: 0, value: 'Clio' }, { column: 1, value: '78 000 km' }, { column: 2, value: '03/09/2026', normalized: '2026-09-03' }] },
  ],
});

describe('grille explicite', () => {
  it('ordre et associations conservés', () => {
    const [t] = normalizeTables([vehicules]);
    expect([t.rowCount, t.columnCount]).toEqual([2, 3]);
    expect(at(t, 1, 0)).toBe('Clio');
    expect(at(t, 1, 1)).toBe('78 000 km');
    expect(at(t, 1, 2)).toBe('03/09/2026');
    expect(cellAt(t, 1, 1)!.columnHeader).toBe('Kilométrage');
  });

  it('cellule vide : aucune valeur décalée', () => {
    // Bien | 2025 | 2026 ; Maison A : 500 € en 2026 seulement.
    const [t] = normalizeTables([T({
      columns: [{ header: 'Bien' }, { header: '2025' }, { header: '2026' }],
      rows: [
        { header: 'Maison A', cells: [{ column: 0, value: 'Maison A' }, { column: 1, value: null }, { column: 2, value: '500 €' }] },
        { header: 'Maison B', cells: [{ column: 0, value: 'Maison B' }, { column: 2, value: '710 €' }, { column: 1, value: '650 €' }] },
      ],
    })]);
    expect(at(t, 0, 1)).toBeNull();
    expect(cellAt(t, 0, 1)).not.toBeNull(); // la cellule existe, vide
    expect(at(t, 0, 2)).toBe('500 €');
    expect(at(t, 1, 1)).toBe('650 €');
    expect(cellAt(t, 1, 1)!.columnHeader).toBe('2025');
    expect(at(t, 1, 2)).toBe('710 €');
  });

  it('cellule absente de la sortie : rendue vide, jamais comblée par la suivante', () => {
    const [t] = normalizeTables([T({ columns: [{ header: 'A' }, { header: 'B' }, { header: 'C' }], rows: [{ cells: [{ column: 0, value: 'x' }, { column: 2, value: 'z' }] }] })]);
    expect([at(t, 0, 0), at(t, 0, 1), at(t, 0, 2)]).toEqual(['x', null, 'z']);
  });

  it('en-têtes à plusieurs niveaux : chaque valeur garde ses axes', () => {
    const [t] = normalizeTables([T({
      columns: [{ header: 'Bien' }, { header: '2025', path: ['Assurance', '2025'] }, { header: '2026', path: ['Assurance', '2026'] }],
      rows: [{ header: 'Maison A', cells: [{ column: 0, value: 'Maison A' }, { column: 1, value: '650 €' }, { column: 2, value: '710 €' }] }],
    })]);
    expect(cellAt(t, 0, 2)!.columnPath).toEqual(['Assurance', '2026']);
    expect(cellContext(t, 0, 2)).toMatchObject({ rowHeader: 'Maison A', columnHeader: '2026', columnPath: ['Assurance', '2026'], rawValue: '710 €' });
  });

  it('cellule fusionnée : couvre ses voisines sans créer de « vide »', () => {
    const [t] = normalizeTables([T({
      columns: [{ header: 'Lot' }, { header: 'Montant' }],
      rows: [
        { cells: [{ column: 0, value: 'Toiture', rowspan: 2 }, { column: 1, value: '1 000 €' }] },
        { cells: [{ column: 1, value: '200 €' }] },
      ],
    })]);
    expect(at(t, 1, 0)).toBe('Toiture');
    expect(t.cells.filter((c) => c.value === null)).toHaveLength(0);
    expect(t.uncertain).toBe(false);
  });

  it('multi-pages : un seul tableau, en-tête répété ignoré, références recalées', () => {
    const suite = T({ ...vehicules, pageStart: 3, title: undefined, rows: [
      { cells: [{ column: 0, value: 'Véhicule' }, { column: 1, value: 'Kilométrage' }, { column: 2, value: 'Date' }] },
      { cells: [{ column: 0, value: 'Zoé' }, { column: 1, value: '12 000 km' }, { column: 2, value: '05/09/2026' }] },
    ] });
    const { tables, locate } = normalizeTablesWithMap([vehicules, suite]);
    expect(tables).toHaveLength(1);
    expect([tables[0].pageStart, tables[0].pageEnd, tables[0].rowCount]).toEqual([2, 3, 3]);
    expect(at(tables[0], 2, 0)).toBe('Zoé');
    expect(locate(1, 1)).toEqual({ index: 0, row: 2 });
    expect(cellAt(tables[0], 2, 0)!.page).toBe(3);
  });

  it('structure ambiguë : marquée incertaine, confiance abaissée, rien reconstruit', () => {
    const [t] = normalizeTables([T({
      columns: [{ header: 'A' }, { header: 'B' }],
      rows: [{ cells: [{ column: 0, value: '1' }, { column: 0, value: '2' }, { column: 5, value: '3' }] }],
    })]);
    expect(t.uncertain).toBe(true);
    expect(t.issues.length).toBeGreaterThan(0);
    expect(at(t, 0, 0)).toBe('1');
    expect(t.cells.every((c) => c.confidence !== 'certain')).toBe(true);
  });

  it('rendu texte pour la revalidation ciblée', () => {
    const txt = renderTableText(normalizeTables([vehicules])[0]);
    expect(txt).toMatch(/Tableau « Historique des véhicules » — page 2/);
    expect(txt).toMatch(/Clio \| 78 000 km \| 03\/09\/2026/);
  });
});

describe('faits issus d’une cellule', () => {
  it('la preuve garde le contexte tabulaire', () => {
    const tables = normalizeTables([vehicules]);
    const k = buildKnowledgeFromSourceAnalysis({
      document: { tables }, warnings: [], assetCandidates: [], roomCandidates: [], equipmentCandidates: [], agendaCandidates: [],
      extractedFields: [{ fieldKey: 'clio.kilometrage', value: 78000, unit: 'km', confidence: 'certain', excerpt: '78 000 km', provenance: 'TEXT_EXTRACTION', table: { index: 0, row: 1, column: 1 } }],
      sourceGroup: { sourceIds: [1] }, operationTrace: { usedFallback: false, models: ['m'], traceIds: [] },
    } as unknown as SourceAnalysisResult, { accountId: 1, fileId: 9, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file' });
    expect(k.tables).toHaveLength(1);
    expect(k.facts[0].location.table).toMatchObject({ title: 'Historique des véhicules', rowHeader: 'Clio', columnHeader: 'Kilométrage', page: 2 });
    expect(k.facts[0].label).toBe('Clio — Kilométrage');
    expect(describeLocation(null, tableContextOf(k.facts[0] as never))).toBe('page 2, tableau « Historique des véhicules », ligne « Clio », colonne « Kilométrage »');
  });
});

describe('T2 : intersection ligne / colonne', () => {
  const rows: TableCellRow[] = normalizeTables([vehicules])[0].cells.map((c) => ({
    tableId: 1, fileId: 9, documentTitle: 'Relevés', tableTitle: 'Historique des véhicules', tableUncertain: false,
    row: c.row, column: c.column, rowHeader: c.rowHeader, columnHeader: c.columnHeader, columnPath: c.columnPath,
    value: c.value, normalized: c.normalized, page: c.page, confidence: c.confidence,
  }));
  it('« kilométrage de la Clio au 3 septembre 2026 » → 78 000 km', () => {
    const r = findTableIntersection(rows, ['kilometrage', 'clio'], ['2026-09-03']);
    expect(r.answer?.cell.value).toBe('78 000 km');
    expect(r.answer?.rowLabel).toBe('Clio');
  });
  it('cellule désignée vide : « vide », jamais la valeur d’une ligne voisine', () => {
    const t = normalizeTables([T({
      title: 'Primes', columns: [{ header: 'Lot' }, { header: '2025' }, { header: '2026' }],
      rows: [
        { header: 'Lot Nord', cells: [{ column: 0, value: 'Lot Nord' }, { column: 1, value: null }, { column: 2, value: '500 €' }] },
        { header: 'Lot Sud', cells: [{ column: 0, value: 'Lot Sud' }, { column: 1, value: '650 €' }, { column: 2, value: '710 €' }] },
      ],
    })])[0];
    const cells: TableCellRow[] = t.cells.map((c) => ({ tableId: 2, fileId: 9, documentTitle: 'D', tableTitle: 'Primes', tableUncertain: false, row: c.row, column: c.column, rowHeader: c.rowHeader, columnHeader: c.columnHeader, columnPath: c.columnPath, value: c.value, normalized: c.normalized, page: c.page, confidence: c.confidence }));
    const r = findTableIntersection(cells, ['2025', 'lot', 'nord']);
    expect(r.answer).toBeNull();
    expect(r.empty?.rowLabel).toBe('Lot Nord');
    expect(findTableIntersection(cells, ['2025', 'lot', 'sud']).answer?.cell.value).toBe('650 €');
  });

  it('ligne non désignée : aucune réponse arbitraire', () => {
    expect(findTableIntersection(rows, ['kilometrage']).answer).toBeNull();
  });
  it('deux lignes aussi pertinentes aux valeurs différentes : ambigu', () => {
    const r = findTableIntersection(rows, ['kilometrage', '2026']);
    expect(r.answer).toBeNull();
    expect(r.ambiguous.map((a) => a.cell.value).sort()).toEqual(['42 000 km', '78 000 km']);
  });
});

describe('garde-fous', () => {
  it('prompt v4 : structure explicite, cellules vides, fusion, multi-pages, doute', () => {
    const p = src('src/services/ai/prompts/source-analysis/extract_source_v4.txt');
    for (const r of [/R2ter — TABLEAUX/, /`value: null` — ne l'omets pas/, /`colspan` \/ `rowspan`/, /UN seul tableau \(`pageStart`, `pageEnd`\)/, /ne reconstruis AUCUNE association/]) expect(p).toMatch(r);
    const i = p.indexOf('{\n  "title"');
    expect(() => ExtractSourceOutput.parse(JSON.parse(p.slice(i, p.lastIndexOf('}') + 1)))).not.toThrow();
  });
  it('base : cellules à position unique, vide explicite', () => {
    const m = src('src/db/migrations/0162_document_tables.sql');
    expect(m).toMatch(/UNIQUE \(table_id, row_index, column_index\)/);
    expect(m).toMatch(/CHECK \(is_empty = \(value_text IS NULL\)\)/);
  });
});
