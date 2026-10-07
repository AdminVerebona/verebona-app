/**
 * Lot 30 — Référentiels : une source de vérité par dimension (PostgreSQL réel).
 *
 * REF-AC03 (table) : après migrations, `document_types` contient chaque code
 *   V1 du référentiel du code ; chaque code actif en base est connu du
 *   résolveur documentaire (jamais « inconnu ») ; la migration 0262 est
 *   idempotente et n'écrase aucun réglage du back-office.
 * REF-AC13 : le BO Référentiels affiche les valeurs des référentiels
 *   centraux (familles, Types V2 et V1, correspondances du code), usages
 *   comptés en base.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('L30', 'Référentiels : document_types et BO alignés sur le code', ({ sql, make }) => {
  it('REF-AC03 : document_types contient tous les codes V1 ; tout code actif en base est résolu', async () => {
    const { DOCUMENT_TYPE_LIST } = await import('@/lib/document-type-constants');
    const { resolveDocumentCode } = await import('@/lib/referential/document-codes');
    const lignes = await sql<{ code: string; is_active: boolean }[]>`SELECT code, is_active FROM document_types`;
    const enBase = new Set(lignes.map((l) => l.code));
    expect(DOCUMENT_TYPE_LIST.filter((t) => !enBase.has(t.code)).map((t) => t.code)).toEqual([]);
    const inconnus = lignes.filter((l) => l.is_active && resolveDocumentCode(l.code).status === 'UNKNOWN').map((l) => l.code);
    expect(inconnus).toEqual([]);
  });

  it('REF-AC03 : migration 0262 idempotente, réglages du back-office conservés', async () => {
    const texte = await readFile(join(process.cwd(), 'src', 'db', 'migrations', '0262_document_types_sync_referentiel.sql'), 'utf8');
    const [avant] = await sql<{ label: string; display_order: number }[]>`
      SELECT label, display_order FROM document_types WHERE code = 'EXPERTISE'`;
    try {
      await sql`UPDATE document_types SET label = 'Expertise (BO)', display_order = 777 WHERE code = 'EXPERTISE'`;
      const [{ n: total }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_types`;
      for (let i = 0; i < 2; i++) await sql.begin((tx) => tx.unsafe(texte));
      const [{ n: apres }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_types`;
      expect(apres).toBe(total);
      const [bo] = await sql<{ label: string; display_order: number }[]>`
        SELECT label, display_order FROM document_types WHERE code = 'EXPERTISE'`;
      expect(bo).toEqual({ label: 'Expertise (BO)', display_order: 777 });
    } finally {
      await sql`UPDATE document_types SET label = ${avant.label}, display_order = ${avant.display_order} WHERE code = 'EXPERTISE'`;
    }
  });

  it('REF-AC13 : BO Référentiels — familles, Types V2 et V1, correspondances du code', async () => {
    const c = await make.account({ plan: 'premium' });
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Box Lyon' });
    await sql`UPDATE assets SET subtype = 'Garage' WHERE id = ${bien.id}`;

    const { loadReferentials } = await import('@/app/api/admin/referentials/referentials-data');
    const { ASSET_FAMILIES } = await import('@/lib/asset-taxonomy');
    const { DOCUMENT_TYPES, RUBRICS } = await import('@/lib/referential/v2');
    const { DOCUMENT_TYPE_LIST } = await import('@/lib/document-type-constants');
    const snap = await loadReferentials();

    for (const f of ASSET_FAMILIES) expect(snap.assetFamilies.find((r) => r.code === f.code)?.label).toBe(f.label);
    // Ancien libellé « Garage » compté sur la catégorie actuelle.
    expect(snap.assetSubcategories.find((r) => r.code === 'Garage/box')?.usage ?? 0).toBeGreaterThanOrEqual(1);
    expect(snap.rubrics.map((r) => r.code).sort()).toEqual(RUBRICS.map((r) => r.code).sort());
    const codes = new Set(snap.documentTypes.map((r) => r.code));
    for (const t of [...DOCUMENT_TYPES, ...DOCUMENT_TYPE_LIST]) expect(codes.has(t.code), t.code).toBe(true);
    expect(snap.mappings.find((m) => m.code === 'MATERIEL_PRO')?.label).toBe('MATERIEL_PRO → Objet');
    expect(snap.mappings.find((m) => m.code === 'garage')?.label).toBe('garage → Garage/box');
    expect(snap.mappings.find((m) => m.code === 'FACTURE_ACHAT')?.label).toContain('règle FACTURE');
  });
});
