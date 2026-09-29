/**
 * Catalogue des dossiers V12 et migration 0213 — CDC Exports V12 §1.2,
 * §16.1, EXP-001, EXP-002, DEC-007.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  DOSSIER_CODES, DOSSIER_LABELS, LEGACY_EXPORT_CODE_MAP, exportCodeLabel, isDossierCode,
  isDossierEligibleForFamily, normalizeExportCode, toExportFamily,
} from '../catalog';
import { assetAdditionalInfos } from '@/db/schema';

describe('codes des dossiers (§1.2)', () => {
  it('six codes, dans l’ordre du CDC', () => {
    expect([...DOSSIER_CODES]).toEqual(['CIL', 'DOSSIER_COMPLET', 'VENTE', 'LOCATION', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']);
    for (const c of DOSSIER_CODES) expect(DOSSIER_LABELS[c]).toBeTruthy();
  });

  it('isDossierCode', () => {
    expect(isDossierCode('LOCATION')).toBe(true);
    expect(isDossierCode('EXPORT_BRUT')).toBe(false);
    expect(isDossierCode('DOSSIER_VENTE')).toBe(false);
    expect(isDossierCode(null)).toBe(false);
  });
});

describe('normalizeExportCode : anciens codes → V12', () => {
  it.each([
    ['CIL_REGLEMENTAIRE', 'CIL'],
    ['CIL', 'CIL'],
    ['DOSSIER_VENTE', 'VENTE'],
    ['DOSSIER_REVENTE', 'VENTE'],
    ['REVENTE', 'VENTE'],
    ['ASSURANCE_ESTIMATION', 'ASSURANCE_SOUSCRIPTION'],
    ['ASSURANCE_DEVIS', 'ASSURANCE_SOUSCRIPTION'],
    ['ASSURANCE_INDEMNISATION', 'ASSURANCE_SINISTRE'],
    ['ASSURANCE_SINISTRE', 'ASSURANCE_SINISTRE'],
    ['DOSSIER_COMPLET', 'DOSSIER_COMPLET'],
    ['LOCATION', 'LOCATION'],
    ['EXPORT_BRUT', 'EXPORT_BRUT'],
    [' dossier_vente ', 'VENTE'],
  ])('%s → %s', (from, to) => {
    expect(normalizeExportCode(from)).toBe(to);
  });

  it('codes sans équivalent V12 : null', () => {
    for (const c of ['SAV_GARANTIE', 'AUTRE', 'TRANSMISSION', '', 'FOO']) expect(normalizeExportCode(c)).toBeNull();
    expect(normalizeExportCode(undefined)).toBeNull();
    expect(normalizeExportCode(42)).toBeNull();
  });

  it('la table de correspondance ne vise que des codes V12', () => {
    for (const v of Object.values(LEGACY_EXPORT_CODE_MAP)) expect(isDossierCode(v)).toBe(true);
  });

  it('libellé d’un ancien code = libellé V12', () => {
    expect(exportCodeLabel('DOSSIER_VENTE')).toBe(DOSSIER_LABELS.VENTE);
    expect(exportCodeLabel('ASSURANCE_INDEMNISATION', true)).toBe('Assurance — sinistre');
    expect(exportCodeLabel('EXPORT_BRUT')).toBe('Export données brutes');
    expect(exportCodeLabel('SAV_GARANTIE')).toBe('SAV_GARANTIE');
  });
});

describe('éligibilité par famille (§1.2, §4.2)', () => {
  it('famille stockée → famille CDC', () => {
    expect(toExportFamily('OBJECT')).toBe('OBJET');
    expect(toExportFamily('MATERIEL_PRO')).toBe('OBJET');
    expect(toExportFamily('IMMOBILIER')).toBe('IMMOBILIER');
    expect(toExportFamily('VEHICULE')).toBe('VEHICULE');
    expect(toExportFamily('XYZ')).toBeNull();
  });

  it('CIL et LOCATION : immobilier seulement ; les autres : trois familles', () => {
    for (const f of ['VEHICULE', 'OBJECT', 'OBJET']) {
      expect(isDossierEligibleForFamily('CIL', f)).toBe(false);
      expect(isDossierEligibleForFamily('LOCATION', f)).toBe(false);
    }
    expect(isDossierEligibleForFamily('CIL', 'IMMOBILIER')).toBe(true);
    expect(isDossierEligibleForFamily('LOCATION', 'IMMOBILIER')).toBe(true);
    for (const c of ['DOSSIER_COMPLET', 'VENTE', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']) {
      for (const f of ['IMMOBILIER', 'VEHICULE', 'OBJECT']) expect(isDossierEligibleForFamily(c, f)).toBe(true);
    }
  });

  it('accepte les anciens codes ; refuse l’export brut et une famille inconnue', () => {
    expect(isDossierEligibleForFamily('DOSSIER_VENTE', 'OBJECT')).toBe(true);
    expect(isDossierEligibleForFamily('CIL_REGLEMENTAIRE', 'VEHICULE')).toBe(false);
    expect(isDossierEligibleForFamily('EXPORT_BRUT', 'IMMOBILIER')).toBe(false);
    expect(isDossierEligibleForFamily('VENTE', null)).toBe(false);
  });
});

describe('migration 0213', () => {
  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0213_asset_additional_infos_export_codes.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('idempotente : IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS asset_additional_infos/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS asset_additional_infos_account_id_idx/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS claim_json/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION asset_additional_infos_sync_account/);
    expect(code).toMatch(/DROP TRIGGER IF EXISTS asset_additional_infos_sync_account_trg ON assets/);
    expect(code).not.toMatch(/\bDROP TABLE\b/i);
    expect(code).not.toMatch(/DROP COLUMN/i);
  });

  it('clés étrangères : bien et compte en cascade, auteur SET NULL', () => {
    expect(code).toMatch(/asset_id\s+integer\s+PRIMARY KEY REFERENCES assets\(id\) ON DELETE CASCADE/);
    expect(code).toMatch(/account_id\s+integer\s+NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/);
    expect(code).toMatch(/updated_by\s+integer\s+REFERENCES users\(id\) ON DELETE SET NULL/);
  });

  it('renomme chaque ancien code vers le code V12 du catalogue, dans les trois tables', () => {
    for (const table of ['export_generation', 'export_templates', 'document_type_export_associations']) {
      const start = code.indexOf(`UPDATE ${table} SET export_type`);
      expect(start, table).toBeGreaterThanOrEqual(0);
      const stmt = code.slice(start, code.indexOf(';', start));
      for (const [legacy, v12] of Object.entries(LEGACY_EXPORT_CODE_MAP)) {
        expect(stmt, `${table} ${legacy}`).toMatch(new RegExp(`WHEN '${legacy}'\\s+THEN '${v12}'`));
        // Clause WHERE : seules les lignes à renommer sont touchées (seconde exécution sans effet).
        expect(stmt.slice(stmt.indexOf('WHERE'))).toContain(`'${legacy}'`);
      }
      expect(stmt).not.toMatch(/EXPORT_BRUT|SAV_GARANTIE/);
    }
  });

  it('la colonne PDFMonkey est conservée (MIG-06)', () => {
    expect(code).not.toMatch(/DROP COLUMN[^;]*pdfmonkey/i);
    expect(code).toMatch(/COMMENT ON COLUMN export_templates\.pdfmonkey_template_id/);
  });

  it('schéma Drizzle aligné sur la migration', () => {
    const cfg = getTableConfig(assetAdditionalInfos);
    expect(cfg.name).toBe('asset_additional_infos');
    const cols = cfg.columns.map((c) => c.name).sort();
    // + finance_json et schema_version (migration 0214).
    expect(cols).toEqual(['account_id', 'asset_id', 'claim_json', 'commercial_json', 'created_at', 'finance_json', 'insurance_json', 'rental_json', 'schema_version', 'updated_at', 'updated_by', 'version'].sort());
    const fks = cfg.foreignKeys.map((fk) => {
      const r = fk.reference();
      return `${r.columns[0].name}:${fk.onDelete}`;
    }).sort();
    expect(fks).toEqual(['account_id:cascade', 'asset_id:cascade', 'updated_by:set null']);
  });

  it('numéro 0213 unique dans la chaîne', () => {
    const files = readdirSync(join(process.cwd(), 'src/db/migrations')).filter((f) => f.startsWith('0213_'));
    expect(files).toEqual(['0213_asset_additional_infos_export_codes.sql']);
  });
});

describe('migration 0214 (informations complémentaires structurées)', () => {
  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0214_asset_additional_infos_structured.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('idempotente et non destructive', () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS finance_json jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1/);
    // Chaque contrainte est retirée (IF EXISTS) avant d'être reposée.
    for (const c of ['asset_additional_infos_json_objects_check', 'asset_additional_infos_schema_version_check']) {
      expect(code.indexOf(`DROP CONSTRAINT IF EXISTS ${c}`), c).toBeGreaterThanOrEqual(0);
      expect(code.indexOf(`DROP CONSTRAINT IF EXISTS ${c}`)).toBeLessThan(code.indexOf(`ADD CONSTRAINT ${c}`));
    }
    expect(code).not.toMatch(/\bDROP TABLE\b|DROP COLUMN|\bDELETE\b|\bUPDATE\b/i);
  });

  it('les cinq sous-rubriques restent des objets JSON', () => {
    const check = code.slice(code.indexOf('ADD CONSTRAINT asset_additional_infos_json_objects_check'));
    for (const col of ['commercial_json', 'rental_json', 'insurance_json', 'claim_json', 'finance_json']) {
      expect(check).toContain(`jsonb_typeof(${col}) = 'object'`);
    }
  });

  it('numéro 0214 unique dans la chaîne', () => {
    const files = readdirSync(join(process.cwd(), 'src/db/migrations')).filter((f) => f.startsWith('0214_'));
    expect(files).toEqual(['0214_asset_additional_infos_structured.sql']);
  });
});
