/**
 * Lot 32 — référentiels (décisions PO du 07/10/2026).
 *
 *   PO-Q13 : le sélecteur de types de documents est la liste du CODE
 *            (référentiel du lot 30), pas la table `document_types` ; les
 *            codes LEGACY_SUPPORTED sont lisibles mais non proposés.
 *   PO-Q14 : « Matériel pro » n'est pas une famille produit : plus affiché
 *            (BO Référentiels, sélecteurs) ; valeur ancienne normalisée vers
 *            OBJECT par `toAssetFamilyCode()`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

import { documentTypesForPicker } from '../picker-document-types';
import { pickerDocumentTypes, resolveDocumentCode } from '../document-codes';
import { DOCUMENT_TYPE_LIST } from '@/lib/document-type-constants';
import { ASSET_FAMILIES, assetFamilyLabel, toAssetFamilyCode } from '@/lib/asset-taxonomy';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('PO-Q13 — sélecteur de types de documents = liste du code', () => {
  it('la route ne lit plus la table `document_types` : elle sert le référentiel du code', async () => {
    const route = read('src/app/api/document-types/route.ts');
    expect(route).not.toMatch(/from '@\/db'/);
    expect(route).toContain('documentTypesForPicker()');
    const { GET } = await import('@/app/api/document-types/route');
    const body = await (await GET()).json();
    expect(body.documentTypes.map((t: { code: string }) => t.code).sort()).toEqual(DOCUMENT_TYPE_LIST.map((t) => t.code).sort());
  });

  it('proposés à la création = `pickerDocumentTypes()` (dont Certificat, Avis d’échéance, Annonce) ; anciens codes lisibles, non proposés', () => {
    const liste = documentTypesForPicker();
    const proposes = liste.filter((t) => !t.hideFromPicker).map((t) => t.code);
    expect(proposes.sort()).toEqual(pickerDocumentTypes().map((t) => t.code).sort());
    for (const c of ['CERTIFICAT', 'AVIS_ECHEANCE', 'ANNONCE_COMMERCIALE']) expect(proposes).toContain(c);
    for (const t of liste) {
      expect(t.status).toBe(t.hideFromPicker ? 'LEGACY_SUPPORTED' : 'ACTIVE');
      // Proposé ⇒ ACTIVE pour le résolveur unique ; jamais un code inconnu.
      if (t.status === 'ACTIVE') expect(resolveDocumentCode(t.code).status).toBe('ACTIVE');
      expect(resolveDocumentCode(t.code).status).not.toBe('UNKNOWN');
      expect(t.label).toBeTruthy();
    }
    expect(liste.find((t) => t.code === 'PHOTO')).toMatchObject({ hideFromPicker: true, status: 'LEGACY_SUPPORTED' });
    expect(liste.find((t) => t.code === 'AMIANTE')).toMatchObject({ hideFromPicker: true, status: 'LEGACY_SUPPORTED' });
  });

  it('les sélecteurs (tiroir, dialogues) n’affichent pas les codes LEGACY_SUPPORTED', () => {
    expect(read('src/components/assets/DocumentDrawer.tsx')).toContain('t.isActive && !t.hideFromPicker');
    expect(read('src/components/documents/unified-document-dialog.tsx')).toContain('dt.isActive && !dt.hideFromPicker');
    const edition = read('src/components/document-edit-dialog.tsx');
    expect(edition).toContain('dt.isActive && !dt.hideFromPicker');
    // La valeur actuelle d'un document ancien reste lisible.
    expect(edition).toContain('dt.code === document.documentType && dt.hideFromPicker');
  });
});

describe('PO-Q14 — « Matériel pro » n’est pas une famille', () => {
  it('absente des familles proposées ; valeur ancienne normalisée vers OBJECT, affichée « Objet »', () => {
    expect(ASSET_FAMILIES.map((f) => f.code)).not.toContain('MATERIEL_PRO');
    expect(toAssetFamilyCode('MATERIEL_PRO')).toBe('OBJECT');
    expect(assetFamilyLabel('MATERIEL_PRO')).toBe('Objet');
    expect(assetFamilyLabel('materiel_pro')).toBe('Objet');
  });

  it('BO Référentiels : applicabilité sans « Matériel pro », biens comptés sous « Objet »', async () => {
    const { applicabilityLabel, buildAssetTaxonomyReferentials, buildCodeReferentials } = await import('@/app/api/admin/referentials/referentials-data');
    expect(applicabilityLabel(['VEHICULE', 'MATERIEL_PRO'])).toBe('Véhicule, Objet');
    expect(applicabilityLabel(['MATERIEL_PRO', 'OBJECT'])).toBe('Objet');
    const code = buildCodeReferentials(new Map(), new Map(), new Map());
    const textes = [...code.rubrics, ...code.documentTypes, ...code.applicability].map((r) => `${r.label} ${r.details ?? ''}`);
    expect(textes.some((t) => /Matériel pro/i.test(t))).toBe(false);
    const { assetFamilies } = buildAssetTaxonomyReferentials([{ family: 'MATERIEL_PRO', n: 2 }], []);
    expect(assetFamilies.map((f) => f.label)).not.toContain('Matériel pro');
    expect(assetFamilies.find((f) => f.code === 'OBJECT')?.usage).toBe(2);
  });
});
