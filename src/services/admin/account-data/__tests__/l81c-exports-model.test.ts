/**
 * Lot 81C — modules purs des exports exhaustifs :
 *   · L81C-U03 statut d'export lu en fin de fichier (JSON, TXT, CSV) ; un
 *     fichier tronqué n'a pas de marque (jamais « complet ») ;
 *   · L81C-U04 statuts de section et global (COMPLETE seulement si exporté =
 *     attendu et aucune erreur) ;
 *   · L81C-U05 paramètres nommés `{{x}}` (composition des requêtes) ;
 *   · L81C-U06 pagination technique (taille bornée, jamais une borne de données) ;
 *   · L81C-U07 inventaire : aucun plafond fonctionnel restant dans les
 *     services d'extraction (SECTION_LIMIT, DIAG_LIMITS, LIMIT SQL non
 *     sémantiques).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COPY_MAX_ROWS, DOSSIER_PAGE_MAX, DOSSIER_PAGE_SIZE, EXPORT_MANIFEST_SCHEMA, csvFooterLines, exportStatusFromTail, globalStatus, sectionStatus, textFooter,
  type ExportManifest,
} from '../model';
import { named } from '../session';

const manifest = (status: ExportManifest['status']): ExportManifest => ({
  schema: EXPORT_MANIFEST_SCHEMA, generationId: 'g-1', kind: 'ACCOUNT_DATA', format: 'txt', perimeter: { accountId: 1, entityType: 'asset', entityId: 2, section: null },
  startedAt: '2026-10-23T08:00:00.000Z', finishedAt: '2026-10-23T08:00:01.000Z',
  snapshot: { isolation: 'REPEATABLE READ, READ ONLY', at: '2026-10-23T08:00:00.000000Z', snapshot: '10:12:', verification: 'v' }, batchRows: 500,
  sections: [{ id: 'reco-decisions', title: 'Décisions', table: 'reconciliation_decisions', expected: 17938, exported: status === 'COMPLETE' ? 17938 : 1000, batches: 36, status, error: status === 'COMPLETE' ? null : '08006 — coupure', finishedAt: '2026-10-23T08:00:01.000Z' }],
  totals: { expected: 17938, exported: status === 'COMPLETE' ? 17938 : 1000, batches: 36 }, status, error: null,
});

describe('L81C-U03 statut en fin de fichier', () => {
  it('JSON : dernière clé `exportStatus` ; tronqué → null', () => {
    const j = '{\n  "sections": [],\n  "export": {},\n  "exportStatus": "COMPLETE"\n}\n';
    expect(exportStatusFromTail('json', j)).toBe('COMPLETE');
    expect(exportStatusFromTail('json', j.replace('COMPLETE', 'PARTIAL'))).toBe('PARTIAL');
    expect(exportStatusFromTail('json', j.slice(0, -10))).toBeNull();
    expect(exportStatusFromTail('json', '{"sections": [{"exportStatus": "COMPLETE"}, {"id": 1')).toBeNull();
  });
  it('TXT / CSV : dernière ligne de pied', () => {
    const txt = `${textFooter(manifest('PARTIAL')).join('\n')}\n`;
    expect(txt).toContain('reconciliation_decisions');
    expect(exportStatusFromTail('txt', txt)).toBe('PARTIAL');
    expect(exportStatusFromTail('txt', txt.slice(0, txt.lastIndexOf('Statut')))).toBeNull();
    const csv = `${csvFooterLines(manifest('COMPLETE')).join('\r\n')}\r\n`;
    expect(exportStatusFromTail('csv', csv)).toBe('COMPLETE');
    expect(exportStatusFromTail('csv', csv.slice(0, -30))).toBeNull();
  });
});

describe('L81C-U04 statuts', () => {
  it('section : COMPLETE seulement si exporté = attendu et aucune erreur', () => {
    expect(sectionStatus(17938, 17938, null)).toBe('COMPLETE');
    expect(sectionStatus(17938, 2000, null)).toBe('PARTIAL');
    expect(sectionStatus(17938, 1000, '08006')).toBe('PARTIAL');
    expect(sectionStatus(17938, 0, '57014')).toBe('FAILED');
    expect(sectionStatus(null, 12, null)).toBe('COMPLETE');
  });
  it('global : COMPLETE / PARTIAL / FAILED ; erreur fatale → FAILED', () => {
    expect(globalStatus([{ status: 'COMPLETE' }, { status: 'COMPLETE' }])).toBe('COMPLETE');
    expect(globalStatus([{ status: 'COMPLETE' }, { status: 'FAILED' }])).toBe('PARTIAL');
    expect(globalStatus([{ status: 'FAILED' }, { status: 'PARTIAL' }])).toBe('FAILED');
    expect(globalStatus([{ status: 'COMPLETE' }], true)).toBe('FAILED');
  });
});

describe('L81C-U05 paramètres nommés', () => {
  it('numérotés dans l’ordre d’apparition, seuls les utilisés transmis, réutilisables', () => {
    const r = named('SELECT 1 WHERE a = ANY({{ids}}::int[]) AND b >= {{start}} AND c = ANY({{ids}}::int[])', { ids: [1, 2], start: 'x', unused: 3 });
    expect(r).toEqual({ sql: 'SELECT 1 WHERE a = ANY($1::int[]) AND b >= $2 AND c = ANY($1::int[])', params: [[1, 2], 'x'] });
    expect(() => named('{{inconnu}}', {})).toThrow(/inconnu/);
  });
});

describe('L81C-U06 pagination technique', () => {
  it('page de 50 lignes, au plus 200 ; seuil de copie (presse-papiers) distinct de toute extraction', () => {
    expect(DOSSIER_PAGE_SIZE).toBe(50);
    expect(DOSSIER_PAGE_MAX).toBe(200);
    expect(COPY_MAX_ROWS).toBe(20_000);
  });
});

describe('L81C-U07 inventaire des plafonds supprimés', () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  it('plus de SECTION_LIMIT, de borne de lot, de LIMIT fonctionnel dans « Données du compte »', () => {
    const d = code('src/services/admin/account-data/dossier.ts');
    expect(d).not.toMatch(/SECTION_LIMIT|DETAIL_LIMIT|ctx\.limit/);
    // Seuls LIMIT restants : sémantiques (`LIMIT 1` : le plus récent) et pagination de la consultation (`LIMIT ${page.size} OFFSET`).
    for (const m of d.match(/LIMIT\s+(\$\{[^}]+\}|\d+)/g) ?? []) expect(['LIMIT 1', 'LIMIT ${page.size}']).toContain(m);
  });
  it('plus de plafond fonctionnel dans le diagnostic (collect, trace)', () => {
    const c = code('src/services/admin/diagnostics-export/collect.ts');
    expect(c).not.toMatch(/DIAG_LIMITS\.(listRows|dossierSectionRows|equipmentDossiers|documentDossiers|tcoAssets|tcoTracedLines|reportEntries|reportsWithEntries|userAccounts|totalBytes|periodMaxDays)/);
    // Seules restrictions requalifiées : sorties modèle du diagnostic renforcé (accès aux sorties IA sensibles, signalées PARTIAL).
    for (const m of c.match(/\.slice\(0, DIAG_LIMITS\.\w+/g) ?? []) expect(m).toMatch(/modelOutput(Traces|Chars)$/);
    for (const m of c.match(/LIMIT\s+(\$\{[^}]+\}|\d+)/g) ?? []) expect(['LIMIT 1', 'LIMIT ${partRows}']).toContain(m);
    const t = code('src/services/admin/diagnostics-export/trace.ts');
    for (const m of t.match(/LIMIT\s+(\$\{[^}]+\}|\d+)/g) ?? []) expect(m).toBe('LIMIT 1');
    expect(t).not.toMatch(/\.slice\(0, \d+\)\]/);
  });
  it('détail d’Opération : borne d’AFFICHAGE seulement (listes intégrales exportées)', () => {
    const s = code('src/services/business-operations/diagnostics/service.ts');
    expect(s).toContain('OPERATION_DETAIL_LISTS[k].sql} LIMIT ${L}');
    expect(s).toContain('listTotals[k]');
    expect(code('src/services/admin/account-data/dossier.ts')).toContain('OPERATION_DETAIL_LISTS');
  });
});
