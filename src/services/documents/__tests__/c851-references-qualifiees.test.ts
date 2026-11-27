/**
 * Carte #851 — références QUALIFIÉES dans les sous-requêtes corrélées placées
 * dans la liste SELECT d'une requête sans jointure (rendu SQL, sans base).
 *
 * Drizzle rend `${table.col}` sans nom de table dans la liste SELECT d'une
 * requête à table unique ; dans une sous-requête, ce nom nu était résolu sur la
 * table interne (`document_asset_links.id`, `legal_acceptances.id`…). Le
 * scénario PostgreSQL `c851-references-qualifiees.e2e.ts` prouve l'effet.
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetFiles, assets } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ASSET_FILES_COLUMN_SQL, OTHER_ASSET_IDS_SQL } from '@/services/documents/asset-document-scope';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const qb = new QueryBuilder();
const sousRequete = (s: string) => s.slice(s.indexOf('(\n  SELECT COALESCE'));

describe('C851-U — OTHER_ASSET_IDS_SQL', () => {
  it('C851-U-01 — sans jointure : toutes les références à asset_files sont qualifiées', () => {
    const rendu = qb.select({ id: assetFiles.id, autres: OTHER_ASSET_IDS_SQL }).from(assetFiles).toSQL().sql;
    const sq = sousRequete(rendu);
    expect(sq).toContain('dal.file_id = "asset_files"."id"');
    expect(sq).toContain('x.account_id = "asset_files"."account_id"');
    expect(sq).toContain('IS DISTINCT FROM "asset_files"."asset_id"');
    expect(sq).toContain('SELECT "asset_files"."linked_asset_id" AS id');
    // Aucun nom de colonne nu entre guillemets dans la sous-requête.
    expect(sq.match(/(?<![".\w])"(id|asset_id|linked_asset_id|account_id)"/g)).toBeNull();
  });

  it('C851-U-02 — avec jointure : même texte de sous-requête qu’avant (déjà qualifié)', () => {
    const seule = qb.select({ autres: OTHER_ASSET_IDS_SQL }).from(assetFiles).toSQL().sql;
    const jointe = qb.select({ autres: OTHER_ASSET_IDS_SQL }).from(assetFiles)
      .leftJoin(assets, eq(assets.id, assetFiles.assetId)).toSQL().sql;
    expect(sousRequete(seule)).toBe(sousRequete(jointe).replace(/ from "asset_files" left join[\s\S]*$/, ' from "asset_files"'));
  });

  it('C851-U-03 — ASSET_FILES_COLUMN_SQL qualifie dans la liste SELECT', () => {
    expect(qb.select({ x: ASSET_FILES_COLUMN_SQL('equipment_id') }).from(assetFiles).toSQL().sql)
      .toBe('select "asset_files"."equipment_id" from "asset_files"');
  });

  it('C851-U-04 — liste groupée et BO CGVU : plus de référence nue dans ces sous-requêtes', () => {
    const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
    const dq = lire('src/services/documents/document-query.service.ts');
    expect(dq).toContain("dal.file_id = ${ASSET_FILES_COLUMN_SQL('id')}");
    expect(dq).toContain("IS DISTINCT FROM ${ASSET_FILES_COLUMN_SQL('equipment_id')}");
    const cg = lire('src/services/legal/cguv-referential.service.ts');
    expect(cg).toContain("la.legal_document_version_id = ${legalDocumentVersions}.${sql.identifier('id')}");
    expect(cg).not.toContain('la.legal_document_version_id = ${legalDocumentVersions.id}');
  });
});
