/**
 * Lot 81C — export INTÉGRAL d'un dossier « Données du compte » en FLUX
 * (JSON, CSV, TXT ; dossier complet ou une section). Serveur uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EXHAUSTIF, PROGRESSIF, VÉRIFIABLE
 *
 *   · le dossier est planifié DANS la session de lecture cohérente
 *     (`planEntityDossier`) ; chaque section tabulaire ou de relations est
 *     ensuite lue INTÉGRALEMENT par curseur, lot par lot, et écrite au fur et
 *     à mesure (mémoire bornée à un lot, quel que soit le volume) — jamais
 *     depuis les lignes chargées dans le tiroir ;
 *   · par section : attendu (`count(*)` dans le même instantané), exporté,
 *     lots, statut COMPLETE / PARTIAL / FAILED, erreur, horodatage ;
 *   · une section en erreur est annulée seule (point de reprise) et
 *     signalée ; les sections indépendantes continuent ; le statut global
 *     n'est COMPLETE que si toutes le sont ;
 *   · le manifeste est écrit en FIN de flux (dernière clé JSON, dernières
 *     lignes CSV / TXT) : un fichier interrompu n'a pas de marque de
 *     statut et n'est jamais présenté comme complet (`exportStatusFromTail`) ;
 *   · masquage identique au tiroir (`maskSectionRow`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import {
  CSV_BOM, CSV_COLUMNS, EXPORT_MANIFEST_SCHEMA, FIELDS_CSV_COLUMNS, RELATIONS_CSV_COLUMNS, SNAPSHOT_VERIFICATION, TABS,
  csvFooterLines, csvLine, csvMetaLines, csvRelationLine, csvRowLines, csvSectionHeadLines, csvWideHeader, csvWideRow, fieldsCsvRow,
  globalStatus, relationLine, relationsCsvRow, sectionStatus, textFooter, textHeader, textRowLine, textSectionHead, textStatLine, textTabHeader, textTableHead,
  type DossierRelation, type DossierSection, type EntityDossier, type ExportFormat, type ExportManifest, type SectionExportStat,
} from './model';
import { maskSectionRow, toRelation, type DossierPlan, type SectionSource } from './dossier';
import { EXPORT_BATCH_ROWS, countRows, jsonBatches, type ReadSession } from './session';

type Row = Record<string, unknown>;

/** Destination d'un flux texte (réponse HTTP, entrée d'archive, mémoire). `write` respecte la contre-pression. */
export interface TextSink { write(chunk: string): Promise<void> }

/** Échec d'écriture (client parti, archive en erreur) : fatal, jamais rattrapé comme une erreur de section. */
export class SinkError extends Error {
  constructor(public cause: unknown) { super(`écriture impossible : ${(cause as Error)?.message ?? String(cause)}`); this.name = 'SinkError'; }
}

/** Regroupe les petites écritures (64 Kio) ; `flush` en fin de flux. */
export function bufferedSink(target: TextSink, size = 64 * 1024): TextSink & { flush(): Promise<void> } {
  let buf: string[] = [];
  let len = 0;
  const flush = async () => {
    if (!len) return;
    const chunk = buf.join('');
    buf = [];
    len = 0;
    try { await target.write(chunk); } catch (e) { throw e instanceof SinkError ? e : new SinkError(e); }
  };
  return {
    async write(c: string) {
      buf.push(c);
      len += c.length;
      if (len >= size) await flush();
    },
    flush,
  };
}

/** Erreur technique exploitable : code PostgreSQL et message. */
export function describeError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  const msg = (e as Error)?.message ?? String(e);
  return `${code ? `${code} — ` : ''}${msg}`.slice(0, 500);
}

interface Streamed { expected: number | null; exported: number; batches: number; error: string | null }

/**
 * Lit INTÉGRALEMENT une source (curseur, lots de `EXPORT_BATCH_ROWS`) dans
 * un point de reprise : attendu lu dans le même instantané, lignes masquées
 * (ou relations) passées à `onBatch`. Une erreur de lecture est rendue
 * (section FAILED / PARTIAL) ; une erreur d'écriture ou une écriture SQL
 * tentée est relancée (fatale).
 */
export async function streamSource(s: ReadSession, src: SectionSource, onBatch: (rows: Row[]) => Promise<void>, batch = EXPORT_BATCH_ROWS): Promise<Streamed> {
  const out: Streamed = { expected: null, exported: 0, batches: 0, error: null };
  try {
    if (src.kind === 'static') {
      out.expected = src.rows.length;
      for (let i = 0; i < src.rows.length; i += batch) {
        const lot = src.rows.slice(i, i + batch);
        await onBatch(lot);
        out.exported += lot.length;
        out.batches++;
      }
      return out;
    }
    const map = src.kind === 'relations' ? (r: Row) => toRelation(r) as unknown as Row : maskSectionRow;
    await s.savepoint(async () => {
      out.expected = await countRows(s.q, src.sql, src.params);
      for await (const lot of jsonBatches(s, src.sql, src.params, batch)) {
        await onBatch(lot.map(map));
        out.exported += lot.length;
        out.batches++;
      }
    });
  } catch (e) {
    if (e instanceof SinkError || (e as { code?: string })?.code === '25006') throw e;
    console.error('[admin/account-data] export :', (e as Error)?.message ?? e);
    out.error = describeError(e);
  }
  return out;
}

const indent = (text: string, pad: string) => text.split('\n').map((l) => pad + l).join('\n');

/** En-tête JSON d'une section (sans ses lignes), ouvert pour y ajouter des clés. */
function sectionHeadJson(sec: DossierSection, mask: (v: unknown) => unknown): string {
  const { table: _t, relations: _r, window: _w, ...head } = sec;
  void _t; void _r; void _w;
  const j = JSON.stringify(mask(head), null, 2);
  return indent(j.slice(0, -2), '    '); // sans « \n} » final
}

export interface ExportOptions {
  generationId?: string;
  /** Export d'une seule section (reprise ciblée, CSV de section). */
  sectionId?: string | null;
  now?: () => Date;
  /** Taille de lot (tests). */
  batchRows?: number;
  /**
   * Masquage SUPPLÉMENTAIRE (diagnostics techniques : `maskForExport`)
   * appliqué à chaque valeur avant sérialisation, et sérialisation d'une
   * ligne (contrôle de sortie). Par défaut : masquage « Données du compte » seul.
   */
  mask?: (v: unknown) => unknown;
  stringifyRow?: (row: unknown) => string;
}

/**
 * Écrit l'export intégral d'un dossier planifié dans `sink` et rend son
 * manifeste. Les sections sont lues dans l'instantané de `s`.
 */
export async function writeDossierExport(s: ReadSession, plan: DossierPlan, format: ExportFormat, target: TextSink, opts: ExportOptions = {}): Promise<ExportManifest> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const d = plan.dossier;
  d.mode = 'export';
  const sections = opts.sectionId ? d.sections.filter((x) => x.id === opts.sectionId) : d.sections;
  const sink = bufferedSink(target);
  const stats: SectionExportStat[] = [];
  const batchRows = opts.batchRows ?? EXPORT_BATCH_ROWS;
  const M = opts.mask ?? ((v: unknown) => v);
  const J = opts.stringifyRow ?? ((v: unknown) => JSON.stringify(M(v)));

  const stat = (sec: DossierSection, r: Streamed | null): SectionExportStat => {
    const src = plan.sources.get(sec.id);
    const table = src ? (src.kind === 'relations' ? 'relations' : src.table) : null;
    const st: SectionExportStat = r
      ? { id: sec.id, title: sec.title, table, expected: r.expected, exported: r.exported, batches: r.batches, status: sectionStatus(r.expected, r.exported, r.error), error: r.error, finishedAt: now().toISOString() }
      : { id: sec.id, title: sec.title, table, expected: null, exported: sec.fields?.length ?? 0, batches: 0, status: sec.error ? 'FAILED' : 'COMPLETE', error: sec.error ?? null, finishedAt: now().toISOString() };
    stats.push(st);
    return st;
  };

  const finish = (): ExportManifest => {
    const counted = stats.filter((x) => x.expected !== null);
    const status = globalStatus(stats);
    const m: ExportManifest = {
      schema: EXPORT_MANIFEST_SCHEMA, generationId: opts.generationId ?? randomUUID(), kind: 'ACCOUNT_DATA', format,
      perimeter: { accountId: d.accountId, entityType: d.entity.type, entityId: d.entity.id, section: opts.sectionId ?? null },
      startedAt, finishedAt: now().toISOString(),
      snapshot: { isolation: s.info.isolation, at: s.info.at, snapshot: s.info.snapshot, verification: SNAPSHOT_VERIFICATION },
      batchRows,
      sections: stats,
      totals: { expected: counted.reduce((a, x) => a + (x.expected ?? 0), 0), exported: counted.reduce((a, x) => a + x.exported, 0), batches: stats.reduce((a, x) => a + x.batches, 0) },
      status,
      error: status === 'COMPLETE' ? null : stats.filter((x) => x.status !== 'COMPLETE').map((x) => `${x.id} : ${x.status}${x.error ? ` (${x.error})` : ''}`).join(' ; '),
    };
    for (const x of stats) {
      if (x.status !== 'COMPLETE' && !x.error) d.warnings.push(`Section « ${x.title} » : ${x.exported} élément(s) exporté(s) sur ${x.expected ?? '?'} attendu(s) — ${x.status}.`);
      else if (x.status !== 'COMPLETE' && plan.sources.has(x.id)) d.warnings.push(`Section « ${x.title} » : extraction ${x.status} — ${x.error}.`);
    }
    d.complete = status === 'COMPLETE';
    d.export = m;
    return m;
  };

  /** Lit une section (si source) en appelant `row` / `relation` pour chaque élément. */
  const read = async (sec: DossierSection, onRows: (rows: Row[], firstRank: number) => Promise<void>): Promise<Streamed | null> => {
    const src = plan.sources.get(sec.id);
    if (!src || sec.error) return null;
    let rank = 0;
    return streamSource(s, src, async (rows) => { await onRows(rows, rank + 1); rank += rows.length; }, batchRows);
  };

  if (format === 'json') {
    const { sections: _s, operationDetail, warnings: _w, complete: _c, export: _e, ...head } = d;
    void _s; void _w; void _c; void _e;
    const h = JSON.stringify(M(head), null, 2);
    await sink.write(`${h.slice(0, -2)},\n  "sections": [`);
    let first = true;
    for (const sec of sections) {
      await sink.write(`${first ? '\n' : ',\n'}${sectionHeadJson(sec, M)}`);
      first = false;
      const src = plan.sources.get(sec.id);
      let r: Streamed | null = null;
      if (src && !sec.error) {
        let n = 0;
        let columns: string[] = [];
        const key = src.kind === 'relations' ? 'relations' : 'table';
        await sink.write(key === 'table' ? `,\n      "table": {\n        "table": ${JSON.stringify(src.kind === 'relations' ? '' : src.table)},\n        "rows": [` : `,\n      "relations": [`);
        r = await read(sec, async (rows) => {
          if (!columns.length && rows.length && key === 'table') columns = Object.keys(rows[0]);
          let chunk = '';
          for (const row of rows) { chunk += `${n++ ? ',' : ''}\n          ${J(row)}`; }
          await sink.write(chunk);
        });
        const st = stat(sec, r);
        if (key === 'table') {
          await sink.write(`${n ? '\n        ' : ''}],\n        "columns": ${JSON.stringify(columns)},\n        "total": ${JSON.stringify(st.expected)},\n        "complete": ${st.status === 'COMPLETE'}\n      }`);
        } else {
          await sink.write(`${n ? '\n      ' : ''}]`);
        }
        await sink.write(`,\n      "window": ${JSON.stringify({ total: st.expected, offset: 0, size: null })},\n      "extraction": ${JSON.stringify(st)}`);
      } else {
        await sink.write(`,\n      "extraction": ${JSON.stringify(stat(sec, null))}`);
      }
      await sink.write('\n    }');
    }
    const m = finish();
    await sink.write(`${first ? '' : '\n  '}],\n`);
    if (operationDetail !== undefined) await sink.write(`  "operationDetail": ${indent(JSON.stringify(M(operationDetail), null, 2), '  ').trimStart()},\n`);
    await sink.write(`  "warnings": ${JSON.stringify(M(d.warnings))},\n  "complete": ${d.complete},\n  "export": ${indent(JSON.stringify(M(m), null, 2), '  ').trimStart()},\n  "exportStatus": "${m.status}"\n}\n`);
  } else if (format === 'txt') {
    await sink.write(`${textHeader(d).join('\n')}\nComplétude : voir « Statut de l’export » en fin de fichier (écrit une fois l’extraction terminée).\n`);
    for (const w of d.warnings) await sink.write(`AVERTISSEMENT : ${w}\n`);
    for (const tab of TABS) {
      const inTab = sections.filter((x) => x.tab === tab);
      if (!inTab.length) continue;
      await sink.write(`${textTabHeader(tab).join('\n')}\n`);
      for (const sec of inTab) {
        await sink.write(`${textSectionHead(sec).join('\n')}\n`);
        const src = plan.sources.get(sec.id);
        let columns: string[] = [];
        if (src && src.kind !== 'relations' && !sec.error) await sink.write(`${textTableHead(src.table, null)}\n`);
        let count = 0;
        const r = await read(sec, async (rows, firstRank) => {
          if (!columns.length && rows.length) columns = Object.keys(rows[0]);
          let chunk = '';
          rows.forEach((row, i) => {
            chunk += `${src?.kind === 'relations' ? relationLine(row as unknown as DossierRelation) : textRowLine(firstRank + i, columns, row)}\n`;
          });
          count += rows.length;
          await sink.write(chunk);
        });
        if (src?.kind === 'relations' && r && !count && !r.error) await sink.write('(aucune relation)\n');
        await sink.write(`${textStatLine(stat(sec, r))}\n`);
      }
    }
    const m = finish();
    await sink.write(`${textFooter(m).join('\n')}\n`);
  } else if (opts.sectionId) {
    // CSV « large » d'une section : colonnes de la table conservées.
    const sec = sections[0];
    await sink.write(CSV_BOM);
    const src = sec ? plan.sources.get(sec.id) : undefined;
    if (sec && !src) {
      if (sec.fields) await sink.write([csvLine(FIELDS_CSV_COLUMNS), ...sec.fields.map(fieldsCsvRow)].join('\r\n') + '\r\n');
      stat(sec, null);
    } else if (sec && src) {
      let header = false;
      const r = await read(sec, async (rows) => {
        let chunk = '';
        if (!header) {
          header = true;
          chunk += `${src.kind === 'relations' ? csvLine(RELATIONS_CSV_COLUMNS) : csvWideHeader(rows.length ? Object.keys(rows[0]) : [])}\r\n`;
        }
        for (const row of rows) chunk += `${src.kind === 'relations' ? relationsCsvRow(row as unknown as DossierRelation) : csvWideRow(Object.keys(row), row)}\r\n`;
        await sink.write(chunk);
      });
      if (!header) await sink.write(`${src.kind === 'relations' ? csvLine(RELATIONS_CSV_COLUMNS) : ''}\r\n`);
      stat(sec, r);
    }
    finish();
  } else {
    await sink.write(`${CSV_BOM}${[csvLine([...CSV_COLUMNS]), ...csvMetaLines(d)].join('\r\n')}\r\n`);
    for (const sec of sections) {
      const head = csvSectionHeadLines(sec);
      if (head.length) await sink.write(`${head.join('\r\n')}\r\n`);
      const src = plan.sources.get(sec.id);
      let columns: string[] = [];
      const r = await read(sec, async (rows, firstRank) => {
        if (!columns.length && rows.length) columns = Object.keys(rows[0]);
        const lines: string[] = [];
        rows.forEach((row, i) => {
          if (src?.kind === 'relations') lines.push(csvRelationLine(sec, row as unknown as DossierRelation));
          else lines.push(...csvRowLines(sec, src?.kind === 'static' || src?.kind === 'table' ? src.table : '', columns, row, firstRank + i));
        });
        if (lines.length) await sink.write(`${lines.join('\r\n')}\r\n`);
      });
      stat(sec, r);
    }
    const m = finish();
    await sink.write(`${csvFooterLines(m).join('\r\n')}\r\n`);
  }
  await sink.flush();
  return d.export!;
}

/** Export intégral en MÉMOIRE (tests, petits volumes) : texte et manifeste. */
export async function exportToString(s: ReadSession, plan: DossierPlan, format: ExportFormat, opts: ExportOptions = {}): Promise<{ text: string; manifest: ExportManifest; dossier: EntityDossier }> {
  const parts: string[] = [];
  const manifest = await writeDossierExport(s, plan, format, { write: async (c) => { parts.push(c); } }, opts);
  return { text: parts.join(''), manifest, dossier: plan.dossier };
}
