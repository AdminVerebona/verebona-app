/**
 * VENTE-RULE-002 (lot 19) : annonces courte et détaillée affichées HORS PDF
 * dans l'interface de préparation — composition déterministe, prix jamais
 * inféré (VENTE-RULE-001), sans identifiant ni adresse précise.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeSource, event, TODAY } from './fixtures/sources';
import type { ExportSource } from '../data/source';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
const { saleAds, SALE_AD_LIMITS } = await import('../data/mappers/vente');
const { buildPreparation } = await import('../preparation/prepare');

const avecVente = (family: 'IMMOBILIER' | 'VEHICULE' | 'OBJET', commercial: Record<string, unknown> = {}): ExportSource => {
  const s = makeSource(family, 'VENTE');
  return { ...s, additionalInfo: { ...s.additionalInfo, commercial: commercial as ExportSource['additionalInfo']['commercial'] } };
};

describe('saleAds — annonces hors PDF', () => {
  it('prix : uniquement le prix saisi ; jamais l’estimation (VENTE-RULE-001)', () => {
    const sans = saleAds(avecVente('IMMOBILIER'), TODAY);
    expect(sans.priceMissing).toBe(true);
    expect(`${sans.short} ${sans.detailed}`).not.toMatch(/Prix|342|€/);
    const avec = saleAds(avecVente('IMMOBILIER', { desiredSalePriceCents: 31200000 }), TODAY);
    expect(avec.priceMissing).toBe(false);
    expect(avec.short).toContain('Prix : 312 000 €');
    expect(avec.detailed).toContain('- Prix : 312 000 €');
    expect(avec.detailed).not.toContain('342');
  });

  it('faits du dossier, sans identifiant ni adresse précise ; points forts documentés ; conditions saisies', () => {
    const v = saleAds({
      ...avecVente('VEHICULE', { salePitch: 'Vendu car déménagement.', availabilityDate: '2026-11-01', contactInstructions: 'Par message' }),
      events: [event(1, { title: 'Révision', date: '2026-03-01' })],
    }, TODAY);
    expect(v.short).toMatch(/^Vélo/);
    expect(v.detailed).toContain('Vendu car déménagement.');
    expect(v.detailed).toContain('Caractéristiques :');
    expect(v.detailed).toContain('Disponible à partir du 01/11/2026');
    expect(v.detailed).toContain('Contact : Par message');
    expect(v.detailed).toContain('Points forts :');
    const tout = `${v.short}\n${v.detailed}`;
    expect(tout).not.toContain('UA22F0000004871');
    expect(tout).not.toContain('AB-123-CD');
    expect(tout).not.toMatch(/[  ]/);
    const immo = saleAds(avecVente('IMMOBILIER'), TODAY);
    expect(`${immo.short}\n${immo.detailed}`).not.toContain('Remparts');
    expect(immo.detailed).toContain('Lyon');
  });

  it('ton : aucun qualificatif ajouté ; longueurs bornées ; composition déterministe', () => {
    const v = saleAds(avecVente('OBJET', { saleConditions: 'x'.repeat(5000) }), TODAY);
    expect(`${v.short} ${v.detailed}`).not.toMatch(/exceptionnel|magnifique|superbe|idéal|unique/i);
    expect(v.short.length).toBeLessThanOrEqual(SALE_AD_LIMITS.short);
    expect(v.detailed.length).toBeLessThanOrEqual(SALE_AD_LIMITS.detailed);
    expect(v.generatedBy).toBe('deterministic');
    expect(saleAds(avecVente('OBJET'), TODAY)).toEqual(saleAds(avecVente('OBJET'), TODAY));
  });

  it('préparation : annonces portées par le DTO du dossier VENTE seulement', () => {
    const ctx = { today: TODAY, lastGeneration: null } as never;
    expect(buildPreparation('VENTE', avecVente('OBJET'), ctx).saleAds).toMatchObject({ generatedBy: 'deterministic' });
    expect(buildPreparation('DOSSIER_COMPLET', makeSource('OBJET', 'DOSSIER_COMPLET'), ctx).saleAds).toBeNull();
  });
});

describe('liste blanche par famille — non-régression (relecture lot 19)', () => {
  const tout = (a: { short: string; detailed: string }) => `${a.short}\n${a.detailed}`;

  it('montre : marque, modèle, état publiés ; numéro de série et lieu de conservation jamais', () => {
    const base = makeSource('OBJET', 'VENTE');
    const montre: ExportSource = {
      ...base,
      asset: {
        ...base.asset, name: 'Montre de plongée',
        characteristics: { brand: 'Seiko', modelName: 'SPB143', serialNumber: '6R35-00P0-123456', storageLocation: 'Coffre Banque Populaire Lyon', provenance: 'Héritage de Jean Dupont', accessories: 'Boîte et papiers' },
      },
    };
    const a = saleAds(montre, TODAY);
    expect(tout(a)).toContain('Seiko');
    expect(tout(a)).toContain('SPB143');
    expect(tout(a)).toContain('Boîte et papiers');
    for (const interdit of ['6R35', '123456', 'Coffre', 'Banque', 'Jean Dupont', 'Numéro de série', 'Lieu de conservation', 'Provenance']) {
      expect(tout(a)).not.toContain(interdit);
    }
  });

  it('véhicule : marque, modèle, année, kilométrage ; VIN, immatriculation, date d’achat jamais', () => {
    const a = saleAds(makeSource('VEHICULE', 'VENTE'), TODAY);
    expect(tout(a)).toContain('Urban Arrow');
    expect(tout(a)).toContain('2022');
    expect(tout(a)).toMatch(/3 480 km/);
    for (const interdit of ['UA22F0000004871', 'UA22', '4871', 'AB-123-CD', 'AB', 'VIN', 'Immatriculation', "Date d'achat", '04/06/2022']) {
      expect(tout(a)).not.toContain(interdit);
    }
  });

  it('logement : type, surface, pièces, ville, DPE, équipements notables ; adresse jamais', () => {
    const a = saleAds(makeSource('IMMOBILIER', 'VENTE'), TODAY);
    expect(tout(a)).toContain('68 m²');
    expect(tout(a)).toContain('Lyon');
    expect(tout(a)).toMatch(/C · A|DPE/);
    expect(tout(a)).toContain('Équipements : Cave');
    for (const interdit of ['Remparts', '14 rue', 'Adresse']) expect(tout(a)).not.toContain(interdit);
  });
});
