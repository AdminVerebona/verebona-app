/**
 * Centre d'aide GAP-08 / GAP-04 — éligibilité CIL et pièces/équipements.
 *
 *   - CIL : Maison + Appartement uniquement, en préparation, en génération
 *     et en relance (Immeuble et Mobil-home refusés) ;
 *   - une seule liste (`lib/asset-capabilities`), dont chaque entrée existe
 *     dans le référentiel de création (`lib/asset-taxonomy`) ;
 *   - la fiche bien et les routes pièces/équipements utilisent la même règle.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let assetRow: Record<string, unknown> | null = null;

vi.mock('@/db', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) c[m] = () => c;
  c.limit = async () => (assetRow ? [assetRow] : []);
  return { db: c };
});
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: 1, currentAccountId: 10 }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/services/export-upload.service', () => ({}));
vi.mock('@/services/export-snapshot.service', () => ({}));
vi.mock('@/services/export-manifest.service', () => ({}));
vi.mock('@/services/entitlements.service', () => ({ canUsePremiumFeature: async () => ({ allowed: true }) }));
vi.mock('@/services/export-zip.service', () => ({}));

const { GET: preparation } = await import('../[id]/exports/cil/preparation/route');
const { POST: createExport } = await import('../[id]/exports/route');
const { ASSET_FAMILIES } = await import('@/lib/asset-taxonomy');
const {
  CIL_ELIGIBLE_CATEGORIES, ROOM_CAPABLE_CATEGORIES, assetSupportsRooms, isCilEligible,
} = await import('@/lib/asset-capabilities');
const { assetSupportsStructuralFeatures } = await import('@/types/domain');

const params = { params: Promise.resolve({ id: '5' }) };
const immo = (subtype: string) => ({ id: 5, userId: 1, category: 'IMMOBILIER', subtype, name: 'Bien', address: null, postalCode: null, city: null });

beforeEach(() => { assetRow = null; });

describe('GET /api/assets/[id]/exports/cil/preparation', () => {
  it.each(['Immeuble', 'Mobil-home', 'Terrain', 'Garage/box', 'Local professionnel/commercial'])(
    'refuse « %s »', async (subtype) => {
      assetRow = immo(subtype);
      const res = await preparation(new NextRequest('http://x'), params);
      const body = await res.json();
      expect(body.eligible).toBe(false);
      expect(body.eligibilityReason).toBe('not_eligible_asset_subtype');
    },
  );

  it('refuse un véhicule', async () => {
    assetRow = { ...immo('Voiture'), category: 'VEHICULE' };
    expect((await (await preparation(new NextRequest('http://x'), params)).json()).eligible).toBe(false);
  });
});

describe('POST /api/assets/[id]/exports — CIL', () => {
  const post = (exportType: string) => createExport(
    new NextRequest('http://x', { method: 'POST', body: JSON.stringify({ exportType }), headers: { 'content-type': 'application/json' } }),
    params,
  );

  // CDC V12 §17.3 : dossier non éligible = 422 NOT_ELIGIBLE (ancien et nouveau code acceptés).
  it.each(['Immeuble', 'Mobil-home', 'Terrain'])('refuse un CIL pour « %s »', async (subtype) => {
    assetRow = immo(subtype);
    for (const code of ['CIL_REGLEMENTAIRE', 'CIL']) {
      const res = await post(code);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('NOT_ELIGIBLE');
      expect(body.message).toMatch(/maisons et les appartements/);
    }
  });
});

describe('lib/asset-capabilities', () => {
  const immoLabels = ASSET_FAMILIES.find((f) => f.code === 'IMMOBILIER')!.categories.map((c) => c.value);

  it('ne cite que des catégories du référentiel de création', () => {
    for (const c of [...CIL_ELIGIBLE_CATEGORIES, ...ROOM_CAPABLE_CATEGORIES]) expect(immoLabels).toContain(c);
  });

  it('CIL : Maison et Appartement uniquement', () => {
    expect(immoLabels.filter((subtype) => isCilEligible({ category: 'IMMOBILIER', subtype }))).toEqual(['Maison', 'Appartement']);
    expect(isCilEligible({ category: 'IMMOBILIER', subtype: 'maison' })).toBe(true);
    expect(isCilEligible({ category: 'IMMOBILIER', subtype: 'Studio' })).toBe(true); // ancien libellé
    expect(isCilEligible({ category: 'VEHICULE', subtype: 'Maison' })).toBe(false);
  });

  it('pièces / équipements : même règle pour la fiche, les routes et les formulaires', () => {
    for (const subtype of immoLabels) {
      expect(assetSupportsStructuralFeatures({ category: 'IMMOBILIER', subtype })).toBe(assetSupportsRooms({ category: 'IMMOBILIER', subtype }));
    }
    expect(immoLabels.filter((subtype) => assetSupportsRooms({ category: 'IMMOBILIER', subtype })))
      .toEqual(['Maison', 'Appartement', 'Immeuble', 'Local professionnel/commercial']);
    expect(assetSupportsRooms({ category: 'IMMOBILIER', subtype: 'Local commercial' })).toBe(true);
  });

  it('aucune liste recopiée dans la fiche ni dans les routes CIL', () => {
    const root = process.cwd();
    const page = readFileSync(join(root, 'src/app/(dashboard)/assets/[id]/page.tsx'), 'utf8');
    expect(page).not.toMatch(/SUBTYPES_WITH_ROOMS/);
    expect(page).toContain("from '@/lib/asset-capabilities'");
    for (const f of [
      'src/app/api/assets/[id]/exports/cil/preparation/route.ts',
      // Génération V12 : contrôle fait à la mise en file et par le worker.
      'src/services/exports/v12/generation/enqueue.ts',
      'src/services/exports/v12/generation/job.ts',
      'src/components/assets/AssetExportsTab.tsx',
    ]) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src, f).toContain('isCilEligible');
      expect(src, f).not.toMatch(/ELIGIBLE_SUBTYPES|'Mobil-home'|'Immeuble'/);
    }
  });
});
