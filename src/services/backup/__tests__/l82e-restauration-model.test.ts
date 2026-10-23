/**
 * Lot 82E — règles PURES du point de restauration (C-Q8, D13) : compatibilité
 * de schéma, tables conservées, découpe des lignes de sauvegarde, garde
 * d'environnement, synthèse BO et validation de la demande.
 */
import { describe, expect, it } from 'vitest';
import {
  RESTORE_KEEP_CURRENT_TABLES, checkRestoreCompatibility, signatureFingerprint, type SchemaSignature,
} from '../schema-signature';
import { restoreAllowedInEnvironment, splitBackupLine } from '../database-restore.service';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';
import { BACKFILL_DEFINITIONS, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';

const courant: SchemaSignature = {
  assets: ['id:int4', 'name:text'],
  agenda_items: ['id:int4', 'title:text'],
  admin_audit_log: ['id:int4', 'details:text'],
};
const point = (tables: Array<{ name: string; columns?: string[] }>, version = 2) => ({ version, tables: tables.map((t) => ({ rows: 1, ...t })) });

describe('L82E-RS-01 compatibilité d’un point avec le schéma courant', () => {
  it('schéma identique : restaurable, tables conservées à part', () => {
    const c = checkRestoreCompatibility(point([
      { name: 'agenda_items', columns: ['title:text', 'id:int4'] }, { name: 'assets', columns: ['id:int4', 'name:text'] },
      { name: 'admin_audit_log', columns: ['id:int4'] },
    ]), courant);
    expect(c.restorable).toBe(true);
    expect(c.restoredTables).toEqual(['agenda_items', 'assets']);
    // Journal d'administration conservé, même si ses colonnes ont changé.
    expect(c.keptTables).toEqual(['admin_audit_log']);
  });

  it('colonne ajoutée, table ajoutée ou retirée depuis le point : refus motivé, aucune table restaurée', () => {
    const c = checkRestoreCompatibility(point([
      { name: 'agenda_items', columns: ['id:int4'] }, { name: 'vieille_table', columns: ['id:int4'] },
    ]), courant);
    expect(c.restorable).toBe(false);
    expect(c.restoredTables).toEqual([]);
    expect(c.reason).toMatch(/schéma a changé/);
    expect(c.differences).toEqual(expect.arrayContaining([
      { table: 'agenda_items', issue: 'COLONNES_DIFFERENTES', detail: 'nouvelles : title:text' },
      { table: 'assets', issue: 'ABSENTE_DU_POINT' },
      { table: 'vieille_table', issue: 'ABSENTE_AUJOURD_HUI' },
    ]));
  });

  it('point au format 1 (avant le lot 82) : jamais restaurable', () => {
    const c = checkRestoreCompatibility(point([{ name: 'assets' }], 1), courant);
    expect(c.restorable).toBe(false);
    expect(c.reason).toMatch(/format antérieur/);
  });

  it('tables conservées : journaux, suivi des exports et rattrapages, révocations de sécurité', () => {
    expect(RESTORE_KEEP_CURRENT_TABLES).toEqual(expect.arrayContaining([
      'admin_audit_log', 'admin_export_generations', 'ops_backfill_runs', 'scheduled_task_state', 'revoked_tokens', 'user_session_revocations', 'job_locks', '_migrations',
    ]));
  });

  it('empreinte du schéma stable, indépendante de l’ordre', () => {
    expect(signatureFingerprint({ b: ['y:int4', 'x:text'], a: ['id:int4'] })).toBe(signatureFingerprint({ a: ['id:int4'], b: ['x:text', 'y:int4'] }));
    expect(signatureFingerprint({ a: ['id:int4'] })).not.toBe(signatureFingerprint({ a: ['id:int8'] }));
  });
});

describe('L82E-RS-02 lignes de sauvegarde, environnement', () => {
  it('découpe une ligne sans décoder le JSON (texte exact conservé)', () => {
    expect(splitBackupLine('{"t":"assets","r":{"id":1,"n":9007199254740993,"x":"}"}}')).toEqual({ table: 'assets', row: '{"id":1,"n":9007199254740993,"x":"}"}' });
    expect(splitBackupLine('n’importe quoi')).toBeNull();
    expect(splitBackupLine('{"t":"a;drop","r":{}}')).toBeNull();
  });

  it('restauration autorisée en préproduction ; production : choix explicite exigé', () => {
    expect(restoreAllowedInEnvironment({ NEXT_PUBLIC_APP_ENV: 'preprod' } as unknown as NodeJS.ProcessEnv).allowed).toBe(true);
    expect(restoreAllowedInEnvironment({ NEXT_PUBLIC_APP_ENV: 'production' } as unknown as NodeJS.ProcessEnv).allowed).toBe(false);
    expect(restoreAllowedInEnvironment({ NEXT_PUBLIC_APP_ENV: 'production', BACKUP_RESTORE_ALLOWED: 'true' } as unknown as NodeJS.ProcessEnv).allowed).toBe(true);
  });
});

describe('L82E-RS-03 moteur des rattrapages BO : « Point de restauration de la base »', () => {
  it('définition en tête, actions « Appliquer » (créer) et « Restaurer », aucun filtre de compte', () => {
    const d = BACKFILL_DEFINITIONS.find((x) => x.script === 'database-restore-point')!;
    expect(d.order).toBe(0);
    expect(d.actions).toEqual(['apply', 'restore']);
    expect(d.accountFilter).toBe(false);
  });

  it('demande : motif obligatoire ; restauration = identifiant du point exigé', () => {
    expect(validateBackfillRequest({ script: 'database-restore-point', action: 'apply', reason: 'Avant campagne' }).ok).toBe(true);
    expect(validateBackfillRequest({ script: 'database-restore-point', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'database-restore-point', action: 'restore', reason: 'Retour arrière' })).toMatchObject({ ok: false, code: 'INVALID_RUN_ID' });
    expect(validateBackfillRequest({ script: 'database-restore-point', action: 'simulate', reason: 'x' })).toMatchObject({ ok: false, code: 'ACTION_NOT_SUPPORTED' });
    expect(validateBackfillRequest({ script: 'database-restore-point', action: 'restore', reason: 'Retour arrière', runId: '6f1c1f6e-3a5b-4c8d-9e0f-1a2b3c4d5e6f' }).ok).toBe(true);
  });

  it('synthèse : création = point restaurable (identifiant), restauration = volumes, point de l’état d’avant, envois neutralisés', () => {
    const c = summarizeBackfill('database-restore-point', 'apply', null, { result: {
      backupId: 'b-1', snapshot: { at: '2026-10-23T10:00:00Z' }, totalRows: 10, tables: [{ name: 'a', rows: 10 }], sizeBytes: 5, durationMs: 1000,
      schema: { fingerprint: 'abc', lastMigration: '0657' },
    } });
    expect(c).toMatchObject({ scriptRunId: 'b-1', restorable: true });
    expect(c.headline).toMatch(/Point de restauration créé : b-1/);
    const r = summarizeBackfill('database-restore-point', 'restore', null, { result: {
      backupId: 'b-1', backupLabel: null, backupSnapshotAt: '2026-10-23T10:00:00Z', safetyBackupId: 'b-2', restoredTables: 3, keptTables: ['admin_audit_log'],
      rows: 42, perTable: [], foreignKeys: { restored: 5, keptRevalidated: 1, keptNotValid: [] }, triggersSuspended: 2, sequencesAdvanced: [],
      neutralized: [{ table: 'notification_outbox', label: 'Notifications en attente annulées', rows: 1 }], durationMs: 2000,
    } });
    expect(r).toMatchObject({ scriptRunId: 'b-2', restorable: false });
    expect(r.headline).toMatch(/42 ligne\(s\) rechargée\(s\) dans 3 table\(s\), 5 relation\(s\) revalidée\(s\), 1 envoi\(s\) en attente neutralisé\(s\)/);
  });
});
