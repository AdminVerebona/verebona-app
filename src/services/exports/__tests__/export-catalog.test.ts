/**
 * Catalogue des dossiers d'un bien (EXP-001, §1.2, §3.1 étape 1) et fusion
 * atomique des informations complémentaires (§4.3). Les choix par défaut
 * (dont ceux du dossier de location, EXP-008) sont calculés par l'API de
 * préparation : `v12/__tests__/v12-preparation.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/services/entitlements.service', () => ({ canUsePremiumFeature: async () => ({ allowed: true }) }));

const { buildExportCatalog } = await import('../export-catalog.service');
const { mergeExpression } = await import('../additional-infos.service');

type Input = Parameters<typeof buildExportCatalog>[0];

const base = (over: Partial<Input> = {}): Input => ({
  asset: { id: 5, category: 'IMMOBILIER', subtype: 'Maison' },
  premium: { allowed: true },
  counts: { documents: 3, photos: 4 },
  additional: { commercial: {}, rental: {}, insurance: {}, claim: {} },
  cil: { globalStatus: 'ready', percentage: 80, blockingLabels: [] },
  generations: [],
  ...over,
});

const eligibleCodes = (i: Input) => buildExportCatalog(i).dossiers.filter((d) => d.eligible).map((d) => d.code);

describe('éligibilité par famille', () => {
  it('maison : les six dossiers', () => {
    expect(eligibleCodes(base())).toEqual(['CIL', 'DOSSIER_COMPLET', 'VENTE', 'LOCATION', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']);
  });

  it('terrain : pas de CIL, mais la location reste (immobilier)', () => {
    const c = buildExportCatalog(base({ asset: { id: 5, category: 'IMMOBILIER', subtype: 'Terrain' }, cil: null }));
    const cil = c.dossiers.find((d) => d.code === 'CIL')!;
    expect(cil.eligible).toBe(false);
    expect(cil.eligibilityReason).toMatch(/maisons et les appartements/);
    expect(cil.readiness.status).toBe('unavailable');
    expect(c.dossiers.find((d) => d.code === 'LOCATION')!.eligible).toBe(true);
  });

  it.each(['VEHICULE', 'OBJECT', 'MATERIEL_PRO'])('%s : ni CIL ni location', (category) => {
    const c = buildExportCatalog(base({ asset: { id: 5, category, subtype: null }, cil: null }));
    expect(c.dossiers.filter((d) => d.eligible).map((d) => d.code)).toEqual(['DOSSIER_COMPLET', 'VENTE', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']);
    expect(c.dossiers.find((d) => d.code === 'LOCATION')!.eligibilityReason).toMatch(/immobiliers uniquement/);
    expect(c.eligibility).toHaveLength(6);
  });
});

describe('droits de l’offre', () => {
  it('Standard : dossiers éligibles verrouillés avec motif, jamais masqués', () => {
    const c = buildExportCatalog(base({ premium: { allowed: false, reason: 'PREMIUM_REQUIRED', message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' } }));
    for (const d of c.dossiers) {
      expect(d.eligible).toBe(true);
      expect(d.locked).toBe(true);
      expect(d.lockReason).toEqual({ code: 'PREMIUM_REQUIRED', message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' });
    }
  });

  it('impayé : motif SUBSCRIPTION_REQUIRED transmis tel quel', () => {
    const c = buildExportCatalog(base({ premium: { allowed: false, reason: 'SUBSCRIPTION_REQUIRED', message: 'Paiement à régulariser.' } }));
    expect(c.dossiers[0].lockReason?.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('Premium : rien de verrouillé ; un dossier inéligible n’est pas « verrouillé »', () => {
    const c = buildExportCatalog(base({ asset: { id: 5, category: 'VEHICULE', subtype: null }, cil: null, premium: { allowed: false, reason: 'PREMIUM_REQUIRED' } }));
    expect(c.dossiers.find((d) => d.code === 'LOCATION')!.locked).toBe(false);
    expect(buildExportCatalog(base()).dossiers.every((d) => !d.locked)).toBe(true);
  });
});

describe('indices de préparation', () => {
  it('informations complémentaires recommandées non saisies : incomplete, avec la sous-rubrique à compléter', () => {
    const c = buildExportCatalog(base());
    const vente = c.dossiers.find((d) => d.code === 'VENTE')!;
    expect(vente.readiness.status).toBe('incomplete');
    expect(vente.readiness.hints[0]).toMatchObject({ code: 'SALE_PRICE_MISSING', target: 'additional-infos:commercial' });
    expect(c.dossiers.find((d) => d.code === 'LOCATION')!.readiness.hints[0].code).toBe('RENT_MISSING');
    expect(c.dossiers.find((d) => d.code === 'ASSURANCE_SOUSCRIPTION')!.readiness.hints[0].code).toBe('INSURANCE_OBJECTIVE_MISSING');
    expect(c.dossiers.find((d) => d.code === 'ASSURANCE_SINISTRE')!.readiness.hints[0].code).toBe('CLAIM_MISSING');
  });

  it('champs renseignés (zéro compris) : prêt', () => {
    const c = buildExportCatalog(base({
      additional: {
        commercial: { desiredSalePriceCents: 0 }, rental: { monthlyRentCents: 115000 },
        insurance: { insuranceObjective: 'SOUSCRIRE' }, claim: { claimType: 'VOL', occurredOn: '2026-08-03' },
      },
    }));
    for (const code of ['VENTE', 'LOCATION', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']) {
      expect(c.dossiers.find((d) => d.code === code)!.readiness.status, code).toBe('ready');
    }
  });

  it('CIL avec blocs bloquants : blocked', () => {
    const c = buildExportCatalog(base({ cil: { globalStatus: 'action_required', percentage: 40, blockingLabels: ['B1 Identification', 'B3 Plans'] } }));
    const cil = c.dossiers.find((d) => d.code === 'CIL')!;
    expect(cil.readiness.status).toBe('blocked');
    expect(cil.readiness.hints[0].message).toContain('B1 Identification, B3 Plans');
  });

  it('sans photo ni document : indices informatifs, statut inchangé', () => {
    const c = buildExportCatalog(base({ counts: { documents: 0, photos: 0 }, additional: { commercial: { desiredSalePriceCents: 1 }, rental: {}, insurance: {}, claim: {} } }));
    const vente = c.dossiers.find((d) => d.code === 'VENTE')!;
    expect(vente.readiness.status).toBe('ready');
    expect(vente.readiness.hints.map((h) => h.code)).toEqual(['NO_PHOTOS']);
    expect(c.dossiers.find((d) => d.code === 'DOSSIER_COMPLET')!.readiness.hints.map((h) => h.code)).toEqual(['NO_DOCUMENTS']);
  });

  it('sous-rubriques lues par dossier', () => {
    const c = buildExportCatalog(base());
    expect(c.dossiers.find((d) => d.code === 'LOCATION')!.additionalSections).toEqual(['rental']);
    expect(c.dossiers.find((d) => d.code === 'CIL')!.additionalSections).toEqual([]);
  });
});

describe('dernières générations', () => {
  it('anciens codes ramenés aux codes V12, la plus récente par dossier', () => {
    const c = buildExportCatalog(base({
      generations: [
        { id: 3, publicId: 'c', exportType: 'VENTE', status: 'ready', createdAt: new Date('2026-09-20T10:00:00Z'), completedAt: null },
        { id: 2, publicId: 'b', exportType: 'DOSSIER_VENTE', status: 'ready', createdAt: new Date('2026-09-01T10:00:00Z'), completedAt: null },
        { id: 1, publicId: 'a', exportType: 'ASSURANCE_INDEMNISATION', status: 'error', createdAt: '2026-08-01T10:00:00.000Z', completedAt: null },
        { id: 0, publicId: 'z', exportType: 'SAV_GARANTIE', status: 'ready', createdAt: '2026-07-01T10:00:00.000Z', completedAt: null },
      ],
    }));
    expect(c.dossiers.find((d) => d.code === 'VENTE')!.lastGeneration?.id).toBe(3);
    expect(c.dossiers.find((d) => d.code === 'ASSURANCE_SINISTRE')!.lastGeneration).toMatchObject({ id: 1, exportType: 'ASSURANCE_SINISTRE', status: 'error' });
    expect(c.lastGenerations.map((g) => g.id)).toEqual([3, 1]);
  });
});

describe('fusion atomique en base (§4.3, dernier écrit gagne par champ)', () => {
  const dialect = new PgDialect();

  it('valeurs fusionnées par `||`, retraits par `- ARRAY[...]`, paramètres liés', () => {
    const expr = mergeExpression('rental', { set: { rental: { depositCents: 0 } }, unset: { rental: ['leaseType', 'monthlyRentCents'] } });
    const q = dialect.sqlToQuery(expr!);
    expect(q.sql).toMatch(/\(\(coalesce\("asset_additional_infos"\."rental_json", '\{\}'::jsonb\) \|\| \$1::jsonb\) - ARRAY\[\$2, \$3\]::text\[\]\)/);
    expect(q.params).toEqual(['{"depositCents":0}', 'leaseType', 'monthlyRentCents']);
  });

  it('écriture seule : `|| $1::jsonb` avec la valeur sérialisée', () => {
    const expr = mergeExpression('commercial', { set: { commercial: { desiredSalePriceCents: 0 } }, unset: {} });
    const q = dialect.sqlToQuery(expr!);
    expect(q.sql).toMatch(/\|\| \$1::jsonb/);
    expect(q.params).toEqual(['{"desiredSalePriceCents":0}']);
  });

  it('sous-rubrique non touchée : aucune expression (colonne laissée telle quelle)', () => {
    expect(mergeExpression('claim', { set: { commercial: { salePitch: 'x' } }, unset: {} })).toBeNull();
  });
});
