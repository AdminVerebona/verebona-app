/**
 * BO « Modèles d'export » (2 oct. 2026) : les modèles sont les six dossiers
 * V12 du code ; seule leur disponibilité est administrée, et elle est
 * réellement appliquée côté utilisateur.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) } }));
vi.mock('@/services/entitlements.service', () => ({ canUsePremiumFeature: async () => ({ allowed: true }) }));

const { buildExportCatalog } = await import('../export-catalog.service');
const { loadInactiveDossiers, listDossierAvailability, setDossierAvailability, resetDossierAvailabilityCache } = await import('../dossier-availability');
const { toAdminExportModel, toDossierParam } = await import('@/app/api/admin/export-templates/model');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

beforeEach(() => { unsafe.mockReset(); resetDossierAvailabilityCache(); });

describe('disponibilité des dossiers', () => {
  it('sans ligne : actif ; liste dans l’ordre du catalogue', async () => {
    unsafe.mockResolvedValueOnce([{ code: 'VENTE', is_active: false, updated_at: '2026-10-02T12:00:00Z', email: 'a@b.fr' }]);
    const rows = await listDossierAvailability();
    expect(rows.map((r) => r.code)).toEqual(['CIL', 'DOSSIER_COMPLET', 'VENTE', 'LOCATION', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']);
    expect(rows.find((r) => r.code === 'VENTE')).toMatchObject({ isActive: false, updatedBy: 'a@b.fr' });
    expect(rows.find((r) => r.code === 'CIL')).toMatchObject({ isActive: true, updatedAt: null });
  });

  it('dossiers inactifs mis en cache, cache vidé au changement', async () => {
    unsafe.mockResolvedValueOnce([{ code: 'LOCATION' }, { code: 'INCONNU' }]);
    expect([...await loadInactiveDossiers(1000)]).toEqual(['LOCATION']);
    expect([...await loadInactiveDossiers(2000)]).toEqual(['LOCATION']);
    expect(unsafe).toHaveBeenCalledTimes(1);
    unsafe.mockResolvedValueOnce([{ is_active: false }]).mockResolvedValueOnce([]);
    await expect(setDossierAvailability('LOCATION', true, 7)).resolves.toEqual({ before: false });
    unsafe.mockResolvedValueOnce([]);
    expect([...await loadInactiveDossiers(3000)]).toEqual([]);
  });

  it('table illisible : rien n’est bloqué', async () => {
    unsafe.mockRejectedValueOnce(new Error('relation does not exist'));
    expect((await loadInactiveDossiers()).size).toBe(0);
  });
});

describe('catalogue d’un bien', () => {
  it('un dossier désactivé n’est plus proposé', () => {
    const c = buildExportCatalog({
      asset: { id: 1, category: 'IMMOBILIER', subtype: 'Maison' },
      premium: { allowed: true }, counts: { documents: 1, photos: 1 },
      additional: { commercial: {}, rental: {}, insurance: {}, claim: {} },
      cil: null, generations: [], unavailable: new Set(['VENTE'] as const),
    });
    expect(c.dossiers.map((d) => d.code)).not.toContain('VENTE');
    expect(c.dossiers).toHaveLength(5);
  });

  it('la mise en file refuse un dossier désactivé (409)', () => {
    const src = read('src/services/exports/v12/generation/enqueue.ts');
    expect(src).toMatch(/if \(\(await loadInactiveDossiers\(\)\)\.has\(code\)\) \{\s*return \{ ok: false, status: 409, code: 'DOSSIER_UNAVAILABLE'/);
  });
});

describe('back-office', () => {
  it('modèle : nom, description, familles, statut — jamais de version', () => {
    const m = toAdminExportModel({ code: 'CIL', isActive: true, updatedAt: null, updatedBy: null });
    expect(m).toMatchObject({ code: 'CIL', label: "Carnet d'information du logement", families: ['Immobilier'], isActive: true });
    expect(Object.keys(m)).not.toContain('version');
  });

  it('paramètre d’URL : code V12, ancien code accepté, export brut refusé', () => {
    expect(toDossierParam('VENTE')).toBe('VENTE');
    expect(toDossierParam('DOSSIER_VENTE')).toBe('VENTE');
    expect(toDossierParam('EXPORT_BRUT')).toBeNull();
    expect(toDossierParam('12')).toBeNull();
  });

  it('les routes ne lisent plus export_templates ; aucune écriture du contenu', () => {
    for (const f of [
      'src/app/api/admin/export-templates/route.ts',
      'src/app/api/admin/export-templates/[id]/route.ts',
      'src/app/api/admin/export-templates/[id]/preview/route.ts',
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/exportTemplates|FROM export_templates/);
      // Seule la prévisualisation a un POST (rendu, sans enregistrement).
      const interdits = f.endsWith('preview/route.ts') ? /export async function (PUT|DELETE)\b/ : /export async function (PUT|DELETE|POST)\b/;
      expect(src).not.toMatch(interdits);
    }
  });

  it('désactivation confirmée, activation directe ; actions journalisées', () => {
    const toggle = read('src/app/admin/export-templates/_components/ExportTemplateActiveToggle.tsx');
    expect(toggle).toContain('onCheckedChange={() => (isActive ? setConfirmOpen(true) : void apply())}');
    expect(read('src/app/api/admin/export-templates/[id]/route.ts')).toContain("action: 'EXPORT_TEMPLATE_TOGGLE'");
    expect(read('src/app/api/admin/export-templates/[id]/preview/route.ts')).toContain("action: 'EXPORT_TEMPLATE_PREVIEW'");
  });
});
