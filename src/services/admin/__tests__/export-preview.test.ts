/**
 * Prévisualisation des modèles d'export — CDC Back-Office V1 EXP-008 à EXP-012.
 */
import { describe, it, expect } from 'vitest';
import {
  assetIneligibilityReason,
  listMissingPreviewData,
  previewFileName,
  resolvePreviewExportType,
} from '@/services/admin/export-preview.service';

describe('resolvePreviewExportType', () => {
  it('reconnaît un code égal au type d’export du moteur', () => {
    expect(resolvePreviewExportType({ code: 'CIL_REGLEMENTAIRE', exportType: null, category: 'IMMOBILIER' })).toBe('CIL_REGLEMENTAIRE');
    expect(resolvePreviewExportType({ code: 'export_brut', exportType: null, category: 'GENERAL' })).toBe('EXPORT_BRUT');
  });
  it('se rabat sur la colonne export_type historique', () => {
    expect(resolvePreviewExportType({ code: 'DOSSIER_VENTE_VELO_V1', exportType: 'DOSSIER_VENTE', category: 'VEHICULE' })).toBe('DOSSIER_VENTE');
    expect(resolvePreviewExportType({ code: 'X', exportType: 'ASSURANCE_DEVIS', category: 'GENERAL' })).toBe('ASSURANCE_ESTIMATION');
    expect(resolvePreviewExportType({ code: 'X', exportType: 'ASSURANCE_SINISTRE', category: 'GENERAL' })).toBe('ASSURANCE_INDEMNISATION');
    expect(resolvePreviewExportType({ code: 'X', exportType: 'CIL', category: 'GENERAL' })).toBe('CIL_REGLEMENTAIRE');
  });
  it('retourne null pour un modèle non utilisé par le moteur', () => {
    expect(resolvePreviewExportType({ code: 'SAV_V1', exportType: 'SAV_GARANTIE', category: 'GENERAL' })).toBeNull();
    expect(resolvePreviewExportType({ code: 'FOO', exportType: null, category: 'GENERAL' })).toBeNull();
  });
});

describe('assetIneligibilityReason', () => {
  it('CIL réservé à l’immobilier', () => {
    expect(assetIneligibilityReason('CIL_REGLEMENTAIRE', 'GENERAL', 'VEHICULE')).toMatch(/immobiliers/);
    expect(assetIneligibilityReason('CIL_REGLEMENTAIRE', 'GENERAL', 'IMMOBILIER')).toBeNull();
  });
  it('dossier de vente : immobilier ou véhicule', () => {
    expect(assetIneligibilityReason('DOSSIER_VENTE', 'GENERAL', 'MATERIEL_PRO')).not.toBeNull();
    expect(assetIneligibilityReason('DOSSIER_VENTE', 'GENERAL', 'VEHICULE')).toBeNull();
  });
  it('respecte la catégorie du modèle sauf GENERAL', () => {
    expect(assetIneligibilityReason('DOSSIER_COMPLET', 'VEHICULE', 'IMMOBILIER')).not.toBeNull();
    expect(assetIneligibilityReason('DOSSIER_COMPLET', 'GENERAL', 'IMMOBILIER')).toBeNull();
    expect(assetIneligibilityReason('DOSSIER_COMPLET', null, 'OBJECT')).toBeNull();
  });
});

describe('listMissingPreviewData (EXP-011)', () => {
  const base = {
    exportType: 'DOSSIER_COMPLET' as const,
    sections: [{ key: 'maintenance', label: 'Entretien', include: true }],
    includedDocuments: [],
    unqualifiedDocCount: 0,
    missingRubricCount: 0,
  };
  const snap = {
    category: 'IMMOBILIER',
    address: null,
    city: 'Lyon',
    postalCode: '69001',
    purchaseDate: null,
    purchasePriceCents: null,
    estimatedValueCents: null,
    photos: [],
    events: [],
    documents: [],
  };

  it('liste les données absentes sans bloquer le rendu', () => {
    const missing = listMissingPreviewData(base, snap as never);
    expect(missing).toEqual(expect.arrayContaining([
      expect.stringMatching(/Adresse complète/),
      expect.stringMatching(/Date d’acquisition/),
      expect.stringMatching(/Prix d’achat/),
      expect.stringMatching(/Aucun document/),
      expect.stringMatching(/entretien/),
      expect.stringMatching(/photo/),
    ]));
  });

  it('rien ne manque pour un bien complet', () => {
    const doc = { id: 1, isWebLink: false } as never;
    const missing = listMissingPreviewData(
      { ...base, includedDocuments: [doc] },
      {
        ...snap,
        address: '1 rue X',
        purchaseDate: '2020-01-01',
        purchasePriceCents: 100,
        photos: [{} as never],
        events: [{} as never],
        documents: [doc],
      } as never,
    );
    expect(missing).toEqual([]);
  });

  it('signale les documents présents mais non retenus par le modèle', () => {
    const doc = { id: 1, isWebLink: false } as never;
    const missing = listMissingPreviewData({ ...base, exportType: 'DOSSIER_VENTE', unqualifiedDocCount: 1 }, { ...snap, documents: [doc] } as never);
    expect(missing.some((m) => m.includes('ne correspond aux pièces'))).toBe(true);
    expect(missing.some((m) => m.includes('non qualifié'))).toBe(true);
  });
});

describe('previewFileName (EXP-012)', () => {
  it('PDF ou ZIP selon le type, nom assaini', () => {
    const d = new Date('2026-09-26T10:00:00Z');
    expect(previewFileName('Dossier été', 'DOSSIER_COMPLET', d)).toBe('apercu_Dossier_ete_20260926.pdf');
    expect(previewFileName('EXPORT_BRUT', 'EXPORT_BRUT', d)).toBe('apercu_EXPORT_BRUT_20260926.zip');
  });
});
