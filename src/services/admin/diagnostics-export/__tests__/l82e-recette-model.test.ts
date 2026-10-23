/**
 * Lot 82E — export complet de recette : règles PURES (périmètre, masquage
 * déterministe, découpage, documentation, téléchargement, suivi).
 */
import { describe, expect, it } from 'vitest';
import {
  RECETTE_DOMAINS, RECETTE_EXCLUDED, RECETTE_TABLES, classifyTables, isSafeRecettePath, recetteDataPath,
} from '../recette-catalog';
import { buildDictionary, dictionaryCsv, maskRecetteRow, orderClause, recetteLine, recetteReadme, type RecetteManifest } from '../recette';
import { isDownloadablePath, recetteDownloadables } from '../recette-download';
import { isInterrupted } from '@/services/admin/export-generations';

describe('L82E-EX-01 périmètre : chaque table classée, aucune omission silencieuse', () => {
  it('aucune table à la fois exportée et exclue ; chaque table exportée a un domaine connu', () => {
    for (const t of Object.keys(RECETTE_TABLES)) expect(RECETTE_EXCLUDED[t], t).toBeUndefined();
    for (const [t, c] of Object.entries(RECETTE_TABLES)) expect(RECETTE_DOMAINS[c.domain], t).toBeDefined();
  });

  it('domaines exigés par la décision C-Q5 présents', () => {
    const d = (t: string) => RECETTE_TABLES[t]?.domain;
    expect([d('accounts'), d('assets'), d('substructures'), d('equipments'), d('asset_files'), d('document_raw_extracts'), d('document_facts'),
      d('field_evidence'), d('business_operations'), d('business_operation_match_decisions'), d('asset_cost_line_decisions'), d('agenda_items'),
      d('to_process_actions'), d('document_asset_links')])
      .toEqual(['comptes', 'biens', 'pieces', 'equipements', 'documents', 'extraits-ia', 'extraits-ia', 'champs-preuves', 'operations', 'operations', 'tco',
        'agenda-timeline', 'a-traiter', 'documents']);
  });

  it('table inconnue : EXPORTÉE quand même (non classée, signalée) ; table du catalogue absente : signalée', () => {
    const c = classifyTables(['assets', 'job_locks', 'nouvelle_table']);
    expect(c.included.map((x) => [x.table, x.domain])).toEqual([['assets', 'biens'], ['nouvelle_table', 'non-classees']]);
    expect(c.excluded).toEqual([{ table: 'job_locks', motif: RECETTE_EXCLUDED.job_locks }]);
    expect(c.unclassified).toEqual(['nouvelle_table']);
    expect(c.missing).toContain('accounts');
  });

  it('chemins des parties et chemins de téléchargement sûrs', () => {
    expect(recetteDataPath('biens', 'assets', 3)).toBe('donnees/biens/assets.part-0003.ndjson.gz');
    expect(isSafeRecettePath('donnees/biens/assets.part-0003.ndjson.gz')).toBe(true);
    expect(isSafeRecettePath('../backups/x.json')).toBe(false);
    expect(isSafeRecettePath('/etc/passwd')).toBe(false);
    expect(isSafeRecettePath('donnees//x')).toBe(false);
  });
});

describe('L82E-EX-02 masquage déterministe, identifiants préservés', () => {
  const row = {
    id: 42, account_id: 7, asset_id: 9, email: 'jean@exemple.fr', password_hash: 'x', s3_key: 'u/1/f.pdf', original_filename: 'facture.pdf',
    full_text: 'Facture n° 12 — 499,00 €', title: 'Facture', created_at: '2026-10-23T10:00:00.123456+00:00', amount_cents: 49900, notes: null,
  };
  it('identifiants, montants, dates et NULL intacts ; secrets, fichier, e-mail masqués ; contenu brut = longueur + SHA-256', () => {
    const m = maskRecetteRow(row);
    expect(Object.keys(m)).toEqual(Object.keys(row));
    expect(m).toMatchObject({ id: 42, account_id: 7, asset_id: 9, title: 'Facture', created_at: row.created_at, amount_cents: 49900, notes: null });
    expect(m.email).toMatchObject({ $etat: 'masque', motif: 'e-mail' });
    expect(m.password_hash).toMatchObject({ $etat: 'masque' });
    expect(m.s3_key).toMatchObject({ $etat: 'masque', motif: 'clé de stockage' });
    expect(m.original_filename).toMatchObject({ $etat: 'masque', motif: 'nom du fichier original' });
    expect(m.full_text).toMatchObject({ $etat: 'masque', longueur: row.full_text.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('stable d’un export à l’autre (même entrée → même sortie) ; un contenu modifié change l’empreinte', () => {
    expect(recetteLine(maskRecetteRow(row))).toBe(recetteLine(maskRecetteRow({ ...row })));
    const a = maskRecetteRow(row).full_text as { sha256: string };
    const b = maskRecetteRow({ ...row, full_text: `${row.full_text}.` }).full_text as { sha256: string };
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('contenus sensibles (habilitation) : texte intégral, e-mails et secrets du texte toujours masqués', () => {
    const m = maskRecetteRow({ ...row, full_text: 'Contact jean@exemple.fr — total 499 €' }, { includeSensitiveContent: true });
    expect(m.full_text).toMatch(/^Contact \[e-mail masqué #[0-9a-f]{8}\] — total 499 €$/);
    expect(m.s3_key).toMatchObject({ $etat: 'masque' });
  });

  it('tri stable : clé primaire, sinon texte complet de la ligne', () => {
    expect(orderClause(['account_id', 'id'])).toBe('t."account_id", t."id"');
    expect(orderClause([])).toBe('row_to_json(t)::text');
  });
});

const manifest = (over: Partial<RecetteManifest> = {}): RecetteManifest => ({
  schema: 'verebona.bo.export-recette/1', generationId: '11111111-2222-3333-4444-555555555555', generatedAt: '2026-10-23T10:00:00Z', finishedAt: '2026-10-23T10:05:00Z',
  environment: 'preprod', build: { version: '1', commit: 'abc' },
  perimeter: { description: 'Tous', accounts: 2, tablesExported: 1, tablesExcluded: [{ table: 'job_locks', motif: 'technique' }], tablesUnclassified: [] },
  snapshot: { isolation: 'REPEATABLE READ, READ ONLY', at: '2026-10-23T10:00:00.000001Z', snapshot: '1:1:', verification: 'v', exceptions: [] },
  options: { partRows: 2, batchRows: 500, sensitiveContent: false, today: '2026-10-23' },
  tables: [{ table: 'assets', domain: 'biens', expected: 3, exported: 3, parts: 2, status: 'COMPLETE', error: null }],
  files: [
    { path: 'donnees/biens/assets.part-0001.ndjson.gz', nature: 'donnees', table: 'assets', domain: 'biens', part: { index: 1, of: 2 }, expected: 2, exported: 2, bytes: 10, compressedBytes: 8, sha256: 'a', contentType: 'x', status: 'COMPLETE', error: null },
    { path: 'donnees/biens/assets.part-0002.ndjson.gz', nature: 'donnees', table: 'assets', domain: 'biens', part: { index: 2, of: 2 }, expected: 1, exported: 0, bytes: 0, compressedBytes: null, sha256: null, contentType: 'x', status: 'FAILED', error: 'coupure' },
    { path: 'dictionnaire.json', nature: 'documentation', table: null, domain: null, part: null, expected: null, exported: 0, bytes: 5, compressedBytes: null, sha256: 'b', contentType: 'x', status: 'COMPLETE', error: null },
    { path: 'LISEZMOI.txt', nature: 'documentation', table: null, domain: null, part: null, expected: null, exported: 0, bytes: 5, compressedBytes: null, sha256: 'c', contentType: 'x', status: 'COMPLETE', error: null },
  ],
  totals: { files: 5, tables: 1, rowsExpected: 3, rowsExported: 2, bytes: 20, compressedBytes: 18 },
  status: 'PARTIAL', warnings: ['assets : PARTIAL'], masking: ['m'], ...over,
});

describe('L82E-EX-03 documentation et téléchargement', () => {
  it('fichiers téléchargeables : documentation, parties écrites, manifeste en dernier ; partie annulée et chemin inconnu refusés', () => {
    const m = manifest();
    expect(recetteDownloadables(m)).toEqual(['LISEZMOI.txt', 'dictionnaire.json', 'donnees/biens/assets.part-0001.ndjson.gz', 'manifeste.json']);
    expect(isDownloadablePath(m, 'donnees/biens/assets.part-0002.ndjson.gz')).toBe(false);
    expect(isDownloadablePath(m, 'donnees/biens/autre.ndjson.gz')).toBe(false);
    expect(isDownloadablePath(m, 'manifeste.json')).toBe(true);
    expect(recetteDownloadables(null)).toEqual([]);
  });

  it('LISEZMOI : date d’extraction, instant de cohérence, statut et totaux, contrôle de complétude, exclusions', () => {
    const t = recetteReadme(manifest());
    expect(t).toContain('Instant de cohérence  : 2026-10-23T10:00:00.000001Z');
    expect(t).toContain('Statut                : PARTIAL — 2 ligne(s) exportée(s) sur 3 attendue(s)');
    expect(t).toContain('CONTRÔLER LA COMPLÉTUDE');
    expect(t).toContain('job_locks : technique');
    expect(t).toContain('assets : 3 ligne(s), 2 partie(s) — COMPLETE');
  });

  it('dictionnaire : colonnes, clé primaire, relation, masquage ; CSV avec BOM', () => {
    const cls = classifyTables(['assets']);
    const meta = new Map([['assets', {
      columns: [{ name: 'id', type: 'integer', nullable: false, generated: false, comment: null }, { name: 'account_id', type: 'integer', nullable: false, generated: false, comment: null },
        { name: 'email', type: 'text', nullable: true, generated: false, comment: null }],
      pk: ['id'], fks: [{ name: 'assets_account_fk', columns: ['account_id'], references: 'accounts', referencedColumns: ['id'] }],
    }]]);
    const d = buildDictionary(cls, meta, manifest().tables, manifest().files, 2);
    expect(d.tables[0]).toMatchObject({ table: 'assets', domain: 'biens', primaryKey: ['id'], rows: 3, files: ['donnees/biens/assets.part-0001.ndjson.gz', 'donnees/biens/assets.part-0002.ndjson.gz'] });
    expect(d.tables[0].columns.find((c) => c.name === 'email')?.masking).toBe('e-mail : pseudonyme stable');
    const csv = dictionaryCsv(d);
    expect(csv.startsWith('﻿domaine;table;')).toBe(true);
    expect(csv).toContain('biens;assets;');
    expect(csv).toContain(';account_id;integer;non;non;non;accounts.id;;');
  });
});

describe('L82E-EX-04 suivi : génération en tâche de fond interrompue', () => {
  it('sans signe de vie depuis plus de 10 minutes : interrompue ; signe de vie récent : en cours, même après 3 h', () => {
    const now = Date.parse('2026-10-23T13:00:00Z');
    expect(isInterrupted({ status: 'RUNNING', startedAt: '2026-10-23T10:00:00Z', heartbeatAt: '2026-10-23T12:59:00Z' }, now)).toBe(false);
    expect(isInterrupted({ status: 'RUNNING', startedAt: '2026-10-23T12:00:00Z', heartbeatAt: '2026-10-23T12:40:00Z' }, now)).toBe(true);
    expect(isInterrupted({ status: 'RUNNING', startedAt: '2026-10-23T12:00:00Z', heartbeatAt: null }, now)).toBe(false);
    expect(isInterrupted({ status: 'COMPLETE', startedAt: '2026-10-23T01:00:00Z', heartbeatAt: null }, now)).toBe(false);
  });
});
